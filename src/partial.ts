/**
 * What is known about a `.part` file, bound to the PATH rather than to a
 * download id.
 *
 * Everything else in this package is addressed by id: statuses, locks, leases.
 * That is correct for reporting an attempt and wrong for protecting a file,
 * because the file is shared. Several ids can name one `outputPath`, a retry
 * routinely uses a new id, and a consumer can point an unrelated download at a
 * path a previous one left bytes in. An id-keyed record cannot answer the only
 * question that matters here — "may I append to THIS file?" — without scanning
 * every status on disk and hoping none was pruned.
 *
 * So the answer lives beside the file, in two sidecars with different lifetimes:
 *
 *   `<partPath>.state`  durable. Survives attempts, and is what makes a
 *                       contaminated partial refuse to be resumed onto by an
 *                       attempt that knows nothing about the one that spoiled
 *                       it. Removed only when the partial is verifiably gone or
 *                       has been replaced.
 *   `<partPath>.claim`  ephemeral. Says an attempt is live against this path
 *                       right now, and is how a second one is refused instead
 *                       of racing it. Created with `wx`, so the claim is the
 *                       filesystem's answer rather than ours.
 *
 * Measured, and the reason this module exists (curl 8.7.1, local server):
 * seeding an 8-byte partial with garbage and resuming against a Range-capable
 * server exits 0, reports 206, and produces `XXXXXXXX89ABCDEFGHIJ` where the
 * canonical body is `0123456789ABCDEFGHIJ`. curl cannot detect it — a range
 * request is a promise that the prefix is already correct. Only the side that
 * wrote the prefix can keep that promise.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

import { writeSecretFile } from "./paths";
import { processStartTimeMs } from "./status";

/** Durable facts about the bytes currently in a `.part` file. */
export interface PartialState {
  v: 1;
  /**
   * The bytes cannot be vouched for: an attempt wrote something into them that
   * does not belong to the download and could not take it back out. Resuming
   * appends the real file to that, and the result is published under the user's
   * filename.
   */
  unsafe?: true;
  /** Fingerprint of the exact URL these bytes came from. */
  urlHash?: string;
  /**
   * Fingerprint of origin + path only, with the query dropped.
   *
   * Exists because a signed URL is not stable. The documented recovery from an
   * expired link is to re-request a fresh one and resume onto the partial
   * already on disk — and a fresh signature is a different URL, so matching on
   * the whole URL would restart every signed download from zero and quietly
   * undo the feature it was protecting.
   */
  resourceHash?: string;
  /** `ETag` from the response that produced these bytes, when it was a strong one. */
  etag?: string;
  /** `Last-Modified`, used as the `If-Range` validator when there is no strong ETag. */
  lastModified?: string;
}

export interface PartialClaim {
  pid: number;
  startedAtMs: number;
  id: string;
  /**
   * Who holds this claim, as a value only the holder knows.
   *
   * Without it every release is "unlink whatever is at this path", and a
   * late-firing handler from a failed attempt deletes the claim a RETRY has
   * since taken — handing the path to a third attempt while the second is
   * mid-transfer. The token makes release mean "release MINE".
   */
  token: string;
}

export function statePath(partPath: string): string {
  return `${partPath}.state`;
}

export function claimPath(partPath: string): string {
  return `${partPath}.claim`;
}

/** Header dump for the in-flight attempt. Transient; removed when it is parsed. */
export function headerPath(partPath: string): string {
  return `${partPath}.headers`;
}

/**
 * A URL reduced to something safe to leave on disk.
 *
 * Hashed rather than stored: a signed URL is a bearer credential, and this file
 * sits in the user's Downloads folder next to the partial. The hash answers the
 * only question asked of it — "is this the same URL as last time?" — and
 * answers nothing else.
 */
