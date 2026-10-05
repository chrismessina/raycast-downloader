/**
 * curl transport: config construction, progress parsing, exit classification.
 *
 * Why curl rather than Node's own `fetch`: the transfer has to outlive the
 * Raycast command that started it. A detached Node process could do it, but
 * curl already handles Range resume, redirects, retries and connection timeouts,
 * and it is present on every macOS install.
 *
 * Two decisions here are load-bearing, both verified empirically:
 *
 *  1. The URL is passed as CONFIG on curl's stdin (`curl -K -`), never on the
 *     command line and never in a file. Signed URLs are bearer credentials;
 *     argv is world-readable via `ps`, and a file outlives a process killed
 *     before it can delete it.
 *  2. Timeouts are THROUGHPUT-based (`--speed-limit`/`--speed-time`), not
 *     wall-clock (`--max-time`). `--max-time` counts machine sleep against the
 *     budget, so a laptop closed for ten minutes guarantees a spurious failure
 *     on an otherwise healthy transfer.
 */

import { DownloadError, type DownloadErrorCode, type SignalName, classifyHttpStatus } from "./errors";

/**
 * Is `curl` available on this system?
 *
 * Called before spawning so a missing binary is reported as a prerequisite the
 * user can act on, rather than as a generic transport failure surfacing minutes
 * after `startDownload` already reported success.
 *
 * Present by default on macOS and on Windows 10+ (`System32\curl.exe`), so this
 * is a guard against unusual environments rather than a common path. Cached —
 * the answer cannot change within a process's lifetime in any way that matters.
 */
let curlAvailable: boolean | undefined;

export function hasCurl(): boolean {
  if (curlAvailable !== undefined) return curlAvailable;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("curl", ["--version"], { stdio: "ignore", timeout: 5000 });
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }
  return curlAvailable;
}

/** Bytes/sec below which a transfer is considered dead, sustained for `stallSeconds`. */
export const DEFAULT_SPEED_LIMIT_BYTES = 1024;
export const DEFAULT_STALL_SECONDS = 120;

export interface CurlConfigOptions {
  url: string;
  /** Destination. Callers should pass the `.part` path, not the final one. */
  outputPath: string;
  headers?: Record<string, string>;
  followRedirects?: boolean;
  /** Continue a partial transfer via HTTP Range. */
  resume?: boolean;
  /**
   * Stall THRESHOLD, not a rate limit: if throughput stays below this for
   * `stallSeconds`, curl aborts. Lowering it makes stall detection more
   * forgiving; it does not slow the transfer down.
   */
  speedLimitBytes?: number;
  stallSeconds?: number;
  connectTimeoutSeconds?: number;
  /**
   * Cap the transfer rate in bytes/sec (curl `--limit-rate`). Genuinely slows
   * the download — useful for tests and for not saturating a connection.
   */
  limitRateBytes?: number;
  /**
   * Absolute wall-clock cap. Deliberately optional and unset by default —
   * see the note above about sleep.
   */
  maxTimeSeconds?: number;
  /**
   * Write the response headers to this path (`--dump-header`).
   *
   * The point is the NEXT attempt, not this one: a resumed transfer has to
   * prove the bytes on disk still belong to the resource it is about to append
   * to, and `ETag`/`Last-Modified` are the only proof a server offers. They are
   * dumped even for an interrupted transfer, because that is precisely the
   * transfer whose partial gets resumed.
   */
  dumpHeaderPath?: string;
  /**
   * `If-Range` validator for a resumed transfer.
   *
   * Turns a silent splice into a clean refusal. Measured against a
   * Range-capable local server: with a stale validator the server answers 200
   * with the whole body, and curl exits 33 leaving the partial untouched —
   * where the same request WITHOUT `If-Range` gets a 206 and appends the new
   * resource's bytes to the old resource's prefix, exit 0, published.
   */
  ifRange?: string;
}

/**
 * Build curl's config, which the runner writes to curl's stdin (`curl -K -`).
 *
 * Everything sensitive lives in this text, so it must never reach argv or disk.
 */
