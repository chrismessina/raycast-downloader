import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCurlConfig,
  parseCurlMeter,
  parseCurlSize,
  parseCurlDuration,
  parseWriteOut,
  classifyCurlFailure,
} from "../dist/curl.js";

/**
 * Captured from a real `curl` run (typescript-5.9.3.tgz, --limit-rate 800k).
 * Fixtures are real output, not invented: the Fetch extension's parser was
 * written against an imagined format and silently reports zeros forever.
 */
const REAL_METER =
  "  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r" +
  "  8 4274k    8  359k    0     0   782k      0  0:00:05 --:--:--  0:00:05  781k\r" +
  " 65 4274k   65 2801k    0     0   797k      0  0:00:05  0:00:03  0:00:02  797k\r";

const REAL_METER_COMPLETE = "100 4274k  100 4274k    0     0   802k      0  0:00:05  0:00:05 --:--:--  804k\r";

// ─── buildCurlConfig ─────────────────────────────────────────────────────────

test("config carries url and output as quoted values", () => {
  const config = buildCurlConfig({ url: "https://example.com/a.mp4", outputPath: "/tmp/a.mp4.part" });
  assert.match(config, /^url = "https:\/\/example\.com\/a\.mp4"$/m);
  assert.match(config, /^output = "\/tmp\/a\.mp4\.part"$/m);
});

test("a header dump never carries a proxy's CONNECT response", () => {
  // Its "200 Connection established" block would read as the origin's answer.
  const config = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a", dumpHeaderPath: "/tmp/a.headers" });
  assert.match(config, /^suppress-connect-headers$/m);
});

test("config uses THROUGHPUT timeouts and no wall-clock cap by default", () => {
  // --max-time counts machine sleep; a closed laptop would fail a healthy transfer.
  const config = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a" });
  assert.match(config, /^speed-limit = \d+$/m);
  assert.match(config, /^speed-time = \d+$/m);
  assert.ok(!/^max-time/m.test(config), "must not set max-time by default");
});

test("config includes max-time only when explicitly requested", () => {
  const config = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a", maxTimeSeconds: 7200 });
  assert.match(config, /^max-time = 7200$/m);
});

test("config enables resume only when asked", () => {
  const plain = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a" });
  assert.ok(!/continue-at/.test(plain));

  const resuming = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a", resume: true });
  assert.match(resuming, /^continue-at = -$/m);
});