export function urlFingerprint(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/**
 * Identity of the RESOURCE a URL names, ignoring the query string.
 *
 * Two signed URLs for one file differ only in their signature parameters, so
 * dropping the query is what lets a re-signed link resume. It is deliberately
 * the weaker test: an API that selects the resource with a query parameter
 * (`?file=123`) produces one fingerprint for two different files, which is why
 * a resume on a resource match alone is not permitted — see `mayResume`.
 */
export function resourceFingerprint(url: string): string {
  try {
    const parsed = new URL(url);
    return createHash("sha256").update(`${parsed.origin}${parsed.pathname}`).digest("hex").slice(0, 32);
  } catch {
    // Not a parseable URL: fall back to the whole string, which is strictly
    // safer — it can only refuse a resume, never permit a wrong one.
    return urlFingerprint(url);
  }
}

/**
 * May the bytes described by `state` be appended to, for a request to `url`?
 *
 * Three cases, and only the first two are yes:
 *
 *  - the exact URL matches: the same request produced these bytes;
 *  - the RESOURCE matches and a validator was recorded: probably a re-signed
 *    link, and if it is not, `If-Range` makes the server answer 200 and curl
 *    refuse (exit 33) rather than splice. The validator is what makes the
 *    weaker identity test safe, so it is required rather than nice to have;
 *  - anything else, including a partial with nothing recorded about it.
 */
export function mayResume(state: PartialState | undefined, url: string): boolean {
  if (!state || state.unsafe) return false;

  // A validator is required for EVERY resume, including one where the URL is
  // byte-for-byte the same. A stable URL is not a stable resource — a
  // `latest.zip`, a regenerated export, a redirect that now points somewhere
  // else — and the identity recorded here is of the REQUEST url, while the
  // bytes came from whatever the final hop served. `If-Range` is the only part
  // of this that the server participates in, and without it a changed
  // representation comes back 206 and splices silently.
  //
  // The cost is real: a server that sends neither `ETag` nor `Last-Modified`
  // cannot be resumed at all, and restarts instead. Both are near-universal on
  // static object storage, which is what signed download links serve.
  if (!(state.etag ?? state.lastModified)) return false;

  if (state.urlHash && state.urlHash === urlFingerprint(url)) return true;
  return Boolean(state.resourceHash) && state.resourceHash === resourceFingerprint(url);
}

export function readPartialState(partPath: string): PartialState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(statePath(partPath), "utf8")) as PartialState;
    if (parsed?.v !== 1) return undefined;
    // A malformed `unsafe` reads as unsafe, never as safe: the whole point of
    // the field is that being wrong in the other direction corrupts a file.
    if (parsed.unsafe !== undefined && parsed.unsafe !== true) return { ...parsed, unsafe: true };
    return parsed;
  } catch {
    // Absent, unreadable, or corrupt. Absence is NOT proof of safety — it is
    // the normal state for a partial written by an older version — so callers
    // treat it as "nothing recorded", not as "verified clean".
    return undefined;
  }
}

/**
 * Replace the durable state for a partial.
 *
 * Written through a temporary file and renamed, because a reader that catches
 * this file half-written gets `undefined` from `readPartialState` — which reads
 * as "nothing recorded" and permits the resume this file exists to forbid.
 */
export function writePartialState(partPath: string, state: PartialState): boolean {
  const target = statePath(partPath);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeSecretFile(temp, JSON.stringify(state));
    renameSync(temp, target);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Best effort.
    }
    return false;
  }
}

/**
 * Record that the bytes in this partial must never be resumed onto.
 *
 * Merges rather than replaces: the validators already recorded stay useful for
 * the attempt that eventually replaces the file. Returns false when the marker
 * could not be persisted, which is a worse failure than it looks — the caller
 * then has a contaminated file that nothing on disk warns about, and must say
 * so in the status instead.
 *
 * On that failure the existing state is removed: it vouches for the bytes as
 * they WERE, and with no state at all `mayResume` refuses. A full disk refuses
 * the write but still allows the unlink.
 */