export function buildCurlConfig(options: CurlConfigOptions): string {
  const {
    url,
    outputPath,
    headers = {},
    followRedirects = true,
    resume = false,
    speedLimitBytes = DEFAULT_SPEED_LIMIT_BYTES,
    stallSeconds = DEFAULT_STALL_SECONDS,
    connectTimeoutSeconds = 30,
    limitRateBytes,
    maxTimeSeconds,
    dumpHeaderPath,
    ifRange,
  } = options;

  const lines: string[] = [
    `url = "${escapeConfigValue(url)}"`,
    `output = "${escapeConfigValue(outputPath)}"`,
    // `fail` (not `fail-with-body`): on a 4xx/5xx, curl must write NOTHING to
    // the output file.
    //
    // With `fail-with-body`, an error response body lands in the `.part` file —
    // measured: a 404 wrote 21 bytes of `{"error":"Not found"}`. Because the
    // partial is deliberately retained for resume, the next attempt's
    // `continue-at = -` would start AFTER those bytes, splicing an error
    // document into the middle of the media. The file would then pass a
    // size check and be published as complete. Silent corruption is far worse
    // than losing an error body we never surface to the user anyway.
    "fail",
    `connect-timeout = ${connectTimeoutSeconds}`,
    // Throughput-based stall detection: survives sleep, catches a dead socket.
    `speed-limit = ${speedLimitBytes}`,
    `speed-time = ${stallSeconds}`,
    // Authoritative final numbers, parsed from stdout on exit.
    'write-out = "\\n%{size_download}\\n%{speed_download}\\n%{http_code}\\n"',
  ];

  if (followRedirects) lines.push("location");
  // `-C -` asks curl to work out the offset from the existing file.
  if (resume) lines.push("continue-at = -");
  if (limitRateBytes !== undefined) lines.push(`limit-rate = ${limitRateBytes}`);
  if (dumpHeaderPath) {
    lines.push(`dump-header = "${escapeConfigValue(dumpHeaderPath)}"`);
    // Through a proxy, curl dumps the tunnel's "200 Connection established"
    // block too, and the runner would read it as the origin's answer.
    lines.push("suppress-connect-headers");
  }
  // Only meaningful alongside `continue-at`, which is what generates the Range
  // this validates. Harmless without one: a server ignores `If-Range` on an
  // unranged request.
  if (ifRange) lines.push(`header = "${escapeConfigValue(`If-Range: ${ifRange}`)}"`);
  if (maxTimeSeconds !== undefined) lines.push(`max-time = ${maxTimeSeconds}`);

  assertCallerHeaders(headers);
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`header = "${escapeConfigValue(`${name}: ${value}`)}"`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Refuse caller headers that would fight the resume machinery.
 *
 * `Range` and `If-Range` belong to the transport. Caller headers are appended
 * AFTER the generated ones, so a second `If-Range` — or a hand-written `Range`
 * — is what a server or proxy may act on, and the resume guard silently stops
 * guarding: a 206 comes back for bytes that do not continue the partial, curl
 * exits 0, and the spliced file is published.
 *
 * Refused rather than dropped, because a caller who passed one meant something
 * by it and deserves to be told it cannot work. Exported so `startDownload` can
 * fail before it claims a path or spawns anything, rather than minutes later
 * inside a detached process.
 */
export function assertCallerHeaders(headers: Record<string, string> = {}): void {
  for (const name of Object.keys(headers)) {
    if (/^(range|if-range)$/i.test(name.trim())) {
      throw new DownloadError(
        "validation",
        `The ${name.trim()} header is managed by the downloader and cannot be set by a caller. ` +
          `Use the resume option instead.`,
      );
    }
  }
}

/**
 * Escape a value for curl's config quoting.
 *
 * Escaping quotes and backslashes is not sufficient on its own: curl's config
 * format is line-oriented, so a raw newline inside a value ends the line and
 * whatever follows is parsed as a fresh directive. Measured behavior is that
 * curl rejects the resulting malformed URL rather than honoring the smuggled
 * directive — but that is curl's parser saving us, not our own correctness.
 *
 * So control characters are rejected outright rather than escaped. A URL or
 * header value containing a newline is malformed anyway; refusing it makes
 * config injection structurally impossible instead of contingent on curl.
 */
function escapeConfigValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new DownloadError("validation", "Refusing a value containing control characters.");
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface CurlProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number;
}

/**
 * Parse curl's default progress meter.
 *
 * Deliberately NOT `--progress-bar`: that mode emits only a percentage, which is
 * why the existing Fetch extension's speed and ETA fields are hardcoded to zero
 * and its speed UI has never rendered. The default meter carries real numbers:
 *
 *   % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
 *                                  Dload  Upload   Total   Spent    Left  Speed
 *  13  365M   13 48.7M    0     0  8058k      0  0:00:46  0:00:06  0:00:40 8501k
 *
 * Returns the most recent complete sample, or null if none is present yet.
 */
