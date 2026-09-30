/**
 * HTTP statuses curl exits 0 on that are NOT "here is the whole file".
 *
 * Hermetic: a local HTTP server stands in for the network. Each behavior here
 * was measured against curl first — `fail` does not cover any of them, because
 * none is a 4xx/5xx it fails on:
 *
 *  - 416 to a resumed request: curl exits 0 (it special-cases 416 when
 *    resuming) and leaves the partial untouched.
 *  - 202 / 204 / an unrequested 206: curl exits 0 and writes whatever body came.
 *
 * The 416 rule follows wget2 (`src/wget.c`, "The file is already fully
 * retrieved"): a 416 whose `Content-Range: bytes * /N` equals the bytes already
 * on disk means the partial IS the file.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startDownload } from "../dist/detach.js";
import { readStatus, isTerminal } from "../dist/status.js";
import { urlFingerprint, writePartialState } from "../dist/partial.js";

const BODY = "0123456789";
const SIDECARS = ["", ".state", ".claim", ".headers"];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "status-codes-"));
}

/** Every request the server saw, so a test can prove which path it took. */
const requests = [];

async function withServer(run) {
  requests.length = 0;
  const server = createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range, ifRange: req.headers["if-range"] });
    const ranged = Boolean(req.headers.range);
    switch (req.url) {
      // The partial already holds every byte: the range starts at the end.
      // Unranged is a 500, NOT the body: a fresh 200 must not be able to pass
      // the test that is about publishing from a 416.
      case "/complete":
        res.writeHead(ranged ? 416 : 500, ranged ? { "Content-Range": `bytes */${BODY.length}`, ETag: '"v1"' } : {});
        return res.end();
      // The resource is now SHORTER than the partial: those bytes are not it.
      case "/shrunk":
        res.writeHead(ranged ? 416 : 500, ranged ? { "Content-Range": "bytes */5", ETag: '"v1"' } : {});
        return res.end();
      case "/accepted":
        res.writeHead(202, { "Content-Type": "application/json" });
        return res.end('{"status":"processing"}');
      case "/no-content":
        res.writeHead(204);
        return res.end();
      case "/reset-content":
        res.writeHead(205);
        return res.end();
      // A 206 nobody asked for: five bytes of a ten-byte file.
      case "/unrequested-partial":
        res.writeHead(206, { "Content-Range": `bytes 0-4/${BODY.length}`, "Content-Length": 5 });
        return res.end(BODY.slice(0, 5));
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** Exactly one request, and it was the resume this test is about. */
function assertResumedOnce() {
  assert.deepEqual(
    requests.map(({ range, ifRange }) => ({ range, ifRange })),
    [{ range: `bytes=${BODY.length}-`, ifRange: '"v1"' }],
  );
}

async function waitForTerminal(id, dir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus(id, dir);
    if (status && isTerminal(status.state)) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Seed a partial the runner is willing to resume onto. */
function seedPartial(outputPath, url, bytes) {
  writeFileSync(`${outputPath}.part`, bytes);
  assert.ok(writePartialState(`${outputPath}.part`, { v: 1, urlHash: urlFingerprint(url), etag: '"v1"' }), "seed state");
}

function assertNothingLeftBehind(outputPath) {
  for (const suffix of SIDECARS) {
    assert.equal(existsSync(`${outputPath}.part${suffix}`), false, `.part${suffix} must not be left behind`);
  }
}

test("a 416 to a resume of an already-complete partial publishes it", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "file.bin");
      seedPartial(outputPath, `${base}/complete`, BODY);
      const ticket = await startDownload({ url: `${base}/complete`, outputPath, statusDir: dir, resume: true });
      const status = await waitForTerminal(ticket.id, dir);
      assert.equal(status?.state, "completed", `error: ${JSON.stringify(status?.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), BODY);
      assertResumedOnce();
      assertNothingLeftBehind(outputPath);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 416 whose total disagrees with the partial fails and clears it, so retries do not wedge", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "file.bin");
      seedPartial(outputPath, `${base}/shrunk`, BODY);
      const ticket = await startDownload({ url: `${base}/shrunk`, outputPath, statusDir: dir, resume: true });
      const status = await waitForTerminal(ticket.id, dir);
      assert.equal(status?.state, "failed");
      assert.equal(status.error?.httpStatus, 416);
      assertResumedOnce();
      assert.equal(existsSync(outputPath), false, "a failure must never publish a final file");
      assertNothingLeftBehind(outputPath);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [path, label, httpStatus, code] of [
  ["/accepted", "a 202 (body is a status message, not the file)", 202, "pending"],
  ["/no-content", "a 204", 204, "http_client"],
  ["/reset-content", "a 205", 205, "http_client"],
  ["/unrequested-partial", "a 206 to a request that asked for no range", 206, "integrity"],
]) {
  test(`${label} fails without publishing or leaving anything behind`, async () => {
    const dir = tempDir();
    try {
      await withServer(async (base) => {
        const outputPath = join(dir, "file.bin");
        const ticket = await startDownload({ url: `${base}${path}`, outputPath, statusDir: dir, resume: true });
        const status = await waitForTerminal(ticket.id, dir);
        assert.equal(status?.state, "failed", `expected failure, got ${status?.state}`);
        // The status, not just the outcome: a 204 also fails the empty-file
        // check, and that must not be what this test is passing on.
        assert.equal(status.error?.httpStatus, httpStatus);
        assert.equal(status.error?.code, code);
        assert.equal(existsSync(outputPath), false, "a failure must never publish a final file");
        assertNothingLeftBehind(outputPath);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