export function markPartialUnsafe(partPath: string): boolean {
  const existing = readPartialState(partPath) ?? { v: 1 as const };
  if (writePartialState(partPath, { ...existing, unsafe: true })) return true;
  clearPartialState(partPath);
  return false;
}

export function clearPartialState(partPath: string): void {
  try {
    unlinkSync(statePath(partPath));
  } catch {
    // Already gone, or never written.
  }
}

/**
 * Make a partial safe to start over from, and forget everything known about it.
 *
 * Truncation rather than deletion, deliberately: the empty `.part` is also the
 * RESERVATION on the final filename (`uniquePath({reserve: true})`), and
 * deleting it hands that name to the next caller while this download is still
 * going to use it. Falls back to deletion when truncation is refused, since a
 * lost reservation beats contaminated bytes.
 *
 * Returns false when the bytes are still there afterwards.
 */
export function resetPartial(partPath: string): boolean {
  let fd: number | undefined;
  try {
    // Bound to ONE descriptor, like `rollbackPartial`: doing this by pathname
    // across stat / truncate / re-stat lets another attempt replace the file
    // mid-sequence, and the reset then lands on somebody else's healthy partial.
    fd = openSync(partPath, "r+");
    if (!fstatSync(fd).isFile()) return false;
    ftruncateSync(fd, 0);
    if (fstatSync(fd).size !== 0) return false;
    clearPartialState(partPath);
    return true;
  } catch {
    // Fall through to deletion.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }

  try {
    unlinkSync(partPath);
    clearPartialState(partPath);
    // Re-take the reservation the unlink just gave up. Between the two,
    // `uniquePath({reserve: true})` in another process can hand this filename
    // to someone else — while this download still intends to publish to it.
    // Best effort: failing to re-create is not a reason to refuse a download
    // that is now safe to run.
    try {
      closeSync(openSync(partPath, "wx", 0o600));
    } catch {
      // Someone else already took it, or the directory is unwritable.
    }
    return true;
  } catch {
    return !existsSync(partPath);
  }
}

/**
 * Claim this path for one live attempt, or report who holds it.
 *
 * `openSync(path, "wx")` is the whole mechanism: the filesystem decides, once,
 * which of two simultaneous callers wins. Anything built on "read, then decide,
 * then write" loses to the other process between the read and the write, which
 * is the case this is here to prevent.
 *
 * A claim whose owner is dead is STOLEN rather than honoured. A runner killed
 * mid-transfer leaves its claim behind, and a claim that outlives its owner
 * would wedge that filename until someone deleted a file they have no reason to
 * know about.
 */
export function claimPartialPath(partPath: string, owner: Omit<PartialClaim, "token">): string | undefined {
  const path = claimPath(partPath);
  const claim: PartialClaim = { ...owner, token: randomUUID() };
  if (tryCreateClaim(path, claim)) return claim.token;

  const held = readClaim(path);
  // A claim that cannot be read or identified is NOT treated as abandoned: with
  // atomic creation above, an unreadable claim means the file is damaged rather
  // than half-written, and stealing on that basis is how two runners end up
  // appending to one file. A refused download is recoverable; a spliced one is
  // not. `releasePartialClaim(force)` is the way out for a caller that knows
  // better.
  if (!held || claimOwnerAlive(held)) return undefined;

  try {
    unlinkSync(path);
  } catch {
    // Someone else got there first; the create below decides between us.
  }
  return tryCreateClaim(path, claim) ? claim.token : undefined;
}

/**
 * Re-point a claim at the runner once it has a pid of its own.
 *
 * Refuses to write over a claim that is no longer ours: between taking it and
 * updating it, a stale-steal by another process can have replaced it, and
 * overwriting that would take a path a live attempt now owns.
 */
export function updatePartialClaim(partPath: string, owner: PartialClaim): void {
  const path = claimPath(partPath);
  const held = readClaim(path);
  if (held?.token !== owner.token) return;
  try {
    writeSecretFile(path, JSON.stringify(owner));
  } catch {
    // The claim stays as taken; a later staleness check then falls back to the
    // spawning process's identity, which is strictly more conservative.
  }
}

/**
 * Release a claim this caller holds.
 *
 * `token` is checked against what is on disk, because the release can arrive
 * late: a spawn `error` event fires after `startDownload` has thrown, by which
 * time the caller may have retried and taken a NEW claim. Deleting that one
 * hands the path to a third attempt while the second is still writing.
 *
 * `force` exists for `killDownload`, which has just terminated the holder and
 * is cleaning up on its behalf.
 */
export function releasePartialClaim(partPath: string, token?: string, force = false): void {
  const path = claimPath(partPath);
  if (!force) {
    const held = readClaim(path);
    if (!held || (token !== undefined && held.token !== token)) return;
  }
  try {
    unlinkSync(path);
  } catch {
    // Already released.
  }
}

/** Who holds this path right now, if anyone alive does. */
export function partialClaimHolder(partPath: string): PartialClaim | undefined {
  const held = readClaim(claimPath(partPath));
  return held && claimOwnerAlive(held) ? held : undefined;
}

/**
 * Create the claim file COMPLETE, or not at all.
 *
 * `open(path, "wx")` is atomic but creates an EMPTY file, and the JSON lands a
 * moment later. In that window a second process reads an empty claim, calls it
 * malformed, unlinks it, and creates its own — while the first process happily
 * writes to its now-unlinked descriptor and reports success. Both then believe
 * they own the path, which is the exact outcome the claim exists to prevent.
 *
 * `link()` closes the window: the content is written to a private temporary
 * file first, and the link into place either succeeds atomically or fails
 * because someone else is already there. A reader never sees a partial claim.
 */
function tryCreateClaim(path: string, owner: PartialClaim): boolean {
  const temp = `${path}.${process.pid}.${owner.token.slice(0, 8)}.tmp`;
  try {
    writeSecretFile(temp, JSON.stringify(owner));
    linkSync(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already unlinked.
    }
  }
}

function readClaim(path: string): PartialClaim | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PartialClaim;
    // `startedAtMs` is required, not optional. Filling a missing one from the
    // pid currently running under that number makes the identity check compare
    // a process to itself and pass tautologically — so an unrelated program
    // that inherited the pid would hold the path forever.
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return undefined;
    if (!Number.isFinite(parsed.startedAtMs)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Is the claim's owner still running?
 *
 * Reuses the `(pid, startedAtMs)` identity every other liveness check in this
 * package uses, by shaping the claim into the same question `isAlive` already
 * answers: a pid alone is recycled, and acting on a recycled pid means
 * honouring a claim held by an unrelated program.
 */
function claimOwnerAlive(claim: PartialClaim): boolean {
  try {
    process.kill(claim.pid, 0);
  } catch {
    return false;
  }

  const actual = processStartTimeMs(claim.pid);
  // Tolerance because `ps` reports whole seconds.
  if (actual !== undefined) return Math.abs(actual - claim.startedAtMs) < 2000;

  // Identity unverifiable on this platform. `isAlive` biases toward "dead" here
  // and recovers via the runner's heartbeat — a claim has no heartbeat, and the
  // biases point the other way besides: calling a live holder dead means two
  // processes appending to one file, while calling a dead one alive means a
  // download the user can retry or redirect. Bias to ALIVE.
  return true;
}

/** A response's status line in a curl header dump — HTTP/1.x or HTTP/2 — which starts a new block. */
const STATUS_LINE = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i;

/**
 * Pull the `If-Range` validators out of a curl header dump.
 *
 * Returns the LAST response block's validators and nothing else. A dump holds
 * one block per hop, and only the final one describes the bytes that reached
 * disk — see the boundary reset below for what carrying one forward costs.
 *
 * Only a STRONG ETag is usable: RFC 9110 forbids a weak validator in
 * `If-Range`, because two weak-equivalent representations may differ byte for
 * byte — which is exactly the difference a resumed transfer cannot survive.
 * `Last-Modified` is the documented fallback.
 */
export function parseValidators(dump: string): { etag?: string; lastModified?: string } {
  let result: { etag?: string; lastModified?: string } = {};

  for (const line of dump.split(/\r?\n/)) {
    // A status line starts a new response, and everything learned from the
    // previous one is DISCARDED rather than carried forward.
    //
    // Per-field last-wins is not the same rule and is wrong here: a 302 that
    // carries an `ETag` followed by a final 200 that carries none leaves the
    // redirect's validator in place, describing bytes it has never seen. The
    // next attempt sends it as `If-Range`, the server finds it does not match
    // and answers 200 instead of 206, curl refuses to append (exit 33), and the
    // partial is reset — so the resume quietly becomes a full re-download of a
    // file that may be hundreds of megabytes.
    if (STATUS_LINE.test(line)) {
      result = {};
      continue;
    }

    const etag = /^etag:\s*(.+)$/i.exec(line);
    if (etag) {
      const value = etag[1].trim();
      // A weak validator is forbidden in `If-Range`: two weak-equivalent
      // representations may differ byte for byte, which is exactly the
      // difference a resumed transfer cannot survive. Deleted rather than set
      // to undefined so the key is absent, not present-and-empty.
      if (/^W\//i.test(value)) delete result.etag;
      else result.etag = value;
      continue;
    }

    const modified = /^last-modified:\s*(.+)$/i.exec(line);
    if (modified) result.lastModified = modified[1].trim();
  }

  return result;
}

/**
 * The status of the LAST response block in a curl header dump, and whether that
 * block's headers are complete (terminated by the blank line), or undefined when
 * no response has been dumped yet.
 *
 * The runner's close handler has curl's own `http_code`; a cancellation, and the
 * meter watching a transfer still in flight, have only this.
 */
export function parseFinalStatus(dump: string): { status: number; complete: boolean } | undefined {
  let status: number | undefined;
  let complete = false;
  // The last element is never a finished line: it is either what follows the
  // final newline (so "" for every header line curl has written whole) or a
  // line still being written. Counting that "" as the blank line would call a
  // block complete after its first header.
  for (const line of dump.split(/\r?\n/).slice(0, -1)) {
    const match = STATUS_LINE.exec(line);
    if (match) {
      status = Number(match[1]);
      complete = false;
    // The FIRST blank line after the status line ends its headers. Chunked
    // trailers can follow it in the same dump; they do not reopen the block.
    } else if (status !== undefined && line === "") {
      complete = true;
    }
  }
  return status === undefined ? undefined : { status, complete };
}

/**
 * The complete length a 416 reported, from the LAST response block's
 * `Content-Range: bytes * /N` (RFC 9110 §14.4), or undefined if it gave none.
 *
 * This is how a resumed request learns the partial is already the whole file:
 * asking for the range that starts at byte N of an N-byte resource is
 * unsatisfiable by definition. Same boundary rule as `parseValidators` — an
 * earlier hop's header never describes the final response.
 */
export function parseUnsatisfiedRangeTotal(dump: string): number | undefined {
  // Every Content-Range in the final block, not the last one: this result is
  // evidence the partial is complete, and two disagreeing fields are none.
  let totals: (number | undefined)[] = [];
  for (const line of dump.split(/\r?\n/)) {
    if (STATUS_LINE.test(line)) {
      totals = [];
      continue;
    }
    if (!/^content-range:/i.test(line)) continue;
    const range = /^content-range:\s*bytes\s+\*\/(\d+)\s*$/i.exec(line);
    totals.push(range ? Number(range[1]) : undefined);
  }
  // No field, a malformed one, or two that disagree all come out undefined.
  return totals.every((total) => total === totals[0]) ? totals[0] : undefined;
}
