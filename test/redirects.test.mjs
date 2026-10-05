/**
 * Redirect handling, end to end.
 *
 * Hermetic: a local HTTP server stands in for the network, so these run in
 * SKIP_INTEGRATION environments too.
 *
 * The property under test is that `followRedirects` reaches curl AND that an
 * unfollowed 3xx is a FAILURE. Before the fix, `followRedirects: false` never
 * left `startDownload`, so a 302 was followed anyway; and even with it plumbed,
 * the runner's success predicate accepted any 3xx and published the redirect
 * stub under the user's expected filename.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawn } from "node:child_process";

import { startDownload, runnerPath } from "../dist/detach.js";
import { readStatus, isTerminal } from "../dist/status.js";
import { DownloadError } from "../dist/errors.js";
import { buildCurlConfig } from "../dist/curl.js";
import { urlFingerprint, writePartialState } from "../dist/partial.js";

const FINAL_BODY = "REAL-PAYLOAD-BYTES";
const REDIRECT_BODY = "<html>moved</html>";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "redirect-"));
}

async function withServer(run) {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/final" });
      res.end(REDIRECT_BODY);
      return;
    }
    // A conditional request the server answers as "unchanged". curl follows
    // redirects here and STILL ends on a 3xx — `location` only follows a
    // response carrying a usable `Location`.
    if (req.url === "/not-modified") {
      res.writeHead(304, { ETag: '"v1"' });
      res.end();
      return;
    }
    // 300 Multiple Choices: a 3xx with a body and no `Location` to follow.
    if (req.url === "/multiple-choices") {
      res.writeHead(300, { "Content-Type": "text/html" });
      res.end(REDIRECT_BODY);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(FINAL_BODY);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
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

test("followRedirects: false makes an unfollowed 302 a failure, not a published stub", async () => {
  const dir = tempDir();
  try {
    const final = await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      const ticket = await startDownload({
        url: `${base}/redirect`,
        outputPath,
        statusDir: dir,
        followRedirects: false,
      });
      const status = await waitForTerminal(ticket.id, dir);
      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "failed", `expected failure, got ${status.state}`);
      assert.match(status.error.message, /redirect/i);
      assert.match(status.error.message, /302/);
      assert.equal(existsSync(outputPath), false, "a redirect stub must never be published");
      // The redirect body is not resumable content — keeping it would let a
      // later retry splice the real file onto the stub.
      assert.equal(existsSync(`${outputPath}.part`), false, "the redirect stub must not be retained");
      return status;
    });
    assert.equal(final.error.httpStatus, 302);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("followRedirects: true (default) follows the 302 to the final hop", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      const ticket = await startDownload({ url: `${base}/redirect`, outputPath, statusDir: dir });
      const status = await waitForTerminal(ticket.id, dir);
      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), FINAL_BODY);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The plumbing itself: startDownload must WRITE followRedirects into the runner
// payload. Without this the two tests above could pass off a default that
// happens to match. A stub runner captures the payload before the real one
// would unlink it.
test("startDownload writes followRedirects into the payload, and it yields a config with no `location`", async () => {
  const dir = tempDir();
  try {
    const capture = join(dir, "captured-payload.json");
    const stub = join(dir, "stub-runner.mjs");
    writeFileSync(
      stub,
      `import { readFileSync, writeFileSync } from "node:fs";\n` +
        `const payload = readFileSync(0, "utf8");\n` +
        `writeFileSync(${JSON.stringify(capture)}, payload);\n`,
    );

    await startDownload({
      url: "https://example.com/file.bin",
      outputPath: join(dir, "out.bin"),
      statusDir: dir,
      followRedirects: false,
      runnerPath: stub,
    });

    const payload = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(payload.followRedirects, false, "followRedirects must reach the runner payload");

    // And the runner's own construction of the config from that payload field.
    const config = buildCurlConfig({
      url: payload.url,
      outputPath: payload.partPath,
      followRedirects: payload.followRedirects,
    });
    assert.ok(!/^location$/m.test(config), "config must not enable redirects");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 304 with redirects ON fails AS a 304, not as a downstream rename error", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      const ticket = await startDownload({
        url: `${base}/not-modified`,
        outputPath,
        statusDir: dir,
        headers: { "If-None-Match": '"v1"' },
        // Advisory sizing deliberately does not enforce the expectation, so
        // nothing downstream rejects a 304. Measured before the fix: the
        // download failed on the rename with "ENOENT ... out.bin.part" —
        // failing, but for a reason that says nothing to the user.
        expectedBytes: 18,
        sizeCheck: "advisory",
      });
      const status = await waitForTerminal(ticket.id, dir);
      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "failed", `expected failure, got ${status.state}`);
      assert.equal(status.error.httpStatus, 304);
      assert.match(status.error.message, /unchanged/i);
      assert.equal(existsSync(outputPath), false, "a 304 must never publish a file");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 304 against a resumed transfer fails and leaves the resumable bytes intact", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      // Real progress from an earlier attempt, which a 304 says is still valid.
      // Recorded provenance included: an unidentifiable partial is reset before
      // it can be resumed onto, so without this the test would be exercising
      // that rule rather than the 304 behaviour it is about.
      writeFileSync(`${outputPath}.part`, "EXISTING");
      writePartialState(`${outputPath}.part`, {
        v: 1,
        urlHash: urlFingerprint(`${base}/not-modified`),
        // A validator is required for any resume — without one the partial is
        // reset before the 304 this test is about can even be reached.
        etag: '"v1"',
      });

      const ticket = await startDownload({
        url: `${base}/not-modified`,
        outputPath,
        statusDir: dir,
        resume: true,
        headers: { "If-None-Match": '"v1"' },
      });
      const status = await waitForTerminal(ticket.id, dir);
      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "failed", `expected failure, got ${status.state}`);
      assert.equal(existsSync(outputPath), false, "the partial must not be published as complete");
      assert.equal(readFileSync(`${outputPath}.part`, "utf8"), "EXISTING", "resumable bytes must survive");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 300 with redirects ON is a failure, not a published body", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      const ticket = await startDownload({ url: `${base}/multiple-choices`, outputPath, statusDir: dir });
      const status = await waitForTerminal(ticket.id, dir);
      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "failed", `expected failure, got ${status.state}`);
      assert.equal(status.error.httpStatus, 300);
      assert.equal(existsSync(outputPath), false);
      assert.equal(existsSync(`${outputPath}.part`), false, "the 300 body is not resumable content");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A payload written by 0.1.0 carries no `followRedirects` field at all. The
// runner must read that as "follow", not as "off" — otherwise upgrading the
// package mid-flight turns a healthy in-progress download into a failure.
test("a legacy payload with no followRedirects field still follows redirects", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      const payloadPath = join(dir, "legacy.payload.json");
      const id = "legacy-payload";
      writeFileSync(
        payloadPath,
        JSON.stringify({
          id,
          url: `${base}/redirect`,
          outputPath,
          partPath: `${outputPath}.part`,
          filename: "out.bin",
          statusDir: dir,
          resume: false,
        }),
        { mode: 0o600 },
      );

      const child = spawn(process.execPath, [runnerPath()], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(readFileSync(payloadPath));
      await new Promise((resolve) => child.on("close", resolve));

      const status = readStatus(id, dir);
      assert.ok(status, "runner wrote no status");
      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), FINAL_BODY);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// NOT tested end to end, deliberately: the `partialUnsafe` state needs curl to
// write a 3xx body into the partial and the filesystem to deny cleanup
// AFTERWARDS. Making the file untouchable up front does not produce it — curl
// opens the output for writing before the request, so it fails with exit 23 and
// http_code 0, which is not a 3xx and never reaches the rollback at all
// (measured). Reproducing it means racing a permission change mid-transfer.
// The two halves are covered separately instead: `rollbackPartial` returning
// false when every cleanup is denied (test/rollback.test.mjs), and the flag
// surviving the status write/read round trip (below).

test("readStatus never lets a malformed partialUnsafe read as safe", () => {
  const dir = tempDir();
  try {
    const base = {
      schema: 1,
      id: "shape",
      pid: 123,
      startedAtMs: 1,
      state: "failed",
      filename: "f",
      outputPath: "/tmp/f",
      partPath: "/tmp/f.part",
      bytesDownloaded: 0,
      heartbeatAt: 1,
      startedAt: 1,
    };
    const path = join(dir, "shape.json");

    // Coerced, not rejected: reading it as falsy would report a contaminated
    // partial as safe, and rejecting the whole status would make a live
    // download invisible and un-cancellable.
    writeFileSync(path, JSON.stringify({ ...base, partialUnsafe: "yes" }));
    assert.equal(readStatus("shape", dir).partialUnsafe, true, "a non-boolean must never read as a safe partial");

    writeFileSync(path, JSON.stringify({ ...base, partialUnsafe: true }));
    assert.equal(readStatus("shape", dir).partialUnsafe, true);

    writeFileSync(path, JSON.stringify(base));
    assert.equal(readStatus("shape", dir).partialUnsafe, undefined, "absence stays absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A spawn that fails asynchronously must not take the host down. `spawn`
// reports ENOENT on the child's `error` event, and an `error` event with no
// listener is thrown by EventEmitter — in the Raycast host, after
// `startDownload` has usually already resolved. Forced by pointing
// `process.execPath` at nothing, which is writable in this runtime.
test("a rejected spawn surfaces as a typed error, not an unhandled error event", async () => {
  const dir = tempDir();
  const realExecPath = process.execPath;
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    const stub = join(dir, "stub-runner.mjs");
    writeFileSync(stub, "");
    process.execPath = join(dir, "no-such-node");

    await assert.rejects(
      startDownload({
        url: "https://example.com/file.bin",
        outputPath: join(dir, "out.bin"),
        statusDir: dir,
        runnerPath: stub,
      }),
      (error) => error instanceof DownloadError,
    );

    // The event fires a tick after the throw; give it room to land.
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(uncaught, [], "the spawn error must be handled, not thrown at the host");
  } finally {
    process.execPath = realExecPath;
    process.off("uncaughtException", onUncaught);
    rmSync(dir, { recursive: true, force: true });
  }
});
