---
module: transport
date: 2026-09-18
problem_type: logic_error
component: service_layer
severity: critical
symptoms:
  - "A resumed download completes with exit 0 and HTTP 206 and publishes a corrupt file"
  - "The corrupt file passes every size check because its length is exactly right"
  - "A `partialUnsafe` flag is written to the status file and nothing ever reads it"
root_cause: data_integrity
resolution_type: code_fix
framework_version: "curl 8.7.1 (macOS 15), node 20"
related_components:
  - data_model
  - testing_framework
tags:
  - curl
  - resume
  - http-range
  - data-integrity
  - if-range
  - concurrency
---

# A range request is a promise about bytes you already have

## Problem

`curl -C -` sends `Range: bytes=N-`. That is not a question, it is an **assertion**: the
first N bytes on disk are already a correct prefix of the resource being fetched. Nothing
downstream can check it. The server answers the range it was asked for, curl writes it at
the offset, and the result has the right length.

So any code that resumes on the strength of a byte count alone is deciding, on the user's
behalf, that whatever is in that file belongs there.

## Symptoms

Measured against a Range-capable local server (curl 8.7.1), canonical body
`0123456789ABCDEFGHIJ`:

| seed on disk | server | exit | http | resulting file |
|---|---|---|---|---|
| 8 real bytes | honours Range | 0 | 206 | `0123456789ABCDEFGHIJ` ✓ |
| **8 bytes of `XXXXXXXX`** | honours Range | **0** | **206** | **`XXXXXXXX89ABCDEFGHIJ`** ✗ |
| 8 real bytes | ignores Range (200) | 33 | 200 | untouched, curl refuses |
| 8 real bytes, stale `If-Range` | answers 200 | 33 | 200 | untouched, curl refuses |

Row 2 is the whole problem. curl is satisfied, the server is satisfied, an
`expectedBytes` check is satisfied — the length is exactly right — and a file with eight
bytes of someone else's content at the front is renamed to the user's filename and
recorded as a completed download.

Rows 3 and 4 are the lever: when the server answers a ranged request with a **whole
body**, curl refuses (exit 33) and leaves the file alone. It never splices a 200 onto a
partial. Every *splice* is a 206.

One exception surfaced later (0.2.0): when the whole body is exactly as long as the partial,
curl exits **0**, calls it "already downloaded", and keeps the partial untouched. With a stale
`If-Range` that partial is the OLD version, and a runner that trusts exit 0 publishes it. Nothing
is spliced, yet the wrong bytes ship. The runner now treats a resumed whole-body 2xx as "cannot
resume" and clears the partial, whether curl exited 0 or 33. The exception is a 202 ("not ready
yet"), which says nothing against the bytes on disk and keeps them (0.2.1) (`src/curl.ts:378`, `src/runner.ts:539`).

## What didn't work

**Recording the hazard instead of preventing it.** The previous release detected the case
that contaminates a partial (an unfollowed redirect writes the redirect body into it) and
wrote `partialUnsafe: true` to the status file. Nothing consumed it. A status is addressed
by download id, a retry normally has a *new* id, and so the next attempt read a byte count
and resumed onto the HTML anyway. The flag described the corruption in a file nobody
opened on the path where it mattered.

The general shape is worth naming: **a fact recorded under one key cannot protect a
resource keyed by another.** Statuses are per-attempt; the `.part` file is per-path, and
several attempts, ids, and even unrelated downloads can point at one path.

**Scanning statuses by output path.** The obvious repair, and it cannot be made correct:
statuses are addressed and locked by id, several can name one output path, statuses get
pruned, and nothing takes a per-path lock before spawning. A consumer had already built
this and it was the reason the fix belonged in the package.

## Solution

Bind what is known about the bytes to the **path**, beside the file:

- `<partPath>.state` — durable. URL fingerprint, `ETag`/`Last-Modified`, and an `unsafe`
  flag. See `src/partial.ts:150` (`mayResume`) for what it takes to permit a resume.
- `<partPath>.claim` — the live-attempt claim (`src/partial.ts:305`, `claimPartialPath`).

Four rules, each of which a measurement or a review forced:

