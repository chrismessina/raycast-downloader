/**
 * What a terminal attempt leaves beside the output path, and what it says
 * about it.
 *
 * Hermetic: a local HTTP server stands in for the network. Every case here is
 * one where the old runner either left a sidecar with no `.part` to describe,
 * kept bytes that were not the file, or rewrote the provenance of bytes the
 * response never touched.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { killDownload, startDownload } from "../dist/detach.js";
import { readStatus, isTerminal } from "../dist/status.js";
import { readPartialState, urlFingerprint, writePartialState } from "../dist/partial.js";

const BODY = "0123456789";
const SIDECARS = ["", ".state", ".claim", ".headers"];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "partial-lifecycle-"));
}

async function withServer(run) {
  const server = createServer((req, res) => {
    switch (req.url) {
      // A signed URL that lapsed mid-resume: no validator on the refusal.
      case "/expired":
        res.writeHead(403);
        return res.end();
      // An unrequested 206 whose connection drops partway: curl exits non-zero.
      case "/truncated-partial":
        res.writeHead(206, { "Content-Range": "bytes 8-17/20", "Content-Length": 10, ETag: '"v1"' });
        res.write(BODY.slice(0, 4));
        setTimeout(() => res.socket.destroy(), 50);
        return;
      case "/unrequested-partial":
        res.writeHead(206, { "Content-Range": "bytes 8-11/20", "Content-Length": 4, ETag: '"v1"' });
        return res.end(BODY.slice(0, 4));
      case "/empty":
        res.writeHead(200, { "Content-Length": 0 });
        return res.end();
      // Ignores Range, and the resource changed: a full 200 of a NEW version
      // that happens to be exactly as long as the partial.
      case "/same-length-new-version":
        res.writeHead(200, { "Content-Length": BODY.length, ETag: '"v2"' });
        return res.end("ABCDEFGHIJ");
      // An unrequested 206 that flushes a real body, then holds the connection.
      case "/held-partial":
        res.writeHead(206, { "Content-Range": "bytes 8-65543/100000", "Content-Length": 65_536, ETag: '"v1"' });
        res.write(Buffer.alloc(32_768, "x"));
        return;
      // A NEW version's headers, then no body yet.
      case "/headers-then-wait":
        res.writeHead(200, { "Content-Length": 1000, ETag: '"v2"' });
        res.flushHeaders();
        return;
      // Never answers, so a cancel lands before any response exists.
      case "/hang":
        return;
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const terminal = (id, dir) => waitFor(() => {
  const status = readStatus(id, dir);
  return status && isTerminal(status.state) ? status : null;
});

function seedPartial(outputPath, url, bytes) {
  writeFileSync(`${outputPath}.part`, bytes);
  assert.ok(writePartialState(`${outputPath}.part`, { v: 1, urlHash: urlFingerprint(url), etag: '"v1"' }), "seed state");
}

function assertNothingLeftBehind(outputPath) {
  for (const suffix of SIDECARS) {
    assert.equal(existsSync(`${outputPath}.part${suffix}`), false, `.part${suffix} must not be left behind`);
  }
}

async function inDir(run) {
  const dir = tempDir();
  try {
    await withServer((base) => run(base, dir, join(dir, "file.bin")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a refused resume keeps the partial AND the validator that makes it resumable", () =>
  inDir(async (base, dir, outputPath) => {
    // The documented signed-URL recovery: fetch a fresh URL, resume onto these
    // bytes. Recording the 403's (absent) validator over them forfeits that.
    seedPartial(outputPath, `${base}/expired`, BODY.slice(0, 5));
    const ticket = await startDownload({ url: `${base}/expired`, outputPath, statusDir: dir, resume: true });
    const status = await terminal(ticket.id, dir);
    assert.equal(status?.state, "failed");
    assert.equal(status.error?.httpStatus, 403);
    assert.equal(status.error?.code, "forbidden");
    assert.equal(readFileSync(`${outputPath}.part`, "utf8"), BODY.slice(0, 5));
    assert.equal(readPartialState(`${outputPath}.part`)?.etag, '"v1"');
  }));

test("an unrequested 206 that drops mid-body leaves nothing to resume onto", () =>
  inDir(async (base, dir, outputPath) => {
    const ticket = await startDownload({ url: `${base}/truncated-partial`, outputPath, statusDir: dir });
    const status = await terminal(ticket.id, dir);
    assert.equal(status?.state, "failed");
    // The drop, reported with the 206 that preceded it — not some other failure.
    assert.equal(status.error?.httpStatus, 206);
    assert.equal(status.error?.code, "network", "a transport failure, not the clean-exit 206 rejection");
    assertNothingLeftBehind(outputPath);
  }));

test("with resume off, an unusable body is discarded, not rolled back to the old partial's length", () =>
  inDir(async (base, dir, outputPath) => {
    seedPartial(outputPath, `${base}/unrequested-partial`, "EIGHTBYT");
    const ticket = await startDownload({
      url: `${base}/unrequested-partial`,
      outputPath,
      statusDir: dir,
      resume: false,
    });
    const status = await terminal(ticket.id, dir);
    assert.equal(status?.state, "failed");
    assert.equal(status.error?.httpStatus, 206);
    assert.equal(status.error?.code, "integrity");
    assertNothingLeftBehind(outputPath);
  }));

for (const sizeCheck of ["strict", "advisory"]) {
  test(`an empty 200 fails and cleans up even with expectedBytes (${sizeCheck})`, () =>
    inDir(async (base, dir, outputPath) => {
      const ticket = await startDownload({
        url: `${base}/empty`,
        outputPath,
        statusDir: dir,
        expectedBytes: 100,
        sizeCheck,
      });
      const status = await terminal(ticket.id, dir);
      assert.equal(status?.state, "failed", "an empty file must never be published");
      assert.match(status.error?.message ?? "", /empty file/);
      assert.equal(existsSync(outputPath), false);
      assertNothingLeftBehind(outputPath);
    }));
}

test("cancelling before any response leaves no state behind", () =>
  inDir(async (base, dir, outputPath) => {
    const ticket = await startDownload({ url: `${base}/hang`, outputPath, statusDir: dir });
    assert.ok(await waitFor(() => readStatus(ticket.id, dir)?.state === "downloading", 10_000), "never started");
    assert.equal(await killDownload(ticket, { statusDir: dir, graceMs: 500 }), true);
    const status = await terminal(ticket.id, dir);
    assert.equal(status?.state, "cancelled");
    assertNothingLeftBehind(outputPath);
  }));

test("a resumed 200 curl calls 'already downloaded' is not published, and does not wedge", () =>
  inDir(async (base, dir, outputPath) => {
    // Measured, curl 8.7.1: `-C -` against a 200 whose length equals the offset
    // exits 0 and leaves the OLD bytes. Here they are a stale version.
    seedPartial(outputPath, `${base}/same-length-new-version`, BODY);
    const ticket = await startDownload({ url: `${base}/same-length-new-version`, outputPath, statusDir: dir });
    const status = await terminal(ticket.id, dir);
    assert.equal(status?.state, "failed", "stale bytes must not be published");
    assert.equal(existsSync(outputPath), false);
    assert.match(status.error?.message ?? "", /resum/i);
    assert.equal(status.error?.code, "network", "retryable, so the retry that starts over happens");
    // Retrying must start over, not resume onto the same bytes forever.
    assertNothingLeftBehind(outputPath);
  }));

test("when only curl dies, an unusable body it flushed is still discarded", { skip: process.platform === "win32" }, () =>
  inDir(async (base, dir, outputPath) => {
    const url = `${base}/held-partial`;
    const ticket = await startDownload({ url, outputPath, statusDir: dir });
    assert.ok(
      // On disk, not just counted by curl's meter: the cleanup is what is under test.
      await waitFor(() => existsSync(`${outputPath}.part`) && statSync(`${outputPath}.part`).size > 0, 10_000),
      "the unusable body never reached disk, so there is nothing to prove cleaned",
    );
    // The curl child alone, not the runner's group: no write-out, no SIGTERM handler.
    execFileSync("pkill", ["-KILL", "-P", String(readStatus(ticket.id, dir).pid), "curl"]);
    const status = await terminal(ticket.id, dir);
    // The runner itself was not signalled: a cancel would read "cancelled".
    assert.equal(status?.state, "failed");
    assertNothingLeftBehind(outputPath);
  }));

test("with resume off, a new response's validator is never recorded against the old bytes", () =>
  inDir(async (base, dir, outputPath) => {
    // A partial this download could have resumed, but the caller said not to.
    seedPartial(outputPath, `${base}/headers-then-wait`, "OLDBYTES");
    const ticket = await startDownload({ url: `${base}/headers-then-wait`, outputPath, statusDir: dir, resume: false });
    assert.ok(
      await waitFor(() => existsSync(`${outputPath}.part.headers`) && readStatus(ticket.id, dir)?.state === "downloading", 10_000),
      "headers never arrived",
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await killDownload(ticket, { statusDir: dir, graceMs: 500 }), true);
    await terminal(ticket.id, dir);
    // "v2" beside "OLDBYTES" is the splice: the next resume sends If-Range "v2"
    // and appends v2's suffix to v1's prefix.
    if (existsSync(`${outputPath}.part`)) {
      assert.notEqual(readFileSync(`${outputPath}.part`, "utf8"), "OLDBYTES", "old bytes kept under the new validator");
    }
    assertNothingLeftBehind(outputPath);
  }));
