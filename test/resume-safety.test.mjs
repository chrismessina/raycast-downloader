/**
 * Resume safety, against a REAL Range-capable server and the REAL runner.
 *
 * The property under test cannot be established by inspecting a curl config:
 * what matters is the BYTES ON DISK at the end. A resumed transfer against a
 * server that honours Range exits 0 and reports 206 whatever the prefix was —
 * measured, an 8-byte garbage prefix produces `XXXXXXXX89ABCDEFGHIJ` where the
 * canonical body is `0123456789ABCDEFGHIJ`. So every assertion here compares
 * the finished file to the canonical body, never merely to "completed".
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startDownload } from "../dist/detach.js";
import { readStatus, isTerminal } from "../dist/status.js";
import { DownloadError } from "../dist/errors.js";
import {
  claimPath,
  parseValidators,
  markPartialUnsafe,
  readPartialState,
  resourceFingerprint,
  statePath,
  urlFingerprint,
  writePartialState,
} from "../dist/partial.js";

const BODY = "0123456789ABCDEFGHIJ";
const CONTAMINATED = "<html>moved</html>!!";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "resume-"));
}

/**
 * A server that honours `Range` — the dangerous case, not the forgiving one. A
 * server that ignored Range would make curl exit 33 and mask every bug here.
 */
async function withServer(run, { etag = '"v1"', body = BODY, onRange, onIfRange } = {}) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    const range = req.headers.range;
    const ifRange = req.headers["if-range"];
    if (range) onRange?.(range);
    if (ifRange !== undefined) onIfRange?.(ifRange);

    // A stale `If-Range` means the client's bytes belong to a different
    // representation: answer with the whole body, as RFC 9110 requires.
    if (range && (!ifRange || ifRange === etag)) {
      const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      const slice = body.slice(start);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
        "Content-Length": slice.length,
        ETag: etag,
      });
      res.end(slice);
      return;
    }

    // A transfer that stays live for as long as the test needs it, rather than
    // one that is merely slow — a 20-byte body finishes even at 1 byte/sec, and
    // a race against that is a flake waiting to happen.
    if (req.url === "/slow") {
      res.writeHead(200, { "Content-Length": 1_000_000, ETag: etag, "Accept-Ranges": "bytes" });
      const timer = setInterval(() => res.write("."), 100);
      res.on("close", () => clearInterval(timer));
      return;
    }

    res.writeHead(200, { "Content-Length": body.length, ETag: etag, "Accept-Ranges": "bytes" });
    res.end(body);
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
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

// `resume` OMITTED, so it defaults to true — the configuration a consumer gets
// without doing anything, and the one the corruption path relies on.
test("a partial marked unsafe is never resumed onto, with resume left at its default", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      writeFileSync(`${outputPath}.part`, CONTAMINATED);
      assert.equal(markPartialUnsafe(`${outputPath}.part`), true);

      const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir });
      const status = await waitForTerminal(ticket.id, dir);

      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), BODY, "the published file must be the canonical body ONLY");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial marked unsafe is never resumed onto, with resume: true explicit", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      writeFileSync(`${outputPath}.part`, CONTAMINATED);
      markPartialUnsafe(`${outputPath}.part`);

      const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir, resume: true });
      const status = await waitForTerminal(ticket.id, dir);

      assert.ok(status, "download did not reach a terminal state");
      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), BODY, "the published file must be the canonical body ONLY");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CONTROL. Not a test of this package: a test that the trap is still armed. If