test("config follows redirects by default and can opt out", () => {
  assert.match(buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a" }), /^location$/m);
  assert.ok(!/^location$/m.test(buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a", followRedirects: false })));
});

test("config emits headers", () => {
  const config = buildCurlConfig({
    url: "https://e.com/a",
    outputPath: "/tmp/a",
    headers: { "X-Api-Key": "secret", Accept: "video/mp4" },
  });
  assert.match(config, /^header = "X-Api-Key: secret"$/m);
  assert.match(config, /^header = "Accept: video\/mp4"$/m);
});

test("config escapes quotes and backslashes within a value", () => {
  const config = buildCurlConfig({ url: 'https://e.com/a"b', outputPath: "/tmp/a" });
  assert.match(config, /\\"/, "a quote inside a value must not terminate it");
});

test("a value containing a newline is REJECTED, not escaped", () => {
  // curl's config format is line-oriented: a raw newline ends the value and the
  // next line parses as a fresh directive. Measured, curl rejects the resulting
  // malformed URL rather than honoring the injected directive — but relying on
  // that is relying on curl's parser instead of our own correctness.
  assert.throws(
    () => buildCurlConfig({ url: 'https://e.com/a"\nproxy = "http://evil', outputPath: "/tmp/a" }),
    /control characters/i,
  );
});

test("control characters are rejected in headers too", () => {
  assert.throws(
    () =>
      buildCurlConfig({
        url: "https://e.com/a",
        outputPath: "/tmp/a",
        headers: { "X-Api-Key": "secret\nproxy = \"http://evil" },
      }),
    /control characters/i,
  );
});

test("a rejected value throws a typed, non-retryable error", () => {
  try {
    buildCurlConfig({ url: "https://e.com/\x00", outputPath: "/tmp/a" });
    assert.fail("expected a throw");
  } catch (error) {
    assert.equal(error.code, "validation");
    assert.equal(error.retryable, false, "retrying malformed input cannot help");
  }
});

test("config requests write-out for authoritative final numbers", () => {
  const config = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a" });
  assert.match(config, /write-out/);
  assert.match(config, /size_download/);
  assert.match(config, /http_code/);
});

// ─── parseCurlSize ───────────────────────────────────────────────────────────

test("parseCurlSize handles plain and suffixed values", () => {
  assert.equal(parseCurlSize("1234"), 1234);
  assert.equal(parseCurlSize("4274k"), 4274 * 1024);
  assert.equal(parseCurlSize("48.7M"), Math.round(48.7 * 1024 ** 2));
  assert.equal(parseCurlSize("2G"), 2 * 1024 ** 3);
});

test("parseCurlSize rejects junk rather than returning NaN", () => {
  assert.equal(parseCurlSize("--:--:--"), undefined);
  assert.equal(parseCurlSize(""), undefined);
  assert.equal(parseCurlSize(undefined), undefined);
});

// ─── parseCurlDuration ───────────────────────────────────────────────────────

test("parseCurlDuration parses H:MM:SS", () => {
  assert.equal(parseCurlDuration("0:00:02"), 2);
  assert.equal(parseCurlDuration("0:01:30"), 90);
  assert.equal(parseCurlDuration("1:00:00"), 3600);
});

test("parseCurlDuration treats curl's placeholder as unknown", () => {
  assert.equal(parseCurlDuration("--:--:--"), undefined);
  assert.equal(parseCurlDuration(undefined), undefined);
});

// ─── parseCurlMeter (against REAL captured output) ────────────────────────────

test("parseCurlMeter extracts every field from a real meter line", () => {
  const progress = parseCurlMeter(REAL_METER);
  assert.equal(progress.bytesDownloaded, 2801 * 1024);
  assert.equal(progress.totalBytes, 4274 * 1024);
  assert.equal(progress.speedBytesPerSec, 797 * 1024);
  assert.equal(progress.etaSeconds, 2);
});

test("parseCurlMeter returns the LATEST sample, not the first", () => {
  const progress = parseCurlMeter(REAL_METER);
  assert.notEqual(progress.bytesDownloaded, 0, "must not return the initial all-zero row");
  assert.notEqual(progress.bytesDownloaded, 359 * 1024, "must not return a stale middle row");
});

test("parseCurlMeter reports real speed and ETA — the bug this replaces", () => {
  // Fetch's parser hardcodes bytes/total/speed/eta to 0, so its speed accessory
  // (gated on speed > 0) has never rendered for any user.
  const progress = parseCurlMeter(REAL_METER);
  assert.ok(progress.speedBytesPerSec > 0, "speed must be a real number");
  assert.ok(progress.etaSeconds > 0, "eta must be a real number");
});

test("parseCurlMeter handles the completed row with an unknown ETA", () => {
  const progress = parseCurlMeter(REAL_METER_COMPLETE);
  assert.equal(progress.bytesDownloaded, 4274 * 1024);
  assert.equal(progress.etaSeconds, undefined, "'--:--:--' is unknown, not zero");
});

test("parseCurlMeter returns null before any sample exists", () => {
  assert.equal(parseCurlMeter(""), null);
  assert.equal(parseCurlMeter("  % Total    % Received % Xferd  Average Speed"), null);
});

test("parseCurlMeter ignores a partially-written trailing line", () => {
  // Chunked stderr can cut mid-row; a half row must not yield bogus numbers.
  const progress = parseCurlMeter(REAL_METER + " 70 4274k   70 30");
  assert.equal(progress.bytesDownloaded, 2801 * 1024, "should fall back to the last complete row");
});

// ─── parseWriteOut ───────────────────────────────────────────────────────────

test("parseWriteOut reads the trailing three lines", () => {
  const out = parseWriteOut("\n4377468\n802816\n200\n");
  assert.equal(out.sizeDownload, 4377468);
  assert.equal(out.speedDownload, 802816);
  assert.equal(out.httpCode, 200);
});

test("parseWriteOut tolerates an empty or short block", () => {
  assert.deepEqual(parseWriteOut(""), {});
  assert.deepEqual(parseWriteOut("200"), {});
});

// ─── classifyCurlFailure ─────────────────────────────────────────────────────

test("cancellation is detected from the flag or the signal", () => {
  assert.equal(classifyCurlFailure({ exitCode: null, signal: "SIGTERM" }).code, "cancelled");
  assert.equal(classifyCurlFailure({ exitCode: 23, cancelled: true }).code, "cancelled");
});

test("HTTP status wins over the generic exit code", () => {
  // curl exits 22 for every 4xx/5xx; "403" is far more actionable than "exit 22".
  const error = classifyCurlFailure({ exitCode: 22, httpCode: 403 });
  assert.equal(error.code, "forbidden");
  assert.equal(error.httpStatus, 403);
  assert.match(error.message, /expired|permission/i);
});

test("a refused 2xx names its status instead of 'curl exit 0'", () => {
  // curl exits 0 on these; the runner refuses them as not-the-file.
  const accepted = classifyCurlFailure({ exitCode: 0, httpCode: 202 });
  // Not ready yet is not a client error: the same request succeeds later.
  assert.equal(accepted.code, "pending");
  assert.equal(accepted.retryable, true);
  assert.match(accepted.message, /HTTP 202/);
  const noContent = classifyCurlFailure({ exitCode: 0, httpCode: 204 });
  assert.match(noContent.message, /HTTP 204/);
  const fragment = classifyCurlFailure({ exitCode: 0, httpCode: 206 });
  assert.equal(fragment.code, "integrity");
  assert.match(fragment.message, /HTTP 206/);
});

test("a resumed whole body curl exited 0 on reads as not resumable, and is retryable", () => {
  // curl's "already downloaded": a 200 as long as the partial, which it keeps.
  const error = classifyCurlFailure({ exitCode: 0, httpCode: 200, resumed: true });
  assert.equal(error.code, "network");
  assert.equal(error.retryable, true);
  assert.match(error.message, /resum/i);
  // Resumed wins over the fresh-request mapping for a 202 too.
  assert.equal(classifyCurlFailure({ exitCode: 0, httpCode: 202, resumed: true }).code, "network");
});

test("410 maps to an expired link and is retryable", () => {
  const error = classifyCurlFailure({ exitCode: 22, httpCode: 410 });
  assert.equal(error.code, "url_expired");
  assert.equal(error.retryable, true);
});

test("a full disk is reported distinctly and is NOT retryable", () => {
  const error = classifyCurlFailure({ exitCode: 23 });
  assert.equal(error.code, "disk_full");
  assert.equal(error.retryable, false);
  assert.match(error.message, /disk/i);
});

test("transient network conditions are retryable", () => {
  for (const [exitCode, expected] of [
    [6, "dns"],
    [7, "network"],
    [28, "timeout"],
    [35, "tls"],
    [56, "network"],
  ]) {
    const error = classifyCurlFailure({ exitCode });
    assert.equal(error.code, expected, `exit ${exitCode}`);
    assert.equal(error.retryable, true, `exit ${exitCode} should be retryable`);
  }
});

test("a failed resume is distinguishable so the caller can restart from scratch", () => {
  assert.equal(classifyCurlFailure({ exitCode: 33 }).code, "network");
  assert.equal(classifyCurlFailure({ exitCode: 36 }).code, "integrity");
  assert.equal(classifyCurlFailure({ exitCode: 22, httpCode: 416 }).code, "http_client");
});

test("an unknown exit code surfaces curl's own words", () => {
  const error = classifyCurlFailure({ exitCode: 99, stderrTail: "curl: (99) something specific went wrong" });
  assert.equal(error.code, "unknown");
  assert.match(error.message, /something specific went wrong/);
});

test("an unknown exit code with no stderr still produces a usable message", () => {
  const error = classifyCurlFailure({ exitCode: 99 });
  assert.match(error.message, /99/);
});

test("config uses `fail`, NOT `fail-with-body` — an error body must never reach the .part file", () => {
  // Measured: with fail-with-body a 404 writes `{"error":"Not found"}` (21 bytes)
  // into the output file. Because the partial is retained for resume, the next
  // attempt's `continue-at = -` would start AFTER those bytes, splicing an error
  // document into the middle of the media — which then passes a size check and
  // gets published as a complete download. Silent corruption, worst class of bug.
  const config = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a.part" });
  assert.ok(/^fail$/m.test(config), "expected a bare `fail` directive");
  assert.ok(!/fail-with-body/.test(config), "fail-with-body corrupts resumable partials");
});

test("limit-rate is emitted only when asked, and is distinct from speed-limit", () => {
  // speed-limit is a STALL THRESHOLD; limit-rate actually throttles. Conflating
  // them silently disables stall detection or throttles a real download.
  const plain = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a" });
  assert.ok(!/^limit-rate/m.test(plain));

  const throttled = buildCurlConfig({ url: "https://e.com/a", outputPath: "/tmp/a", limitRateBytes: 300000 });
  assert.match(throttled, /^limit-rate = 300000$/m);
  assert.match(throttled, /^speed-limit = \d+$/m, "stall detection must remain active");
});

test("an unfollowed 3xx is classified as a redirect, but a redirect LOOP stays exit 47", () => {
  const disabled = classifyCurlFailure({ exitCode: 0, httpCode: 302, followRedirects: false });
  assert.equal(disabled.code, "http_client");
  assert.match(disabled.message, /redirected \(HTTP 302\).*disabled/);
  assert.equal(disabled.retryable, false);

  // With redirects ON, a surviving 3xx is one curl could not follow.
  const unfollowable = classifyCurlFailure({ exitCode: 0, httpCode: 300 });
  assert.match(unfollowable.message, /could not be followed \(HTTP 300\)/);

  // 304 is its own thing and gets its own words.
  assert.match(classifyCurlFailure({ exitCode: 0, httpCode: 304 }).message, /unchanged \(HTTP 304\)/);

  // curl reports a 3xx http_code alongside exit 47; that is a loop, not a
  // disabled-redirect outcome, and must keep its own message.
  const loop = classifyCurlFailure({ exitCode: 47, httpCode: 302 });
  assert.match(loop.message, /Too many redirects/);
});
