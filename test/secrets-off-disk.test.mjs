/**
 * A caller's URL and headers never reach the disk.
 *
 * They are bearer credentials: a signed URL, or `Authorization: Bearer <token>`
 * (raycast-mercury). The payload used to sit in `<statusDir>/<id>.payload.json`
 * until the runner read it, and curl's config in `<partPath>.curlrc` until curl's
 * first output byte. A runner killed inside either window left the secret behind
 * in plain text, in the user's Downloads folder for the second one.
 *
 * Both windows are held open for real rather than simulated: a slow Node start
 * (`NODE_OPTIONS=--require`) for the payload, and a `curl` on PATH that sleeps
 * before exec'ing the real one for the config. Each test scans every file the
 * package could write while the window is open.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startDownload } from "../dist/detach.js";
import { isTerminal, readStatus } from "../dist/status.js";

const SECRET = `s3cr3t-${process.pid}-${Date.now()}`;
const BODY = "0123456789".repeat(100);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "secrets-off-disk-"));
}

/** Every file under `dir` whose bytes contain the secret. Files that vanish mid-scan are skipped. */
function filesHoldingSecret(dir) {
  const hits = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        try {
          if (readFileSync(path).includes(SECRET)) hits.push(entry.name);
        } catch {
          // Unlinked between readdir and read.
        }
      }
    }
  };
  walk(dir);
  return hits;
}

/** Poll `dir` every 10ms until stopped, collecting every file name ever seen holding the secret. */
function watchForSecret(dir) {
  const seen = new Set();
  const timer = setInterval(() => {
    for (const name of filesHoldingSecret(dir)) seen.add(name);
  }, 10);
  return {
    stop() {
      clearInterval(timer);
      for (const name of filesHoldingSecret(dir)) seen.add(name);
      return [...seen];
    },
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

/** A server that records the secret header it received, so a test proves the header still arrives. */
async function withServer(run) {
  const received = [];
  const server = createServer((req, res) => {
    received.push(req.headers["x-secret"]);
    res.writeHead(200, { "Content-Length": BODY.length, ETag: '"v1"' });
    res.end(BODY);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/file.bin?sig=${SECRET}`, received);
  } finally {
    server.close();
  }
}

/** A `curl` that sleeps before becoming the real one: holds open the window before curl reads its config. */
function slowCurlDir(dir, seconds) {
  const real = execFileSync("/usr/bin/which", ["curl"], { encoding: "utf8" }).trim();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = join(bin, "curl");
  writeFileSync(script, `#!/bin/sh\nsleep ${seconds}\nexec "${real}" "$@"\n`);
  chmodSync(script, 0o755);
  return bin;
}

function withEnv(vars, run) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return run().finally(restore);
}

const posixOnly = { skip: process.platform === "win32" };

test("the payload never lands on disk, even while the runner is slow to start", posixOnly, async () => {
  const dir = tempDir();
  const slowInit = join(dir, "slow-init.cjs");
  writeFileSync(slowInit, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n");
  try {
    await withServer(async (url, received) => {
      const watch = watchForSecret(dir);
      await withEnv({ NODE_OPTIONS: `--require ${slowInit}` }, () =>
        startDownload({
          id: "payload-1",
          url,
          headers: { "X-Secret": SECRET },
          outputPath: join(dir, "file.bin"),
          statusDir: dir,
        }),
      );
      const final = await waitFor(() => {
        const status = readStatus("payload-1", dir);
        return status && isTerminal(status.state) ? status : undefined;
      }, 20_000);
      const leaked = watch.stop();

      assert.equal(final?.state, "completed", JSON.stringify(final?.error));
      assert.deepEqual(received, [SECRET], "the header must still reach the server");
      assert.deepEqual(leaked, [], `secret written to: ${leaked.join(", ")}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("curl's config never lands on disk, even while curl is slow to read it", posixOnly, async () => {
  const dir = tempDir();
  const bin = slowCurlDir(dir, 1);
  try {
    await withServer(async (url, received) => {
      const watch = watchForSecret(dir);
      await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
        await startDownload({
          id: "config-1",
          url,
          headers: { "X-Secret": SECRET },
          outputPath: join(dir, "file.bin"),
          statusDir: dir,
        });
      });
      const final = await waitFor(() => {
        const status = readStatus("config-1", dir);
        return status && isTerminal(status.state) ? status : undefined;
      }, 20_000);
      const leaked = watch.stop().filter((name) => name !== "curl");

      assert.equal(final?.state, "completed", JSON.stringify(final?.error));
      assert.deepEqual(received, [SECRET], "the header must still reach the server");
      assert.deepEqual(leaked, [], `secret written to: ${leaked.join(", ")}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runner killed before curl's first byte leaves no secret behind", posixOnly, async () => {
  // The TODO's "done when": SIGKILL gives the runner no chance to clean up, so
  // whatever it had written is still there afterwards.
  const dir = tempDir();
  const bin = slowCurlDir(dir, 3);
  try {
    await withServer(async (url) => {
      await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
        await startDownload({
          id: "killed-1",
          url,
          headers: { "X-Secret": SECRET },
          outputPath: join(dir, "file.bin"),
          statusDir: dir,
        });
      });
      // `downloading` is persisted right after curl is spawned, and curl is
      // still asleep: inside the window.
      const live = await waitFor(() => {
        const status = readStatus("killed-1", dir);
        return status?.state === "downloading" ? status : undefined;
      }, 10_000);
      assert.ok(live, "the runner never reported downloading");
      // The whole group: runner and the sleeping curl, no cleanup handlers.
      process.kill(-live.pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));

      const leaked = filesHoldingSecret(dir).filter((name) => name !== "curl");
      assert.deepEqual(leaked, [], `secret left in: ${leaked.join(", ")}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that exits as soon as startDownload returns still delivers a large payload", posixOnly, async () => {
  // startDownload falls back to a seeded status after 3s when the runner is slow
  // to start. A Raycast command unloaded right then must not truncate a payload
  // bigger than the pipe buffer: the runner would read half a JSON document and
  // exit without a status. `meta` carries the bulk, since a server rejects
  // headers this large.
  const dir = tempDir();
  const slowInit = join(dir, "slow-init.cjs");
  writeFileSync(slowInit, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);\n");
  const parent = join(dir, "parent.mjs");
  const detach = new URL("../dist/detach.js", import.meta.url).href;
  writeFileSync(
    parent,
    `import { startDownload } from ${JSON.stringify(detach)};\n` +
      `const [url, dir] = process.argv.slice(2);\n` +
      `await startDownload({ id: "big-1", url, outputPath: dir + "/file.bin", statusDir: dir, meta: { pad: "x".repeat(300000) } });\n` +
      `process.exit(0);\n`,
  );
  try {
    await withServer(async (url) => {
      const { spawn } = await import("node:child_process");
      // NODE_OPTIONS is inherited by the runner the helper spawns, not by the helper's own start.
      const helper = spawn(process.execPath, [parent, url, dir], {
        env: { ...process.env, NODE_OPTIONS: `--require ${slowInit}` },
        stdio: "ignore",
      });
      await new Promise((r) => helper.on("close", r));
      const final = await waitFor(() => {
        const status = readStatus("big-1", dir);
        return status && isTerminal(status.state) ? status : undefined;
      }, 20_000);
      assert.equal(final?.state, "completed", `state: ${readStatus("big-1", dir)?.state}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
