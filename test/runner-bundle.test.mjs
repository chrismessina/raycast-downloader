/**
 * The runner has to work as a COPIED file.
 *
 * Every consumer ships it by copying it out of `dist` into somewhere else — an
 * extension's `assets/` directory — because a bundler will not preserve an
 * executable artifact it has no reason to keep. So the property that matters is
 * not "the runner works", it is "the runner works with no siblings next to it".
 *
 * That distinction is the whole bug (2026-08-01): `dist/runner.js` passed every
 * test, was found correctly by `runnerPath()`, and still died on its first line
 * with `Cannot find module './curl'` the moment it was copied, because a `tsc`
 * output references its siblings by relative path. The parent could only report
 * "runner vanished without recording an outcome" — the runner never lived long
 * enough to write why.
 *
 * These tests run the shipped artifact from an empty temp directory, which is
 * the only arrangement that can tell the two properties apart.
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "dist", "runner.bundle.js");

function isolatedCopy() {
  const dir = mkdtempSync(join(tmpdir(), "runner-bundle-"));
  const dest = join(dir, "raycast-downloader-runner.js");
  copyFileSync(bundle, dest);
  return { dir, dest };
}

test("the bundle is built by `npm run build`", () => {
  assert.ok(
    existsSync(bundle),
    "dist/runner.bundle.js is missing — the build must produce it, since this is the file consumers copy.",
  );
});

test("the bundle has no relative requires left to resolve", () => {
  const source = readFileSync(bundle, "utf8");
  const leftovers = [...source.matchAll(/require\((["'])(\.[^"']*)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(
    leftovers,
    [],
    `Unbundled relative require(s) survived: ${leftovers.join(", ")}. Copied anywhere, these throw MODULE_NOT_FOUND.`,
  );
});

test("the bundle loads when copied away from its siblings", () => {
  const { dir, dest } = isolatedCopy();
  try {
    // No payload argument: the runner should exit on its own terms, having
    // successfully loaded every module it needs. A module-resolution failure
    // shows up here as a MODULE_NOT_FOUND on stderr.
    const result = spawnSync(process.execPath, [dest], { encoding: "utf8" });
    assert.doesNotMatch(
      result.stderr ?? "",
      /Cannot find module|MODULE_NOT_FOUND/,
      `The copied runner could not resolve its own imports:\n${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the copied bundle downloads a file end to end", { skip: !!process.env.SKIP_INTEGRATION }, async () => {
  const { dir, dest } = isolatedCopy();
  // A loopback server rather than a file:// URL: the runner asks curl for
  // Range/resume and throughput limits, which the file: handler does not
  // implement. Serving over HTTP exercises the code path consumers actually
  // take while staying entirely on this machine.
  const payloadBytes = Buffer.alloc(64 * 1024, 7);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payloadBytes.length });
    res.end(payloadBytes);
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    const outputPath = join(dir, "out.bin");
    const payloadPath = join(dir, "payload.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        id: "bundle-e2e",
        url: `http://127.0.0.1:${port}/out.bin`,
        outputPath,
        partPath: `${outputPath}.part`,
        filename: "out.bin",
        statusDir: dir,
        resume: false,
        sizeCheck: "lenient",
        meta: {},
      }),
    );

    // Spawn asynchronously and await exit. `execFileSync` would deadlock: it
    // blocks this thread's event loop, which is the same loop the server needs
    // in order to answer curl's request.
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [dest], { stdio: "pipe" });
      child.stdin.end(readFileSync(payloadPath));
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`Runner exited ${code}: ${stderr}`));
        else resolve(code);
      });
    });
    assert.equal(exitCode, 0);

    const status = JSON.parse(readFileSync(join(dir, "bundle-e2e.json"), "utf8"));
    assert.equal(status.state, "completed", `Expected completion, got ${status.state}: ${JSON.stringify(status.error)}`);
    assert.ok(existsSync(outputPath), "The final file was never renamed into place.");
    assert.ok(!existsSync(`${outputPath}.part`), "The .part file was left behind after a successful download.");
    assert.deepEqual(readFileSync(outputPath), payloadBytes, "The downloaded bytes do not match the source.");
  } finally {
    // `close()` alone waits on curl's keep-alive socket and hangs the process
    // long after the assertions have passed.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