export function parseCurlMeter(buffer: string): CurlProgress | null {
  // Meter updates are separated by \r; take complete lines only.
  const lines = buffer.split(/[\r\n]+/).filter((line) => line.trim().length > 0);

  for (let i = lines.length - 1; i >= 0; i--) {
    const fields = lines[i].trim().split(/\s+/);
    // 12 columns; the first is a percentage, so require a leading integer.
    if (fields.length < 12) continue;
    if (!/^\d+$/.test(fields[0])) continue;

    const totalBytes = parseCurlSize(fields[1]);
    const bytesDownloaded = parseCurlSize(fields[3]);
    if (bytesDownloaded === undefined) continue;

    const speedBytesPerSec = parseCurlSize(fields[6]);
    const etaSeconds = parseCurlDuration(fields[10]);

    return {
      bytesDownloaded,
      totalBytes: totalBytes && totalBytes > 0 ? totalBytes : undefined,
      speedBytesPerSec,
      etaSeconds,
    };
  }

  return null;
}

/** Parse curl's abbreviated sizes: `1234`, `48.7M`, `365M`, `8058k`. */
export function parseCurlSize(field: string | undefined): number | undefined {
  if (!field) return undefined;
  const match = /^(\d+(?:\.\d+)?)([kKmMgGtT])?$/.exec(field.trim());
  if (!match) return undefined;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;

  const multipliers: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  const suffix = match[2]?.toLowerCase();
  return suffix ? Math.round(value * multipliers[suffix]) : value;
}

/** Parse `H:MM:SS`. curl prints `--:--:--` when it has no estimate. */
export function parseCurlDuration(field: string | undefined): number | undefined {
  if (!field || field.includes("-")) return undefined;
  const parts = field.trim().split(":");
  if (parts.length !== 3) return undefined;

  const [h, m, s] = parts.map((p) => parseInt(p, 10));
  if ([h, m, s].some((n) => Number.isNaN(n))) return undefined;
  return h * 3600 + m * 60 + s;
}

export interface CurlWriteOut {
  sizeDownload?: number;
  speedDownload?: number;
  httpCode?: number;
}

/** Parse the trailing `write-out` block (size, speed, http_code — one per line). */
export function parseWriteOut(stdout: string): CurlWriteOut {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length < 3) return {};

  const [size, speed, code] = lines.slice(-3).map((line) => Number(line.trim()));
  return {
    sizeDownload: Number.isFinite(size) ? size : undefined,
    speedDownload: Number.isFinite(speed) ? speed : undefined,
    httpCode: Number.isFinite(code) ? code : undefined,
  };
}

/**
 * curl exit codes worth distinguishing.
 * https://curl.se/libcurl/c/libcurl-errors.html
 */
const EXIT_CODES: Record<number, { code: DownloadErrorCode; message: string }> = {
  6: { code: "dns", message: "Could not resolve host." },
  7: { code: "network", message: "Failed to connect to the server." },
  18: { code: "network", message: "Transfer ended early." },
  22: { code: "http_client", message: "The server returned an error." },
  23: { code: "disk_full", message: "Could not write the file — the disk may be full." },
  26: { code: "permission", message: "Could not read from the local file." },
  28: { code: "timeout", message: "The transfer timed out." },
  33: { code: "network", message: "The server does not support resuming; restart the download." },
  35: { code: "tls", message: "Could not establish a secure connection." },
  36: { code: "integrity", message: "Could not resume — the partial file is unusable." },
  47: { code: "network", message: "Too many redirects." },
  52: { code: "network", message: "The server returned nothing." },
  55: { code: "network", message: "Failed to send data to the server." },
  56: { code: "network", message: "Connection lost during transfer." },
  63: { code: "http_client", message: "The response exceeded the maximum allowed size." },
};

export interface ClassifyCurlInput {
  exitCode: number | null;
  signal?: SignalName | null;
  httpCode?: number;
  stderrTail?: string;
  /** True when the local process deliberately terminated curl. */
  cancelled?: boolean;
  /** Whether the request was made with redirects enabled. Default true. */
  followRedirects?: boolean;
  /** Whether the request resumed an existing partial (sent a Range). Default false. */
  resumed?: boolean;
}

/**
 * Turn a finished curl invocation into a typed error.
 *
 * HTTP status is consulted before the exit code: curl exits 22 for every 4xx/5xx
 * under `fail-with-body`, and "403 Forbidden" is far more actionable than
 * "curl exited 22".
 */
