/**
 * End-to-end tests for the detached runner. These hit the real network and
 * spawn real processes — they prove the property the whole package exists for,
 * which no unit test can establish.
 *
 * Set SKIP_INTEGRATION=1 to skip (e.g. offline CI).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startDownload, killDownload, reconcile, runnerPath } from "../dist/detach.js";
import { readStatus, isAlive, isTerminal, processStartTimeMs } from "../dist/status.js";
import { DownloadError } from "../dist/errors.js";

const SKIP = process.env.SKIP_INTEGRATION === "1";

// ~4.4 MB, stable, range-capable, no auth.
const TEST_URL = "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz";
const TEST_BYTES = 4377468;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "detach-int-"));
}

async function waitFor(predicate, timeoutMs = 60_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

test("the runner is bundled and resolvable from __dirname", () => {
  assert.ok(existsSync(runnerPath()), `runner missing at ${runnerPath()}`);
});

test("downloads a file to completion and verifies its size", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "out.tgz");
    const ticket = await startDownload({ url: TEST_URL, outputPath, statusDir: dir, expectedBytes: TEST_BYTES });

    const final = await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && isTerminal(status.state) ? status : null;
    });

    assert.ok(final, "download did not reach a terminal state");
    assert.equal(final.state, "completed", `error: ${JSON.stringify(final.error)}`);
    assert.equal(statSync(outputPath).size, TEST_BYTES);
    assert.equal(existsSync(`${outputPath}.part`), false, ".part must be renamed away on success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports real progress — bytes, total, and a nonzero speed", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "progress.tgz");
    const ticket = await startDownload({ url: TEST_URL, outputPath, statusDir: dir, limitRateBytes: 300_000 });

    // A mid-flight sample carrying a real rate is what Fetch's parser never produces.
    const sample = await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && status.bytesDownloaded > 0 && status.speedBytesPerSec > 0 ? status : null;
    }, 30_000, 100);

    assert.ok(sample, "never observed a progress sample with a real speed");
    assert.ok(sample.totalBytes > 0, "totalBytes should come from the meter");
    assert.ok(sample.lastByteAt, "lastByteAt must advance while bytes move");

    await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && isTerminal(status.state);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SURVIVES the parent process exiting — the reason this package exists", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "orphan.tgz");
    // A short-lived Node process starts a download and exits immediately,
    // exactly as Raycast tears down a command on Escape.
    const script = `
      const { startDownload } = require(${JSON.stringify(join(process.cwd(), "dist/detach.js"))});
      startDownload({
        url: ${JSON.stringify(TEST_URL)},
        outputPath: ${JSON.stringify(outputPath)},
        statusDir: ${JSON.stringify(dir)},
        expectedBytes: ${TEST_BYTES},
      }).then((t) => { console.log(t.id); process.exit(0); });
    `;
    const scriptPath = join(dir, "parent.js");
    writeFileSync(scriptPath, script);

    const id = execFileSync(process.execPath, [scriptPath], { encoding: "utf8" }).trim();
    assert.ok(id, "parent did not report a download id");
    // The parent is now gone.

    const final = await waitFor(() => {
      const status = readStatus(id, dir);
      return status && isTerminal(status.state) ? status : null;
    });

    assert.ok(final, "orphaned download never finished");
    assert.equal(final.state, "completed", `error: ${JSON.stringify(final.error)}`);
    assert.equal(statSync(outputPath).size, TEST_BYTES, "orphaned download produced a complete file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killDownload cancels the whole process group and keeps the partial", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "cancelled.tgz");
    // Throttle so the transfer is still running when we cancel.
    const ticket = await startDownload({
      url: TEST_URL,
      outputPath,
      statusDir: dir,
      limitRateBytes: 200_000,
      stallSeconds: 3600,
    });

    await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && status.bytesDownloaded > 0;
    }, 30_000, 100);

    assert.equal(await killDownload(ticket, { statusDir: dir, graceMs: 500 }), true);

    const final = await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && isTerminal(status.state) ? status : null;
    }, 15_000);

    assert.ok(final, "cancelled download never settled");
    assert.equal(final.state, "cancelled");
    assert.equal(existsSync(outputPath), false, "a cancelled download must not publish a final file");
    // The partial is deliberately retained so a retry can resume.
    assert.ok(existsSync(final.partPath), ".part should be kept for resume");

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isAlive(final), false, "no process from the group should survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumes from a partial file instead of restarting", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "resumed.tgz");
    const partPath = `${outputPath}.part`;

    // Pre-seed a partial using the same bytes the server would have sent.
    execFileSync("curl", ["-sL", "-r", "0-999999", "-o", partPath, TEST_URL]);
    const seeded = statSync(partPath).size;
    assert.ok(seeded > 0 && seeded < TEST_BYTES, `unexpected seed size ${seeded}`);

    const ticket = await startDownload({
      url: TEST_URL,
      outputPath,
      statusDir: dir,
      expectedBytes: TEST_BYTES,
      resume: true,
    });

    const final = await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && isTerminal(status.state) ? status : null;
    });

    assert.ok(final, "resumed download never settled");
    assert.equal(final.state, "completed", `error: ${JSON.stringify(final.error)}`);
    assert.equal(statSync(outputPath).size, TEST_BYTES, "resumed file must be byte-complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 404 fails with a typed error rather than a truncated file", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "missing.bin");
    const ticket = await startDownload({
      url: "https://registry.npmjs.org/this-package-does-not-exist-xyzzy/-/nope-1.0.0.tgz",
      outputPath,
      statusDir: dir,
    });

    const final = await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && isTerminal(status.state) ? status : null;
    }, 30_000);

    assert.ok(final, "failed download never settled");
    assert.equal(final.state, "failed");
    assert.ok(final.error, "a failure must carry an error");
    assert.equal(existsSync(outputPath), false, "no final file on failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── reconcile (no network needed) ───────────────────────────────────────────

test("reconcile treats a dead runner in finalizing with a complete file as completed", () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "done.bin");
    writeFileSync(outputPath, "12345");

    const status = {
      schema: 1,
      id: "fin",
      pid: 999999, // dead
      startedAtMs: Date.now() - 10_000,
      state: "finalizing",
      filename: "done.bin",
      outputPath,
      partPath: `${outputPath}.part`,
      bytesDownloaded: 5,
      totalBytes: 5,
      startedAt: Date.now() - 10_000,
      heartbeatAt: Date.now() - 5_000,
    };

    // The bytes are on disk and correct; reporting failure would prompt a
    // pointless re-download of a file that is already complete.
    assert.equal(reconcile(status, dir).state, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deadStatus(dir, overrides = {}) {
  return {
    schema: 1,
    id: "dead",
    pid: 999999,
    startedAtMs: Date.now() - 10_000,
    state: "downloading",
    filename: "x.bin",
    outputPath: join(dir, "x.bin"),
    partPath: join(dir, "x.bin.part"),
    bytesDownloaded: 10,
    startedAt: Date.now() - 10_000,
    heartbeatAt: Date.now() - 5_000,
    ...overrides,
  };
}

test("reconcile fails a dead runner whose file never landed, and offers resume when a partial exists", () => {
  const dir = tempDir();
  try {
    const status = deadStatus(dir);
    // The partial must actually be on disk — the promise of resumability is
    // about this file, so a test that asserts the message without creating it
    // is asserting the wording, not the behaviour.
    writeFileSync(status.partPath, Buffer.alloc(10, 1));

    const result = reconcile(status, dir);
    assert.equal(result.state, "failed");
    assert.equal(result.error.code, "interrupted");
    assert.match(result.error.message, /resume/i, "should tell the user the partial was kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile reports a startup crash as runner_failed, not a resumable interruption", () => {
  const dir = tempDir();
  try {
    // The shape of a runner that died before transferring: no bytes, no partial
    // file, still sitting in its initial state. Observed in Raycast 2026-08-01
    // when the copied runner could not resolve its own imports.
    const status = deadStatus(dir, { state: "starting", bytesDownloaded: 0 });

    const result = reconcile(status, dir);
    assert.equal(result.state, "failed");
    assert.equal(result.error.code, "runner_failed");
    assert.doesNotMatch(
      result.error.message,
      /resume/i,
      "must not promise a resumable partial when nothing was written",
    );
    assert.match(result.error.message, /failed to start/i, "should name the phase that failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request that fails before its first byte leaves no empty .part behind", { skip: SKIP }, async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "gone.bin");
    const ticket = await startDownload({
      url: "https://registry.npmjs.org/this-package-does-not-exist-zzzz/-/nope-0.0.0.tgz",
      outputPath,
      statusDir: dir,
    });

    const final = await waitFor(() => {
      const status = readStatus(ticket.id, dir);
      return status && isTerminal(status.state) ? status : null;
    }, 30_000);

    assert.ok(final, "failed download never settled");
    assert.equal(final.state, "failed");
    // A 404, not a DNS or TLS failure that would pass every check below too.
    assert.equal(final.error?.httpStatus, 404);
    assert.equal(final.error?.code, "not_found");
    // curl creates the output file on open, so without cleanup a 404 deposits a
    // 0-byte `.part` in the user's Downloads folder that nothing will resume.
    assert.equal(existsSync(`${outputPath}.part`), false, "an empty .part must not be left behind");
    // …nor anything describing it. A `.state` beside a `.part` that no longer
    // exists is an orphan the user has no way to account for.
    for (const sidecar of [".state", ".claim", ".headers"]) {
      assert.equal(existsSync(`${outputPath}.part${sidecar}`), false, `an orphaned .part${sidecar} must not be left behind`);
    }
    assert.equal(existsSync(outputPath), false, "a failure must never publish a final file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner_failed is not retryable; interrupted is", () => {
  // The distinction has to survive into `retryable`, or a caller's retry loop
  // reproduces a startup crash indefinitely.
  assert.equal(new DownloadError("runner_failed", "x").retryable, false);
  assert.equal(new DownloadError("interrupted", "x").retryable, true);
});

test("reconcile leaves a live download untouched", () => {
  const dir = tempDir();
  try {
    const status = {
      schema: 1,
      id: "live",
      pid: process.pid,
      startedAtMs: processStartTimeMs(process.pid),
      state: "downloading",
      filename: "x.bin",
      outputPath: join(dir, "x.bin"),
      partPath: join(dir, "x.bin.part"),
      bytesDownloaded: 10,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    assert.equal(reconcile(status, dir).state, "downloading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