// curl and this server ever stop producing the splice, every assertion above
// passes for the wrong reason.
test("CONTROL: curl itself splices a bad prefix, so the guard is what prevents it", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const out = join(dir, "raw.part");
      writeFileSync(out, "XXXXXXXX");
      const code = await new Promise((resolve) => {
        const c = spawn("curl", ["-sS", "-C", "-", "-o", out, `${base}/file`]);
        c.on("close", resolve);
      });
      assert.equal(code, 0, "curl must succeed — that is what makes this dangerous");
      assert.equal(
        readFileSync(out, "utf8"),
        "XXXXXXXX" + BODY.slice(8),
        "the server honours Range and curl appends blindly; nothing downstream can see it",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The feature must still work. A provenance rule that quietly disabled resume
// everywhere would pass every safety test in this file.
test("a partial this package wrote IS resumed, and only the missing bytes are fetched", async () => {
  const dir = tempDir();
  const ranges = [];
  try {
    const outputPath = join(dir, "out.bin");
    const partPath = `${outputPath}.part`;
    writeFileSync(partPath, BODY.slice(0, 8));

    await withServer(
      async (base) => {
        // Exactly what the runner records after a response: this URL, this ETag.
        writePartialState(partPath, { v: 1, urlHash: urlFingerprint(`${base}/file`), etag: '"v1"' });

        const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir, resume: true });
        const status = await waitForTerminal(ticket.id, dir);

        assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
        assert.equal(readFileSync(outputPath, "utf8"), BODY);
      },
      { onRange: (value) => ranges.push(value) },
    );

    assert.deepEqual(ranges, ["bytes=8-"], "a resume must ask for the REMAINDER, not the whole file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial recorded against a DIFFERENT url is not resumed onto", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      writeFileSync(`${outputPath}.part`, CONTAMINATED);
      // Provenance from some other download that used this path.
      writePartialState(`${outputPath}.part`, { v: 1, urlHash: "0".repeat(32) });

      const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir, resume: true });
      const status = await waitForTerminal(ticket.id, dir);

      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), BODY);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The case no marker covers: same URL, same path, but the resource itself
// changed underneath a partial that is otherwise perfectly legitimate. The
// state below MATCHES, so `mayResume` says yes and the request really is made
// — this test fails if `If-Range` generation is removed.
const CHANGED = "abcdefghijKLMNOPQRST";

