/**
 * The path-keyed claim and the durable partial state, tested directly.
 *
 * These are the pieces whose failure modes are races and permission errors —
 * neither of which an end-to-end download test can produce on demand.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  claimPartialPath,
  claimPath,
  markPartialUnsafe,
  mayResume,
  parseFinalStatus,
  parseUnsatisfiedRangeTotal,
  parseValidators,
  partialClaimHolder,
  readPartialState,
  releasePartialClaim,
  resetPartial,
  resourceFingerprint,
  statePath,
  urlFingerprint,
  writePartialState,
} from "../dist/partial.js";

function tempPart() {
  const dir = mkdtempSync(join(tmpdir(), "partial-"));
  return { dir, partPath: join(dir, "f.bin.part") };
}

test("a second claim on a live path is refused", () => {
  const { dir, partPath } = tempPart();
  try {
    const first = claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" });
    assert.equal(typeof first, "string");
    assert.equal(
      claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "b" }),
      undefined,
      "the second caller must not also believe it owns the path",
    );
    assert.equal(partialClaimHolder(partPath)?.id, "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim is released only by its holder", () => {
  const { dir, partPath } = tempPart();
  try {
    const token = claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" });

    // A late handler from an earlier, failed attempt.
    releasePartialClaim(partPath, "some-other-token");
    assert.equal(existsSync(claimPath(partPath)), true, "a stale token must not release someone else's claim");

    releasePartialClaim(partPath, token);
    assert.equal(existsSync(claimPath(partPath)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged claim is NOT stolen, and force is the way out", () => {
  const { dir, partPath } = tempPart();
  try {
    // Not valid JSON: with atomic creation, this cannot be a half-written
    // claim, so it is damage rather than a race — and stealing on that basis is
    // how two runners end up appending to one file.
    writeFileSync(claimPath(partPath), "{not json");
    assert.equal(
      claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" }),
      undefined,
    );

    releasePartialClaim(partPath, undefined, true);
    assert.equal(typeof claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" }), "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim missing its start time is not honoured", () => {
  const { dir, partPath } = tempPart();
  try {
    // Without a start time the identity check would compare the running pid to
    // itself and pass tautologically, so an unrelated program that inherited
    // the pid would hold the path forever.
    writeFileSync(claimPath(partPath), JSON.stringify({ pid: process.pid, id: "ghost", token: "t" }));
    assert.equal(partialClaimHolder(partPath), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetPartial keeps the filename reserved", () => {
  const { dir, partPath } = tempPart();
  try {
    writeFileSync(partPath, "contaminated");
    markPartialUnsafe(partPath);

    assert.equal(resetPartial(partPath), true);
    assert.equal(readFileSync(partPath, "utf8"), "", "the bytes must be gone");
    assert.equal(existsSync(partPath), true, "but the reservation on the final name must survive");
    assert.equal(existsSync(statePath(partPath)), false, "and nothing stale may be left describing it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mayResume: what is and is not enough", () => {
  const url = "https://example.com/a/file.bin?sig=NEW";
  const identity = { urlHash: urlFingerprint(url), resourceHash: resourceFingerprint(url) };

  assert.equal(mayResume(undefined, url), false, "nothing recorded");
  assert.equal(mayResume({ v: 1, ...identity }, url), false, "no validator");
  assert.equal(mayResume({ v: 1, ...identity, unsafe: true, etag: '"v1"' }, url), false, "marked unsafe");
  assert.equal(mayResume({ v: 1, ...identity, etag: '"v1"' }, url), true, "exact url + validator");
  assert.equal(
    mayResume({ v: 1, resourceHash: resourceFingerprint("https://example.com/a/file.bin?sig=OLD"), etag: '"v1"' }, url),
    true,
    "a re-signed link is the same resource",
  );
  assert.equal(
    mayResume({ v: 1, resourceHash: resourceFingerprint("https://example.com/b/other.bin"), etag: '"v1"' }, url),
    false,
    "a different path is a different resource",
  );
});

test("a malformed unsafe flag reads as unsafe", () => {
  const { dir, partPath } = tempPart();
  try {
    writeFileSync(statePath(partPath), JSON.stringify({ v: 1, unsafe: "yes", etag: '"v1"' }));
    assert.equal(readPartialState(partPath)?.unsafe, true);
    assert.equal(mayResume(readPartialState(partPath), "https://example.com/f"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseValidators takes the last block and refuses weak ETags", () => {
  const dump = [
    "HTTP/1.1 302 Found",
    'ETag: "first-hop"',
    "",
    "HTTP/1.1 200 OK",
    'ETag: "final-hop"',
    "Last-Modified: Wed, 17 Sep 2026 12:00:00 GMT",
    "",
  ].join("\r\n");
  assert.deepEqual(parseValidators(dump), { etag: '"final-hop"', lastModified: "Wed, 17 Sep 2026 12:00:00 GMT" });

  // Weak validators are forbidden in If-Range: two weak-equivalent
  // representations may differ byte for byte, which is exactly the difference a
  // resumed transfer cannot survive.
  const weak = ['HTTP/1.1 200 OK', 'ETag: W/"weak"', ""].join("\r\n");
  assert.equal(parseValidators(weak).etag, undefined);
});

test("writePartialState survives a reader catching it mid-write", () => {
  const { dir, partPath } = tempPart();
  try {
    writePartialState(partPath, { v: 1, urlHash: "a".repeat(32), etag: '"v1"' });
    // The temp file is renamed into place, so a reader sees the old state or
    // the new one, never a truncated one that would read as "nothing recorded".
    assert.equal(readPartialState(partPath)?.etag, '"v1"');
    assert.equal(existsSync(`${statePath(partPath)}.${process.pid}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A `--dump-header` file holds one block per response in the chain, and only
// the LAST one describes the bytes on disk. Carrying a validator forward from
// an earlier block records a validator for a response that never produced the
// body — and the next attempt sends it as `If-Range`, the server answers 200
// because it does not match, curl refuses to append (exit 33), and the resume
// silently becomes a full re-download.
const block = (status, ...headers) => [`HTTP/1.1 ${status}`, ...headers, ""].join("\r\n");

test("parseValidators: a redirect's ETag does not survive a final response without one", () => {
  const dump = block("302 Found", 'ETag: "abc"', "Location: /final") + block("200 OK", "Content-Length: 10");
  assert.deepEqual(parseValidators(dump), {}, "the final response described no validator, so neither do we");
});

test("parseValidators: a redirect's Last-Modified does not survive either", () => {
  const dump =
    block("302 Found", "Last-Modified: Wed, 17 Sep 2026 12:00:00 GMT") + block("200 OK", "Content-Length: 10");
  assert.deepEqual(parseValidators(dump), {});
});

test("parseValidators: the final block's values win over an earlier block's", () => {
  const dump =
    block("302 Found", 'ETag: "first"', "Last-Modified: Wed, 17 Sep 2026 12:00:00 GMT") +
    block("200 OK", 'ETag: "final"', "Last-Modified: Thu, 18 Sep 2026 09:00:00 GMT");
  assert.deepEqual(parseValidators(dump), {
    etag: '"final"',
    lastModified: "Thu, 18 Sep 2026 09:00:00 GMT",
  });
});

test("parseValidators: a weak ETag in the final block does not fall back to an earlier strong one", () => {
  const dump = block("302 Found", 'ETag: "strong"') + block("200 OK", 'ETag: W/"weak"');
  const result = parseValidators(dump);
  assert.deepEqual(result, {});
  // Absent, not present-and-undefined: the caller distinguishes "this response
  // carried no validator" from "no response yet", and a key holding undefined
  // reads as the first while looking like neither.
  assert.equal("etag" in result, false);
});

test("parseValidators: a final block keeps its own Last-Modified when its ETag is weak", () => {
  const dump =
    block("302 Found", 'ETag: "strong"') +
    block("200 OK", 'ETag: W/"weak"', "Last-Modified: Thu, 18 Sep 2026 09:00:00 GMT");
  assert.deepEqual(parseValidators(dump), { lastModified: "Thu, 18 Sep 2026 09:00:00 GMT" });
});

test("parseValidators: an HTTP/2 status line is a block boundary too", () => {
  const dump = ["HTTP/2 302", 'etag: "abc"', "", "HTTP/2 200", "content-length: 10", ""].join("\r\n");
  assert.deepEqual(parseValidators(dump), {});
});

test("parseValidators: a single block is unchanged", () => {
  const dump = block("200 OK", 'ETag: "only"', "Last-Modified: Thu, 18 Sep 2026 09:00:00 GMT");
  assert.deepEqual(parseValidators(dump), {
    etag: '"only"',
    lastModified: "Thu, 18 Sep 2026 09:00:00 GMT",
  });
});

test("parseValidators: 1xx interim blocks precede the final one and do not disturb it", () => {
  // Captured from curl 8.7.1 against a server sending 102 then 103 Early Hints.
  // Interim responses are dumped as their own blocks BEFORE the final one, so
  // each resets the accumulator and the final block still wins. The `Link`
  // header is here because a folded or bracket-heavy value must not be mistaken
  // for a status line.
  const dump =
    "HTTP/1.1 102 Processing\r\n\r\n" +
    "HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload; as=style\r\n\r\n" +
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nETag: "final"\r\nConnection: keep-alive\r\n\r\n';
  assert.deepEqual(parseValidators(dump), { etag: '"final"' });
});

test("parseValidators: a validator only an interim block carried is not kept", () => {
  const dump = 'HTTP/1.1 103 Early Hints\r\nETag: "early"\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n';
  assert.deepEqual(parseValidators(dump), {});
});

test("parseUnsatisfiedRangeTotal reads only the final block's unsatisfied range", () => {
  assert.equal(parseUnsatisfiedRangeTotal("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */10\r\n\r\n"), 10);
  assert.equal(parseUnsatisfiedRangeTotal("HTTP/2 416\ncontent-range:  BYTES */10 \n"), 10);
  // A redirect's or an interim response's header never describes the final one.
  assert.equal(
    parseUnsatisfiedRangeTotal("HTTP/1.1 302 Found\nContent-Range: bytes */10\n\nHTTP/1.1 416 Nope\n\n"),
    undefined,
  );
  assert.equal(parseUnsatisfiedRangeTotal("HTTP/1.1 100 Continue\n\nHTTP/1.1 416 Nope\nContent-Range: bytes */7\n"), 7);
  // A satisfied range is not a complete length claim.
  assert.equal(parseUnsatisfiedRangeTotal("HTTP/1.1 206 Partial\nContent-Range: bytes 0-4/10\n"), undefined);
  // Contradictory totals prove nothing, whichever comes last.
  assert.equal(
    parseUnsatisfiedRangeTotal("HTTP/1.1 416 Nope\nContent-Range: bytes */20\nContent-Range: bytes */10\n"),
    undefined,
  );
  assert.equal(
    parseUnsatisfiedRangeTotal("HTTP/1.1 416 Nope\nContent-Range: bytes */10\nContent-Range: garbage\n"),
    undefined,
  );
});

