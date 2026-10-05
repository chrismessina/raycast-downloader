import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "reservation-"));
}

function runReservationProbe(dir, filename = "file.bin") {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `Date.now = () => 1700000000000; const { uniquePath } = await import(${JSON.stringify(
        new URL("../dist/paths.js", import.meta.url).href,
      )}); process.stdout.write(uniquePath(${JSON.stringify(dir)}, ${JSON.stringify(filename)}, { reserve: true, limit: 0 }));`,
    ],
    { encoding: "utf8" },
  );
}

test("reserved timestamp fallback atomically claims a distinct path", () => {
  const dir = tempDir();
  try {
    // limit: 0 leaves only the unnumbered candidate, which we occupy to force
    // the timestamp fallback. Freezing Date.now makes the former collision
    // deterministic instead of relying on two processes landing in one ms.
    writeFileSync(join(dir, "file.bin"), "taken");
    const first = runReservationProbe(dir);
    const second = runReservationProbe(dir);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(first.stdout, second.stdout, "each reservation must own a different fallback path");
    assert.ok(existsSync(`${first.stdout}.part`), "first fallback must have a reservation sidecar");
    assert.ok(existsSync(`${second.stdout}.part`), "second fallback must have a reservation sidecar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later allocation reaps an empty reservation beside an occupied final path", () => {
  const dir = tempDir();
  try {
    const occupied = join(dir, "finished.bin");
    writeFileSync(occupied, "completed");
    writeFileSync(`${occupied}.part`, "");

    // This constructed state is what remains if the post-acquisition collision
    // cleanup loses a transient unlink race. It does not attempt to provoke the
    // adjacent-syscall race itself.
    runReservationProbe(dir, "finished.bin");

    assert.ok(!existsSync(`${occupied}.part`), "an abandoned empty sidecar must self-heal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner releases an empty reservation when curl config validation fails", async () => {
  const dir = tempDir();
  try {
    const outputPath = join(dir, "invalid-url.bin");
    const partPath = `${outputPath}.part`;
    writeFileSync(partPath, "");
    const payloadPath = join(dir, "payload.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        id: "reservation-validation",
        url: "https://example.test/invalid\nurl",
        outputPath,
        partPath,
        filename: "invalid-url.bin",
        statusDir: dir,
      }),
    );

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/runner.bundle.js", import.meta.url))]);
      child.stdin.end(readFileSync(payloadPath));
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });

    assert.equal(result, 1);
    assert.ok(!existsSync(partPath), "a failed setup must not leave the reservation sidecar behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("advisory completion records the published size for crash reconciliation", async () => {
  const dir = tempDir();
  const body = Buffer.alloc(90, 7);
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const curlPath = join(binDir, "curl");
    writeFileSync(
      curlPath,
      `#!/usr/bin/env node\nconst fs=require("node:fs"); const config=fs.readFileSync(0, "utf8"); const output=/^output = "(.*)"$/m.exec(config)[1]; fs.writeFileSync(output, Buffer.alloc(90, 7));`,
    );
    chmodSync(curlPath, 0o755);
    const outputPath = join(dir, "advisory.bin");
    const payloadPath = join(dir, "payload.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        id: "advisory-size",
        url: "https://example.test/advisory.bin",
        outputPath,
        partPath: `${outputPath}.part`,
        filename: "advisory.bin",
        statusDir: dir,
        expectedBytes: 100,
        sizeCheck: "advisory",
      }),
    );

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/runner.bundle.js", import.meta.url))], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      });
      child.stdin.end(readFileSync(payloadPath));
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });

    assert.equal(result, 0);
    const status = JSON.parse(readFileSync(join(dir, "advisory-size.json"), "utf8"));
    assert.equal(status.state, "completed");
    assert.equal(status.totalBytes, body.length, "reconcile must compare against the size advisory mode actually published");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