test("a resource that changed under a valid partial does not splice", async () => {
  const dir = tempDir();
  const seenIfRange = [];
  try {
    const outputPath = join(dir, "out.bin");
    const partPath = `${outputPath}.part`;
    // Eight bytes of the OLD body, recorded against the OLD validator.
    writeFileSync(partPath, BODY.slice(0, 8));

    await withServer(
      async (base) => {
        writePartialState(partPath, {
          v: 1,
          urlHash: urlFingerprint(`${base}/file`),
          resourceHash: resourceFingerprint(`${base}/file`),
          etag: '"v1"',
        });

        const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir, resume: true });
        const status = await waitForTerminal(ticket.id, dir);

        assert.ok(status, "download did not reach a terminal state");
        const spliced = BODY.slice(0, 8) + CHANGED.slice(8);
        if (existsSync(outputPath)) {
          const published = readFileSync(outputPath, "utf8");
          assert.notEqual(published, spliced, "the old prefix must never be published with the new suffix");
          assert.equal(published, CHANGED, "a published file must be the CURRENT resource, whole");
        }
      },
      // The server now serves a different representation under a new ETag.
      { etag: '"v2"', body: CHANGED, onIfRange: (value) => seenIfRange.push(value) },
    );

    assert.deepEqual(seenIfRange, ['"v1"'], "the recorded validator must be sent, or nothing is being tested");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a caller cannot smuggle its own Range or If-Range past the resume guard", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      for (const header of ["Range", "if-range", "IF-RANGE"]) {
        await assert.rejects(
          startDownload({
            url: `${base}/file`,
            outputPath: join(dir, `out-${header}.bin`),
            statusDir: dir,
            headers: { [header]: "bytes=0-7" },
          }),
          (error) => {
            assert.ok(error instanceof DownloadError);
            assert.equal(error.code, "validation");
            assert.match(error.message, /managed by the downloader/);
            return true;
          },
          `${header} must be refused`,
        );
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a resume needs a validator even when the url matches exactly", async () => {
  const dir = tempDir();
  const ranges = [];
  try {
    const outputPath = join(dir, "out.bin");
    const partPath = `${outputPath}.part`;
    writeFileSync(partPath, "XXXXXXXX");

    await withServer(
      async (base) => {
        // Same URL, no ETag and no Last-Modified: nothing the server can check.
        writePartialState(partPath, {
          v: 1,
          urlHash: urlFingerprint(`${base}/file`),
          resourceHash: resourceFingerprint(`${base}/file`),
        });

        const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir, resume: true });
        const status = await waitForTerminal(ticket.id, dir);
        assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
        assert.equal(readFileSync(outputPath, "utf8"), BODY);
      },
      { onRange: (value) => ranges.push(value) },
    );

    assert.deepEqual(ranges, [], "unvalidatable bytes must not be resumed onto, same url or not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the unsafe marker survives a startup failure and is cleared only by a safe replacement", async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "out.bin");
    const partPath = `${outputPath}.part`;
    writeFileSync(partPath, CONTAMINATED);
    markPartialUnsafe(partPath);

    // A runner that cannot start at all: the path is claimed, the spawn fails,
    // and nothing gets as far as touching the partial.
    const realExecPath = process.execPath;
    process.execPath = join(dir, "no-such-node");
    try {
      await assert.rejects(
        startDownload({ url: "https://example.com/f.bin", outputPath, statusDir: dir, runnerPath: partPath }),
        (error) => error instanceof DownloadError,
      );
    } finally {
      process.execPath = realExecPath;
    }
    await new Promise((r) => setTimeout(r, 250));

    assert.equal(readPartialState(partPath)?.unsafe, true, "a failed start must not clear the marker");
    assert.equal(readFileSync(partPath, "utf8"), CONTAMINATED, "and must not touch the bytes");
    assert.equal(existsSync(claimPath(partPath)), false, "a failed start must not leave the path claimed");

    // Now let a real attempt replace it.
    await withServer(async (base) => {
      const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir });
      const status = await waitForTerminal(ticket.id, dir);
      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), BODY);
    });

    assert.equal(existsSync(statePath(partPath)), false, "a completed download leaves no state behind");
    assert.equal(existsSync(claimPath(partPath)), false, "nor a claim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second live attempt on the same outputPath is refused, not raced", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      // Slow enough that the first attempt is provably still running.
      const first = await startDownload({ url: `${base}/slow`, outputPath, statusDir: dir });
      // Wait for the runner to be genuinely transferring, not merely spawned.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && readStatus(first.id, dir)?.state !== "downloading") {
        await new Promise((r) => setTimeout(r, 50));
      }

      await assert.rejects(
        startDownload({ url: `${base}/file`, outputPath, statusDir: dir }),
        (error) => {
          assert.ok(error instanceof DownloadError);
          assert.equal(error.code, "conflict");
          assert.equal(error.retryable, false);
          assert.match(error.message, /already writing to/);
          return true;
        },
      );

      // And the refusal must not have disturbed the attempt that holds it.
      const status = readStatus(first.id, dir);
      assert.ok(status && !isTerminal(status.state), "the live attempt must be untouched");

      const { killDownload } = await import("../dist/detach.js");
      await killDownload(first, { statusDir: dir });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim left by a dead process is stolen rather than honoured forever", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      // pid 999999 does not exist; a claim like this is what a SIGKILLed runner
      // leaves behind, and honouring it would wedge the filename permanently.
      writeFileSync(claimPath(`${outputPath}.part`), JSON.stringify({ pid: 999999, startedAtMs: 1, id: "ghost" }));

      const ticket = await startDownload({ url: `${base}/file`, outputPath, statusDir: dir });
      const status = await waitForTerminal(ticket.id, dir);
      assert.equal(status.state, "completed", `error: ${JSON.stringify(status.error)}`);
      assert.equal(readFileSync(outputPath, "utf8"), BODY);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cancelled transfer records what its partial is, so the resume is checkable", async () => {
  const dir = tempDir();
  try {
    await withServer(async (base) => {
      const outputPath = join(dir, "out.bin");
      const partPath = `${outputPath}.part`;
      const { killDownload } = await import("../dist/detach.js");

      const ticket = await startDownload({ url: `${base}/slow`, outputPath, statusDir: dir });
      // Let curl get as far as response headers and a first byte.
      await new Promise((r) => setTimeout(r, 600));
      await killDownload(ticket, { statusDir: dir });

      const status = await waitForTerminal(ticket.id, dir);
      assert.ok(status, "cancel did not settle");
      const state = readPartialState(partPath);
      if (existsSync(partPath) && readFileSync(partPath, "utf8").length > 0) {
        assert.ok(state, "a retained partial must record its provenance");
        assert.equal(typeof state.urlHash, "string");
        assert.equal(state.etag, '"v1"', "the validator that makes If-Range possible must be captured");
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Against curl's own `--dump-header` output, which is the thing the parser has
// to match: the unit tests prove the RULE, this proves the FORMAT — that curl
// writes a status line per hop, spelled the way the boundary regex expects.
// Written as a direct curl run rather than a download, because the validator
// has to be read from the dump itself; a completed download clears its state,
// and racing a cancellation to inspect it would test the race, not the parser.
test("curl's real redirect dump does not leak the redirect's ETag to the final response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "validators-"));
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      // The redirect carries a validator; the response that serves the body
      // does not. Recording `"abc"` would send it as `If-Range` next time, get
      // a 200 back, and turn the resume into a full re-download.
      res.writeHead(302, { Location: "/final", ETag: '"abc"' });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Length": BODY.length, "Accept-Ranges": "bytes" });
    res.end(BODY);
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const dumpPath = join(dir, "headers.txt");
    const out = join(dir, "out.bin");
    const code = await new Promise((resolve) => {
      const c = spawn("curl", ["-sS", "--location", "--dump-header", dumpPath, "-o", out, `${base}/redirect`]);
      c.on("close", resolve);
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(out, "utf8"), BODY);

    const dump = readFileSync(dumpPath, "utf8");
    // The trap this guards: both blocks really are in one file.
    assert.match(dump, /"abc"/, "the redirect's ETag must be present in the dump, or nothing is being tested");
    assert.equal(dump.match(/^HTTP\//gim)?.length, 2, "curl must have written one status line per hop");

    assert.deepEqual(parseValidators(dump), {}, "the final response carried no validator, so neither may we");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The parser dropping a weak ETag only matters if the state file drops it too.
// It did not: the merge that writes the sidecar fell back to whatever validator
// was recorded before, so a weak ETag on this response resurrected a strong one
// from an earlier, unrelated response — and the next resume would send it as
// If-Range, get a 200, and lose the partial to exit 33.
test("a weak ETag does not inherit a stale strong one through the state file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weak-etag-"));
  const sockets = new Set();
  const server = createServer((req, res) => {
    // Weak validator, and a body that stays open so the transfer can be caught
    // mid-flight with its state still on disk. The first chunk is large enough
    // for curl to flush: a cancelled attempt whose `.part` is still empty keeps
    // nothing, so there would be no state here to inspect.
    res.writeHead(200, { "Content-Length": 1_000_000, ETag: 'W/"weak"', "Accept-Ranges": "bytes" });
    res.write(Buffer.alloc(65_536, "."));
    const timer = setInterval(() => res.write("."), 100);
    res.on("close", () => clearInterval(timer));
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  try {
    const outputPath = join(dir, "out.bin");
    const partPath = `${outputPath}.part`;
    // A strong validator left behind by some earlier attempt at this path.
    writePartialState(partPath, { v: 1, etag: '"stale-strong"' });

    const ticket = await startDownload({
      url: `http://127.0.0.1:${server.address().port}/file`,
      outputPath,
      statusDir: dir,
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && readStatus(ticket.id, dir)?.state !== "downloading") {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 400));

    const { killDownload } = await import("../dist/detach.js");
    await killDownload(ticket, { statusDir: dir });
    await waitForTerminal(ticket.id, dir);

    const state = readPartialState(partPath);
    assert.ok(state, "a retained partial must record its provenance");
    assert.equal(state.etag, undefined, "a weak ETag must not resurrect an older strong one");
    assert.equal("etag" in state, false, "and the key must be absent, not present-and-empty");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
