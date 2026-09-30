/**
 * Transport-agnostic download error taxonomy.
 *
 * Deliberately knows nothing about curl. Exit-code classification lives in
 * `curl.ts` (the transport layer) because iOS Apps downloads through `ipatool`
 * and must not inherit curl semantics it never produces. Anything here has to
 * make sense for *any* transport.
 */

export type DownloadErrorCode =
  | "cancelled"
  | "network"
  | "dns"
  | "tls"
  | "timeout"
  | "stalled"
  | "http_client"
  | "http_server"
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "disk_full"
  | "permission"
  | "url_expired"
  /**
   * The server accepted the request but has not produced the file yet
   * (HTTP 202). Retryable: the same request succeeds once it is ready.
   */
  | "pending"
  | "integrity"
  /** Caller-supplied input was rejected before any request was made. */
  | "validation"
  /**
   * Another live attempt already owns this `outputPath`.
   *
   * Not retryable on its own: the other attempt has to finish, or this caller
   * has to pick a different path (`uniquePath` allocates one). Retrying the
   * same path in a loop just races the same holder again.
   */
  | "conflict"
  /**
   * The transfer began and then stopped without recording an outcome, leaving a
   * partial file behind. Distinct from `runner_failed` in the one way that
   * matters to the user: there are bytes on disk, so resuming is worthwhile.
   */
  | "interrupted"
  /**
   * The helper process died before transferring anything — a missing runner, an
   * unusable output directory, no working `node`. Not retryable: the same
   * environment produces the same crash, and a retry loop hides the cause.
   */
  | "runner_failed"
  | "unknown";

/**
 * A POSIX signal name.
 *
 * Spelled as a plain string union rather than `NodeJS.Signals` so the published
 * declarations don't require `@types/node` — it is a dev dependency here, and a
 * consumer without Node ambient types would otherwise fail to typecheck.
 */
export type SignalName = string;

export interface DownloadErrorDetail {
  httpStatus?: number;
  exitCode?: number | null;
  signal?: SignalName | null;
  cause?: unknown;
}

/**
 * Codes a caller may sensibly retry without user intervention.
 *
 * `url_expired` counts as retryable: for signed-URL APIs the recovery is to
 * re-request a fresh URL and resume onto the existing partial file, which is
 * automatic from the user's point of view. `forbidden`, `auth`, `not_found`,
 * `disk_full` and `permission` all need a human to change something first.
 */
const RETRYABLE: ReadonlySet<DownloadErrorCode> = new Set<DownloadErrorCode>([
  "network",
  "dns",
  "tls",
  "timeout",
  "stalled",
  "http_server",
  "rate_limited",
  "url_expired",
  "pending",
  // Bytes are already on disk, so a retry resumes rather than restarting.
  "interrupted",
  // `runner_failed` is deliberately absent: the helper crashed on startup, and
  // the environment that produced that crash is unchanged by trying again.
]);

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly httpStatus?: number;
  readonly exitCode?: number | null;
  readonly signal?: SignalName | null;
  readonly retryable: boolean;

  /** Original underlying error, when there was one. */
  readonly cause?: unknown;

  constructor(code: DownloadErrorCode, message: string, detail: DownloadErrorDetail = {}) {
    // Not `super(message, { cause })` — the two-arg Error constructor is ES2022 and
    // this package targets ES2020 so it can be consumed by older extension configs.
    super(message);
    this.name = "DownloadError";
    this.cause = detail.cause;
    this.code = code;
    this.httpStatus = detail.httpStatus;
    this.exitCode = detail.exitCode;
    this.signal = detail.signal;
    this.retryable = RETRYABLE.has(code);
  }
}

/** Narrow an unknown thrown value to a DownloadError. */
export function isDownloadError(error: unknown): error is DownloadError {
  return error instanceof DownloadError;
}

/**
 * Map an HTTP status to a code. Shared by every transport, since they all
 * ultimately surface an HTTP status.
 *
 * 410 Gone is folded into `url_expired` alongside 403: for signed URLs, both
 * are what a lapsed signature looks like in practice, and both recover the same
 * way. Callers that can distinguish a genuine permission denial (Fathom's
 * limited-access shares) should classify that before falling back here.
 */
export function classifyHttpStatus(status: number): DownloadErrorCode {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 410) return "url_expired";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "http_server";
  if (status >= 400) return "http_client";
  return "unknown";
}
