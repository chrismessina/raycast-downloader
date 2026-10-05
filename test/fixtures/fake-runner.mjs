/**
 * A runner that transfers nothing. It exists to answer one question: does
 * `startDownload` wait for THIS attempt's status, or accept whatever status
 * file happens to be sitting under the id already?
 *
 * stdin: the payload JSON, like the real runner.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const payload = JSON.parse(readFileSync(0, "utf8"));

const target = join(payload.statusDir, `${payload.id}.json`);
const delayMs = Number(process.env.FAKE_RUNNER_DELAY_MS ?? "800");

function put(state) {
  const now = Date.now();
  const status = {
    schema: 1,
    id: payload.id,
    pid: process.pid,
    startedAtMs: now,
    state,
    filename: payload.filename,
    outputPath: payload.outputPath,
    partPath: payload.partPath,
    bytesDownloaded: state === "completed" ? 10 : 5,
    totalBytes: 10,
    startedAt: now,
    heartbeatAt: now,
    ...(state === "completed" ? { finishedAt: now } : {}),
  };
  const tmp = `${target}.${process.pid}.fake.tmp`;
  writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  renameSync(tmp, target);
}

setTimeout(() => {
  put("downloading");
  setTimeout(() => put("completed"), 400);
}, delayMs);