export function classifyCurlFailure(input: ClassifyCurlInput): DownloadError {
  const { exitCode, signal, httpCode, stderrTail, cancelled, followRedirects = true, resumed = false } = input;

  if (cancelled || signal === "SIGTERM" || signal === "SIGINT") {
    return new DownloadError("cancelled", "Download cancelled.", { exitCode, signal });
  }

  // A 3xx only reaches here when redirects were DISABLED: with `location` set,
  // curl reports the status of the final hop, never the redirect itself. curl
  // exits 0 for an unfollowed redirect, so without this branch the code falls
  // past EXIT_CODES[0] into the last-resort message and reports
  // "Download failed (curl exit 0)." for a perfectly explicable outcome.
  // Gated on a CLEAN exit: curl exits 47 ("Too many redirects") while reporting
  // a 3xx http_code, and that is a redirect loop, not an unfollowed redirect.
  // Letting this branch win would relabel it.
  if (exitCode === 0 && httpCode !== undefined && httpCode >= 300 && httpCode < 400) {
    return new DownloadError(
      // `http_client`, not a new code: the request did not yield the body and
      // the caller must change something (enable redirects, drop a conditional
      // header, pass the final URL) — exactly the non-retryable bucket
      // `http_client` names.
      "http_client",
      unfollowedRedirectMessage(httpCode, followRedirects),
      { httpStatus: httpCode, exitCode, signal },
    );
  }

  // A resumed request answered with a whole body that curl did NOT refuse:
  // measured, it exits 0 when the body's length equals the resume offset
  // ("already downloaded") and leaves the partial as it was. Same meaning as
  // exit 33 — the partial cannot be trusted to be this file — same message.
  // A 2xx only reaches here when the runner refused it as not-the-file (202,
  // 204, 205, or a 206 nobody asked for). Same reason as the 3xx branch above:
  // curl exited 0, so EXIT_CODES has nothing to say about it.
  // A 202 means "not ready yet" whether or not this was a resume, and whether curl
  // exited 0 (took the body) or 33 (refused it as an answer to a range). The
  // runner keeps a resumed partial for it, so it must not read as "cannot resume".
  if (httpCode === 202 && (exitCode === 0 || exitCode === 33)) {
    return new DownloadError("pending", unusableSuccessMessage(202), { httpStatus: 202, exitCode, signal });
  }
  if (exitCode === 0 && httpCode !== undefined && httpCode >= 200 && httpCode < 300) {
    if (resumed && httpCode !== 206) {
      return new DownloadError(EXIT_CODES[33].code, EXIT_CODES[33].message, { httpStatus: httpCode, exitCode, signal });
    }
    const code = httpCode === 202 ? "pending" : httpCode === 206 ? "integrity" : "http_client";
    return new DownloadError(code, unusableSuccessMessage(httpCode), {
      httpStatus: httpCode,
      exitCode,
      signal,
    });
  }

  if (httpCode !== undefined && httpCode >= 400) {
    const code = classifyHttpStatus(httpCode);
    return new DownloadError(code, httpErrorMessage(httpCode), { httpStatus: httpCode, exitCode, signal });
  }

  if (exitCode !== null && EXIT_CODES[exitCode]) {
    const { code, message } = EXIT_CODES[exitCode];
    return new DownloadError(code, message, { exitCode, signal, httpStatus: httpCode });
  }

  // Last resort: curl's own words are more useful than a bare number.
  const detail = stderrTail?.trim().split("\n").pop()?.trim();
  return new DownloadError(
    "unknown",
    detail ? `Download failed: ${detail}` : `Download failed (curl exit ${exitCode ?? "unknown"}).`,
    { exitCode, signal, httpStatus: httpCode },
  );
}

/**
 * Wording for a 3xx that curl exited 0 on.
 *
 * `location` does NOT guarantee the absence of a final 3xx: curl only follows a
 * response that carries a usable `Location`. A 304 (the caller sent a
 * conditional header) and a 300 (multiple choices, no `Location`) both end the
 * transfer as themselves, with redirects fully enabled.
 */
function unfollowedRedirectMessage(status: number, followRedirects: boolean): string {
  if (status === 304) return "The server reported the file as unchanged (HTTP 304) and sent no content.";
  if (!followRedirects) return `The server redirected (HTTP ${status}) but redirects are disabled.`;
  return `The server returned a redirect that could not be followed (HTTP ${status}).`;
}

function unusableSuccessMessage(status: number): string {
  switch (status) {
    case 202:
      return "The server accepted the request but has not produced the file yet (HTTP 202). Try again later.";
    case 206:
      return "The server sent only part of the file (HTTP 206).";
    default:
      return `The server returned no file (HTTP ${status}).`;
  }
}

function httpErrorMessage(status: number): string {
  switch (status) {
    case 401:
      return "Not authorized — the credentials were rejected.";
    case 403:
      return "Access denied. The link may have expired, or you may not have permission to download this.";
    case 404:
      return "The file was not found on the server.";
    case 410:
      return "The download link has expired.";
    case 416:
      return "Could not resume from the existing partial file.";
    case 429:
      return "Rate limited by the server. Try again shortly.";
    default:
      return status >= 500
        ? `The server is temporarily unavailable (HTTP ${status}).`
        : `The server rejected the request (HTTP ${status}).`;
  }
}