test("parseFinalStatus: the last block's status, and whether its headers are all in", () => {
  assert.equal(parseFinalStatus(""), undefined);
  assert.deepEqual(parseFinalStatus("HTTP/1.1 302 Found\r\nLocation: /x\r\n\r\nHTTP/2 200\r\n\r\n"), {
    status: 200,
    complete: true,
  });
  // A redirect hop alone, or a block still arriving, describes nothing on disk yet.
  assert.deepEqual(parseFinalStatus("HTTP/1.1 206 Partial Content\r\nETag: \"v1\""), { status: 206, complete: false });
  // curl writes each header line whole, so a block cut off mid-headers ends in
  // a newline too — that is not the blank line that closes it.
  assert.deepEqual(parseFinalStatus("HTTP/1.1 206 Partial Content\r\nETag: \"v1\"\r\n"), { status: 206, complete: false });
  assert.deepEqual(parseFinalStatus("HTTP/1.1 206 Partial Content\r\n"), { status: 206, complete: false });
  // Chunked trailers arrive through the same dump after the headers ended;
  // they do not make the response's headers incomplete again.
  assert.deepEqual(parseFinalStatus("HTTP/1.1 200 OK\r\nETag: \"v2\"\r\n\r\nDigest: x\r\n"), { status: 200, complete: true });
});

test("markPartialUnsafe that cannot write its marker removes the stale state instead", () => {
  // Disk full, say: the marker cannot be written, but an unlink still works.
  // Leaving the old state would keep a contaminated partial resumable.
  const dir = mkdtempSync(join(tmpdir(), "partial-unsafe-"));
  try {
    const partPath = join(dir, "file.bin.part");
    const url = "https://example.com/file.bin";
    writeFileSync(partPath, "junk");
    assert.equal(
      writePartialState(partPath, { v: 1, urlHash: urlFingerprint(url), resourceHash: resourceFingerprint(url), etag: '"v1"' }),
      true,
    );
    // A directory where the temp file must go makes the write fail.
    mkdirSync(`${statePath(partPath)}.${process.pid}.tmp`);

    assert.equal(markPartialUnsafe(partPath), false);
    assert.equal(existsSync(statePath(partPath)), false);
    assert.equal(mayResume(readPartialState(partPath), url), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
