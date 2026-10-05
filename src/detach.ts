/**
 * Launching and cancelling detached downloads.
 *
 * `startDownload` spawns the runner so it outlives the calling command.
 * Verified: a parent that calls `process.exit(0)` immediately after spawning
 * still sees the child complete a multi-megabyte transfer.
 *
 * Cancellation has to reach the curl grandchild, not just the runner — killing
 * the runner alone orphans curl, which keeps writing to a file nobody tracks.
 * The two platforms need different mechanisms for that:
 *
 *   POSIX   `detached: true` makes the runner a process-group leader, so
 *           `process.kill(-pid)` signals the whole group. The runner catches
 *           SIGTERM and records `cancelled` itself.
 *   Windows There are no process groups and a negative pid is invalid; also
 *           `detached` there means "new console window", which would flash a
 *           black box at the user. So the child is merely `unref()`d and
 *           cancellation goes through `taskkill /T`, which walks the tree.
 *           Nothing catchable is delivered, so `killDownload` records the
 *           terminal status on the runner's behalf.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { assertCallerHeaders, hasCurl } from "./curl";
import { DownloadError } from "./errors";
import {
  claimPartialPath,
  markPartialUnsafe,
  partialClaimHolder,
  releasePartialClaim,
  updatePartialClaim,
} from "./partial";
import {
  assertSafeId,
  isAlive,
  isTerminal,
  processStartTimeMs,
  readStatus,
  statusDir as defaultStatusDir,
  withStatusLock,
  writeStatus,
  type DownloadState,
  type DownloadStatus,
} from "./status";

export interface StartDownloadOptions {
  /** Stable identifier. Defaults to a random UUID. Reuse it to resume. */
  id?: string;
  url: string;
  /** Final destination. Bytes land in `<outputPath>.part` until verified. */
  outputPath: string;
  filename?: string;
  headers?: Record<string, string>;
  /** Known size, used for progress and to verify completeness. */
  expectedBytes?: number;
  /**
   * How to treat a size mismatch against `expectedBytes`.
   *
   * `"strict"` (default) fails the download. Correct when the size comes from
   * the same authority that minted the URL — an API response, say.
   *
   * `"advisory"` uses the size for progress but publishes the file anyway.
   * Correct when the size came from a separate `HEAD` request, which can
   * legitimately disagree with the `GET`: gzip transfer-encoding, a stale
   * `content-length`, or a server that serves different bodies to each verb.
   * Strict checking there would reject perfectly good downloads.
   */
  sizeCheck?: "strict" | "advisory";
  /** Continue from an existing partial file via HTTP Range. Default true. */
  resume?: boolean;
  /**
   * Follow HTTP redirects (curl `--location`). Default true.
   *
   * Turning it off is a real choice, not a no-op: an unfollowed 3xx is then a
   * FAILURE, because the body curl writes is the redirect stub, not the file.
   */
  followRedirects?: boolean;
  speedLimitBytes?: number;
  stallSeconds?: number;
  /** Cap transfer rate in bytes/sec. Actually slows the download. */
  limitRateBytes?: number;
  /** Opaque payload echoed into the status file. NEVER put a signed URL here. */
  meta?: Record<string, unknown>;
  statusDir?: string;
  /** Override the runner path (tests). Defaults to the sibling `runner.js`. */
  runnerPath?: string;
  /**
   * Post a desktop notification when the download finishes or fails.
   *
   * This exists because of the gap detaching creates: once the window closes,
   * the toast is gone, and a completed transfer has nothing left to report to.
   * The runner outlives the command, so it is the only thing that can speak.
   *
   * See `RunnerPayload.notifyOnFinish` in `runner.ts` for the delivery routes
   * and why `raycastDeeplink` is opt-in.
   */
  notifyOnFinish?: { title: string; enabled: boolean; raycastDeeplink?: boolean };
}

export interface DownloadTicket {
  id: string;
  pid: number;
  statusPath: string;
}