**1. A resume needs identity AND a validator** (`src/partial.ts:150`). Not identity alone,
even when the URL matches byte for byte — a stable URL is not a stable resource
(`latest.zip`, a regenerated export, a redirect that now points elsewhere). The recorded
identity is of the *request* URL while the bytes came from whatever the final hop served.
`If-Range` (`src/curl.ts:157`) is the only part of this the server participates in, and it
converts row 2 into row 4: a changed representation comes back 200 and curl refuses.

**2. Identity ignores the query string** (`src/partial.ts:127`, `resourceFingerprint`). This one is a trap in the
other direction: hashing the whole URL is obviously "safer" and it silently breaks signed
links, where the documented recovery from expiry is to request a fresh signature and
continue. Every signed download would restart from zero — undoing the feature the rule was
protecting. Matching origin + path is weaker, and `If-Range` is what makes it safe.

**3. Write provenance when the response arrives, not when the transfer ends**
(`src/runner.ts:421`). Since 0.2.0, only the response that *wrote* the bytes counts: provenance is
recorded once that response's headers have fully landed. A 403 on a resume, a refused 200, or a
redirect hop leaves the partial's existing validators in place. The transfers that most need a resumable partial are the ones with
no ending: a SIGKILLed runner, a machine that slept and never woke the process. Recording
at exit would mean the crash cases produce exactly the partials that can never be resumed.

**4. Claim the path, not the id** (`src/partial.ts:305`, `claimPartialPath`). Two downloads with different ids
can name one `outputPath`, and the second one's `-C -` appends to the first one's bytes.
Leases and status locks are both id-scoped and see none of it.

## Why this works

It moves the decision to the only participant that can make it. The server knows what it
is serving; curl knows what it asked for; **only the process that wrote the prefix knows
what the prefix is.** Provenance recorded beside the file is that knowledge, written down
where the next attempt — which may be a different process, a different id, or a later
version — will actually look.

The `If-Range` half is the server's participation, and it is genuinely load-bearing rather
than belt-and-braces: it is what makes the weaker origin+path identity test safe enough to
use, which is what keeps signed-URL resume working.

## Prevention

**Ask what a protocol feature ASSERTS, not what it requests.** `Range` asserts a prefix.
`If-None-Match` asserts a cached copy. `continue-at` asserts both. Every one of them is a
claim the client makes and the server takes on trust, which means the client owns the
correctness.

**A guard the caller must invoke is not a guard.** The two releases before this one each
added an optional field to a public type that consumers had to read and act on, and every
existing consumer kept compiling while being silently wrong. If a rule protects data,
enforce it where the data is touched; if it genuinely must be the caller's, make it a
compile error rather than a field they can miss.

**Write the control test.** `test/resume-safety.test.mjs` runs raw `curl` against the same
server to prove the splice is still reachable. Without it, every safety assertion in that
file could pass because curl changed, because the test server stopped honouring Range, or
because the fixture drifted — and a suite that passes for the wrong reason is worse than
no suite. The same file asserts the server actually received `bytes=8-` on a legitimate
resume, because a provenance rule that quietly disabled resume everywhere would satisfy
every safety test in it.

**Exclusive create is not atomic publication.** `open(path, "wx")` makes an EMPTY file and
the content lands a moment later; a reader in that window sees a claim it will call
malformed. Write the content to a temp file and `link()` it into place
(`src/partial.ts:393`). The same applies to any lock, marker, or sentinel whose *content*
is what other processes read.

**A release must name its holder.** Releasing by pathname means "unlink whatever is here",
and a late handler from a failed attempt will delete the claim a retry has since taken. A
token in the file, checked before unlinking, is the difference.

**Two liveness biases, opposite directions, same codebase.** For a *status*, assume a
process is alive when identity cannot be proven — calling a live download dead fails it
while bytes are still arriving. For a *claim*, assume alive too, but for the opposite
reason: calling a live holder dead puts two writers on one file. When you copy a liveness
check between contexts, re-derive which error is worse rather than reusing the bias.

## Related

- `docs/solutions/logic-errors/curl-location-does-not-guarantee-a-2xx.md` — the defect that
  contaminates a partial in the first place, and the reason `unsafe` exists at all.