/**
 * Every location the runner might live, cheapest first.
 *
 * This is harder than it looks because the runner is an executable ARTIFACT,
 * not an importable module: it has to exist as a real file that `node` can be
 * pointed at, and a bundler has no reason to preserve such a thing.
 *
 * Observed in Raycast (2026-08-01): esbuild inlines this package into a single
 * `search-meetings.js`, so `__dirname` is the extension bundle directory and
 * `runner.js` is nowhere near it. Every download failed before it started.
 *
 * Finding the file turned out to be only half the problem. Once the search
 * below located a copied `dist/runner.js` in `assets/`, it still died instantly
 * with `Cannot find module './curl'` — a `tsc` output carries its siblings by
 * reference, so copying one file out of `dist` copies a broken program. Hence
 * `runner.bundle.js` (see scripts/bundle-runner.mjs), which inlines the local
 * graph and is the ONLY form safe to copy. It is preferred everywhere below;
 * the unbundled paths remain as fallbacks for in-place `node_modules` use,
 * where the siblings really are present.
 */
function runnerCandidates(): string[] {
  // Raycast ships an extension's `assets/` directory alongside the bundle and
  // exposes its real location — the only dependable anchor inside a bundled
  // extension, since `__dirname` is the bundle and `cwd` is not ours to assume.
  let assetsPath: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { environment } = require("@raycast/api") as { environment?: { assetsPath?: string } };
    assetsPath = environment?.assetsPath;
  } catch {
    // Outside a Raycast host (tests, the runner itself).
  }

  return [
    // Explicit override, for layouts nothing here anticipates.
    process.env.RAYCAST_DOWNLOADER_RUNNER,
    // Bundled Raycast extension that copies the runner into assets/ at build
    // time (see the `copy-runner` script in the consumer's package.json).
    // This is the copied-artifact case, so it must be the self-contained
    // bundle — a copied `runner.js` cannot resolve its siblings.
    assetsPath ? join(assetsPath, "raycast-downloader-runner.js") : undefined,
    // Normal `node_modules` install, and the package's own tests. Both forms
    // work in place; prefer the bundle so what runs matches what ships.
    join(__dirname, "runner.bundle.js"),
    join(__dirname, "runner.js"),
    // Bundled consumer whose dependencies still exist on disk.
    join(process.cwd(), "node_modules", "@chrismessina", "raycast-downloader", "dist", "runner.bundle.js"),
    join(process.cwd(), "node_modules", "@chrismessina", "raycast-downloader", "dist", "runner.js"),
    join(process.cwd(), "assets", "raycast-downloader-runner.js"),
    join(process.cwd(), "runner.bundle.js"),
    join(process.cwd(), "runner.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** Cached after first resolution — this runs on every download. */
let resolvedRunner: string | undefined;

/**
 * Absolute path to the runner, searching the locations above.
 *
 * Returns the conventional path when nothing is found, so the caller's error
 * names a concrete location rather than an empty string.
 */
export function runnerPath(): string {
  if (resolvedRunner && existsSync(resolvedRunner)) return resolvedRunner;

  for (const candidate of runnerCandidates()) {
    if (existsSync(candidate)) {
      resolvedRunner = candidate;
      return candidate;
    }
  }

  return join(__dirname, "runner.js");
}

/** The locations `runnerPath()` searched — for a diagnosable error message. */
export function runnerSearchPaths(): string[] {
  return runnerCandidates();
}

/**
 * Spawn a detached download. Resolves once the runner has written its first
 * status, so the caller can immediately watch a file that exists.
 */
export async function startDownload(options: StartDownloadOptions): Promise<DownloadTicket> {
  const {
    id = randomUUID(),
    url,
    outputPath,
    headers,
    expectedBytes,
    resume = true,
    followRedirects = true,
    speedLimitBytes,
    stallSeconds,
    limitRateBytes,
    sizeCheck = "strict",
    meta,
    statusDir = defaultStatusDir(),
    runnerPath: runnerOverride,
    notifyOnFinish,
  } = options;

  // Rejects an id that could escape statusDir via `join()`. Done before any
  // path is built from it.
  assertSafeId(id);

  // Before anything is claimed or spawned: a header that would defeat the
  // resume guard is a caller mistake, and a detached process reporting it
  // minutes later is a worse way to learn about it.
  assertCallerHeaders(headers);

  const filename = options.filename ?? outputPath.split("/").pop() ?? "download";
  const partPath = `${outputPath}.part`;
  const runner = runnerOverride ?? runnerPath();

  if (!existsSync(runner)) {
    // Name every location searched. The previous message gave only one path,
    // which made a bundling problem look like a missing file.
    throw new DownloadError(
      "validation",
      `Download runner not found. Looked in:\n${runnerSearchPaths()
        .map((p) => `  - ${p}`)
        .join("\n")}\n` +
        `If this extension is bundled, copy the package's dist/runner.bundle.js next to the bundle, ` +
        `or set RAYCAST_DOWNLOADER_RUNNER to its path.`,
    );
  }

  // Claim the PATH before anything is written to it, and before the runner that
  // will write to it is spawned.
  //
  // Ids do not protect a file. Two downloads with different ids can name one
  // `outputPath`, and the second one's `curl -C -` appends to the first one's
  // bytes — exit 0, HTTP 206, published. Leases and status locks are both
  // id-scoped, so neither of them sees this at all.
  //
  // Refused rather than serialized or renamed: a queued download looks hung,
  // and silently writing to a different filename than the caller asked for is
  // exactly the override this package refuses to do elsewhere. A caller that
  // wants a free name can get one from `uniquePath`.
  const claimToken = claimPartialPath(partPath, {
    pid: process.pid,
    startedAtMs: processStartTimeMs(process.pid) ?? Date.now(),
    id,
  });
  if (!claimToken) {
    const holder = partialClaimHolder(partPath);
    throw new DownloadError(
      "conflict",
      `Another download is already writing to ${outputPath}` +
        `${holder ? ` (process ${holder.pid}, download ${holder.id})` : ""}. ` +
        `Wait for it to finish, or choose a different destination.`,
    );
  }

  // A partial that a PREVIOUS version marked unsafe recorded it in its status
  // and nowhere else. Carry that forward to the file itself, so the runner —
  // which reads the path, not the id — refuses to resume onto it. Id-addressed,
  // not a scan: this is the status for the id the caller handed us.
  if (readStatus(id, statusDir)?.partialUnsafe) markPartialUnsafe(partPath);

  // Fail here rather than minutes later inside the runner: a missing binary is a
  // prerequisite the user can fix, not a transport error.
  if (!hasCurl()) {
    releasePartialClaim(partPath, claimToken);
    throw new DownloadError(
      "validation",
      "curl is required to download files but was not found on this system.",
    );
  }

  // The payload carries the URL and the caller's headers, both potentially
  // bearer credentials, so it travels through the runner's stdin: never argv,
  // which `ps` exposes to every process on the machine, and never a file, which
  // a runner that dies before reading it would leave behind in plain text.
  const payload = JSON.stringify({
    id,
    url,
    outputPath,
    partPath,
    filename,
    statusDir,
    headers,
    expectedBytes,
    resume,
    followRedirects,
    speedLimitBytes,
    stallSeconds,
    limitRateBytes,
    sizeCheck,
    claimToken,
    meta,
    notifyOnFinish,
  });

  const child = spawn(process.execPath, [runner], {
    // POSIX: makes the child a process-group leader so `kill(-pid)` reaches
    // curl too, and detaches it from the parent's session so it survives the
    // command being unloaded.
    //
    // Windows: `detached` instead means "open a new console window", which
    // would flash a black box at the user. `unref()` alone is what lets the
    // child outlive the parent there, and `taskkill /T` handles the tree.
    detached: process.platform !== "win32",
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  // `end` closes the pipe, which is how the runner knows it has the whole thing.
  // Settles once the last byte is in the kernel's pipe buffer, where it survives
  // this command exiting. A payload bigger than that buffer is only partly there
  // until the runner reads, so `startDownload` must not return before this: a
  // command unloaded with the tail still in Node's memory hands the runner half
  // a JSON document. A runner that dies first closes the pipe (EPIPE), which
  // settles it too; that runner reports through its status, or the spawn `error`
  // handler below does.
  const delivered = new Promise<void>((resolve) => {
    if (!child.stdin) return resolve();
    child.stdin.once("finish", resolve);
    child.stdin.once("error", () => resolve());
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.stdin?.end(payload);
  child.unref();

  // One shape for both statuses this function may write: the spawn-failure
  // below and the start-up seed further down. They differ in three fields and
  // agreed on a dozen, and a field added to `DownloadStatus` must not have to
  // be remembered twice — the half that gets forgotten is the failure path,
  // which nothing routinely exercises.
  const statusFor = (forPid: number, state: DownloadState, extra: Partial<DownloadStatus> = {}): DownloadStatus => {
    const now = Date.now();
    return {
      schema: 1,
      id,
      pid: forPid,
      startedAtMs: processStartTimeMs(forPid) ?? now,
      state,
      filename,
      outputPath,
      partPath,
      bytesDownloaded: 0,
      totalBytes: expectedBytes,
      startedAt: now,
      heartbeatAt: now,
      meta,
      ...extra,
    };
  };

  // Attached BEFORE `child.pid` is inspected, which is the whole point.
  //
  // `spawn` reports ENOENT, EACCES and EMFILE ASYNCHRONOUSLY, on the child's
  // `error` event, and an `error` event with no listener is thrown by
  // EventEmitter. Measured on Node 22: spawning a nonexistent executable
  // returns `pid === undefined` AND emits `error: ENOENT` a tick later — so
  // registering after the `pid === undefined` branch below means that branch
  // throws a clean DownloadError and the process then dies anyway on the
  // unhandled event, in the Raycast host rather than in the caller's `catch`.
  //
  // Reported through the status file when there is a pid to report it against:
  // the download the caller is already watching has to reach a terminal state,
  // and this is the only channel a watcher listens on. With no pid there is no
  // ticket, no watcher, and no valid status to write (readers require a
  // positive pid), so the throw below is the entire contract.
  let spawnFailed = false;
  child.on("error", (error: Error) => {
    spawnFailed = true;
    // The runner never ran, so nothing else will ever release this path. By
    // token, because this handler fires AFTER `startDownload` threw: the caller
    // may already have retried and taken a new claim, and releasing that one
    // would hand the path to a third attempt mid-transfer.
    releasePartialClaim(partPath, claimToken);
    const failedPid = child.pid;
    if (failedPid === undefined) return;
    try {
      writeStatus(
        statusFor(failedPid, "failed", {
          finishedAt: Date.now(),
          // `runner_failed`, deliberately not retryable: the helper could not be
          // started at all, and the environment that prevented it is unchanged
          // by trying again.
          error: { code: "runner_failed", message: `Could not start the download process: ${error.message}` },
        }),
        statusDir,
      );
    } catch {
      // A status write that fails leaves the watcher to time out on a missing
      // status, which is the pre-existing behaviour and still terminal.
    }
  });

  const pid = child.pid;
  if (pid === undefined) {
    releasePartialClaim(partPath, claimToken);
    throw new DownloadError("unknown", "Could not start the download process.");
  }

  // Hand the claim to the process that will actually hold it. Taken under this
  // command's identity because the claim has to exist BEFORE the spawn, but
  // this command exits in seconds and the runner runs for minutes — a claim
  // pointing at a dead parent reads as abandoned while the download is live.
  updatePartialClaim(partPath, { pid, startedAtMs: processStartTimeMs(pid) ?? Date.now(), id, token: claimToken });

  // Wait briefly for THIS attempt's first status write, so callers can watch a
  // file that already exists rather than racing it.
  //
  // Gated on the spawned pid, which is the whole point. Ids are reusable — that
  // is how a retry works — so on a retry the previous attempt's terminal status
  // is still sitting on disk when we get here. Accepting it meant
  // `startDownload` resolved immediately, and a watcher attached the moment it
  // resolved read the OLD failure and settled on it: the user pressed Retry and
  // was told, instantly, that it had failed again. The runner writes its own
  // pid into its first status, so requiring the pid to match is a precise test
  // for "this attempt, not the last one".
  await delivered;
  const seeded = await waitForStatus(id, statusDir, 3000, pid);
  // `spawnFailed` is checked because the seed would otherwise overwrite the
  // terminal failure the error handler just wrote with a `starting` status that
  // nothing will ever advance.
  if (!seeded && !spawnFailed) {
    // The runner may still be starting; seed a status so the download is
    // visible and cancellable rather than invisible until its first write.
    writeStatus(statusFor(pid, "starting"), statusDir);
  }

  return { id, pid, statusPath: join(statusDir, `${id}.json`) };
}

/**
 * Wait for a status file written by a specific process.
 *
 * `pid` is required rather than optional: every caller is waiting on an attempt
 * it just spawned, and the id alone cannot tell one attempt from another.
 */
async function waitForStatus(
  id: string,
  dir: string,
  timeoutMs: number,
  pid: number,
): Promise<DownloadStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus(id, dir);
    if (status && status.pid === pid) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export interface KillOptions {
  statusDir?: string;
  /** Escalate to SIGKILL if the group is still alive after this long. */
  graceMs?: number;
}

/**
 * Cancel a download by signalling its process group.
 *
 * Refuses to signal when the recorded `(pid, startTime)` no longer matches a
 * live process: macOS `kern.maxproc` is 16000, so a stale pid can belong to an
 * unrelated process, and killing its whole group would be a serious bug.
 *
 * Returns true when a signal was delivered.
 */
export async function killDownload(
  ticket: { id: string; pid?: number },
  options: KillOptions = {},
): Promise<boolean> {
  const { statusDir = defaultStatusDir(), graceMs = 2000 } = options;

  const status = readStatus(ticket.id, statusDir);
  if (!status) return false;
  // An id is reusable for Retry. A ticket names one spawned process, not every
  // future status that happens to share its id.
  if (ticket.pid !== undefined && ticket.pid !== status.pid) return false;

  // Identity check, not merely liveness.
  if (!isAlive(status)) {
    // Already gone: record the outcome so the UI stops showing it as running.
    if (!isTerminal(status.state)) {
      writeStatus({ ...status, state: "cancelled", finishedAt: Date.now() }, statusDir);
    }
    // And release the path it was holding. A runner that died without running
    // its signal handler — SIGKILL, or `taskkill /T`, which delivers nothing
    // catchable — leaves its claim behind, and the next attempt would have to
    // wait for the staleness check to find a dead owner. `force`, because the
    // holder is provably gone and this process never had its token.
    releasePartialClaim(status.partPath, undefined, true);
    return false;
  }

  // `isAlive` deliberately assumes ALIVE when identity cannot be proven —
  // reporting a running download as dead is the more damaging error there.
  //
  // Signalling inverts that trade: acting on an unproven identity could take an
  // unrelated process tree down with it if the pid was recycled. So killing
  // requires the STRONG check. Without it, stop tracking and say so rather than
  // guessing.
  if (processStartTimeMs(status.pid) === undefined) {
    writeStatus(
      {
        ...status,
        state: "cancelled",
        finishedAt: Date.now(),
        error: {
          code: "cancelled",
          message:
            "Stopped tracking this download — this system could not confirm which process owns it, so it was not force-stopped. It may still be running.",
        },
      },
      statusDir,
    );
    return false;
  }

  if (!terminateTree(status.pid, "SIGTERM")) return false;

  // Escalate only if it ignored the polite signal — and only if the process
  // still on record is the one we signalled.
  //
  // The grace period is long enough for a user to press Retry, which writes a
  // NEW attempt's status under the same id. Re-reading the file and killing
  // whatever pid it now names meant Cancel reached in and SIGKILLed the
  // replacement download the user had just started. So escalation is pinned to
  // the identity captured before the first signal, never to whatever the file
  // says afterwards.
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  const after = readStatus(ticket.id, statusDir);
  const sameAttempt =
    after !== null && after.pid === status.pid && after.startedAtMs === status.startedAtMs;
  if (after && sameAttempt && isAlive(after)) {
    terminateTree(after.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Make sure a terminal state actually got recorded.
  //
  // On POSIX the runner's SIGTERM handler writes `cancelled` itself. On Windows
  // `taskkill` terminates the tree without delivering a catchable signal, so
  // nothing in the runner ever runs — the status would sit at `downloading`
  // forever and a watcher would keep polling a download that no longer exists.
  //
  // Pinned to the original attempt for the same reason as the escalation above:
  // stamping `cancelled` onto a replacement attempt's status would report a
  // live download as cancelled.
  const settled = readStatus(ticket.id, statusDir);
  if (
    settled &&
    settled.pid === status.pid &&
    settled.startedAtMs === status.startedAtMs &&
    !isTerminal(settled.state) &&
    !isAlive(settled)
  ) {
    writeStatus({ ...settled, state: "cancelled", finishedAt: Date.now() }, statusDir);
    // Same reasoning as above: this is the Windows path, where the runner is
    // terminated without ever reaching its own cleanup.
    releasePartialClaim(status.partPath, undefined, true);
  }

  return true;
}

/**
 * Kill a runner and the curl child it spawned.
 *
 * POSIX: signal the process GROUP via a negative pid. `detached: true` made the
 * runner a group leader, so this reaches curl too — killing the bare pid would
 * orphan curl, which keeps writing to a file nobody is tracking.
 *
 * Windows: there are no process groups and negative pids are invalid, so this
 * delegates to `taskkill /T`, which walks the process tree instead.
 */
function terminateTree(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      const args = ["/PID", String(pid), "/T"];
      // /F is a forced kill; only escalate to it when SIGTERM's equivalent has
      // already been tried.
      if (signal === "SIGKILL") args.push("/F");
      execFileSync("taskkill", args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile a status whose runner is no longer alive.
 *
 * The important case is `finalizing`: the runner renamed the file into place and
 * died before recording completion. The bytes are on disk and correct, so
 * reporting a failure — and offering to re-download hundreds of megabytes —
 * would be wrong.
 */
export function reconcile(status: DownloadStatus, statusDir?: string): DownloadStatus {
  return withStatusLock(status.id, statusDir, () => reconcileLocked(status, statusDir));
}

function reconcileLocked(status: DownloadStatus, statusDir?: string): DownloadStatus {
  // The caller's snapshot predates this lock. A Retry can replace it before
  // reconciliation starts, in which case returning the current attempt is the
  // only truthful outcome and it must not be overwritten.
  const current = readStatus(status.id, statusDir);
  if (current && (current.pid !== status.pid || current.startedAtMs !== status.startedAtMs)) return current;
  const attempt = current ?? status;

  if (isTerminal(attempt.state)) return attempt;
  if (isAlive(attempt)) return attempt;

  const finalExists = existsSync(attempt.outputPath);
  const sizeMatches =
    finalExists &&
    (attempt.totalBytes === undefined || safeSize(attempt.outputPath) === attempt.totalBytes);

  const reconciled: DownloadStatus =
    attempt.state === "finalizing" && sizeMatches
      ? {
          ...attempt,
          state: "completed",
          finishedAt: attempt.finishedAt ?? Date.now(),
          bytesDownloaded: safeSize(attempt.outputPath),
        }
      : {
          ...attempt,
          state: "failed",
          finishedAt: attempt.finishedAt ?? Date.now(),
          error: attempt.error ?? describeAbandonment(attempt),
        };

  try {
    writeStatus(reconciled, statusDir);
  } catch {
    // Reporting the reconciled state matters more than persisting it.
  }
  return reconciled;
}

/**
 * Describe HOW an abandoned download died, using what is actually on disk.
 *
 * The previous single message claimed "The partial file was kept, so it can
 * resume" unconditionally. When the runner died before writing a byte — which
 * is exactly what a crash-on-startup looks like — that sentence was false in
 * both halves: nothing was kept and nothing can resume. It also read as a
 * transient network hiccup, so the natural response was to retry, which
 * reproduced the crash forever. A misleading error is worse than a vague one;
 * it aims the user away from the cause.
 *
 * The distinguishing signal is bytes-on-disk. A runner that never moved a byte
 * did not fail mid-transfer; it failed to start.
 */
function describeAbandonment(status: DownloadStatus): NonNullable<DownloadStatus["error"]> {
  const partialBytes = existsSync(status.partPath) ? safeSize(status.partPath) : 0;

  if (partialBytes > 0) {
    return {
      code: "interrupted",
      message: "The download stopped unexpectedly. The partial file was kept, so it can resume.",
    };
  }

  // No bytes and no partial: the transfer never got underway. Naming the phase
  // is what makes this diagnosable — the runner is a separate process, so its
  // startup failures (a missing module, an unusable output directory, no `node`)
  // leave no trace in the parent beyond this status.
  return {
    code: "runner_failed",
    message:
      "The download stopped before any data transferred, so the helper process most likely failed to start. " +
      "Nothing was written to disk.",
  };
}

function safeSize(path: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statSync } = require("node:fs") as typeof import("node:fs");
    return statSync(path).size;
  } catch {
    return 0;
  }
}
