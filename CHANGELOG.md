# Changelog

## 0.2.1

**A 202 to a resumed download keeps the partial.** 0.2.0 treated any non-206 2xx answer to
a resume as the server refusing the range, so a 202 ("not ready yet") reset the `.part`
and threw away the bytes already downloaded, and reported it as `network` ("cannot resume").
A resumed 202 now fails with `pending`, like a fresh one, and the partial is rolled back to
what was on disk before the request, so the retry resumes.

**Caller credentials no longer touch the disk.** The URL and `headers` (a signed URL, an
`Authorization: Bearer` token) used to sit in two `0600` files for a short window: the
runner's payload in `<statusDir>/<id>.payload.json` until the runner read it, and curl's
config in `<partPath>.curlrc`, beside the download, until curl's first output byte. A runner
killed inside either window left the secret behind in plain text. Both now travel only
through pipes: the payload on the runner's stdin, and curl's config on curl's (`curl -K -`).

Consumer notice: **the runner and `startDownload` must come from the same release.** The
runner now reads its payload from stdin, not from a path in argv. An extension that commits
a copy of the runner (`assets/raycast-downloader-runner.js`) must re-copy it with this
upgrade. A 0.2.0 runner started by 0.2.1 exits at once without transferring anything: the
download sits at the `starting` status `startDownload` seeds until the dead runner is
reconciled.

## 0.2.0

**A failed download no longer leaves an orphaned `.part.state`.** A request that failed
before its first byte (a 403, say) removed its empty `.part` and then wrote a `.state`
describing it. A terminal attempt now keeps a `.part` only when the file's own response
wrote its bytes, and removes its `.state` along with it (best effort).

**Status handling follows what curl actually does, not its exit code.** Measured, curl
exits 0 on each of these:

- **202, 204, 205, and a 206 to an unranged request** are no longer published; their body
  is discarded. A 202 fails with the new code `pending`.
- **A resumed request answered with a whole body** is no longer published as complete
  when it matches the partial's length (curl's "already downloaded", which kept the OLD
  version when `If-Range` produced the 200); the partial is cleared instead.
- **A 416 to a resume whose `Content-Range: bytes */N` equals the partial** publishes it
  rather than failing on every retry. Any other resumed 416 clears the partial.
- **An empty 200 fails** whatever `expectedBytes` or `sizeCheck` say, except
  `expectedBytes: 0`.

**Provenance is recorded only from the response that wrote the bytes.** A 403 to a
resume (a lapsed signed URL), a refused 200, or a redirect no longer overwrites the
partial's validators, so the signed-URL recovery keeps its resume. The mid-transfer
record waits for that response's complete headers, and the header dump now omits a
proxy's CONNECT response. With `resume: false`, an existing partial is cleared before the
transfer starts.

Consumer notice: **`DownloadErrorCode` gains `"pending"`** (retryable). Callers that
switch exhaustively on `DownloadErrorCode`, or key a `Record` by it, will see a compile
error, which is the intent.

## 0.1.5

**A redirect's `ETag` no longer describes bytes it never served.**

`parseValidators` folded every block of a `--dump-header` file into one object, updating
each field only when that field appeared. Its own comment claimed the last block wins —
but the rule it implemented was per-FIELD last-wins, not per-BLOCK. A 302 carrying an
`ETag` followed by a final 200 carrying none left the redirect's validator in place,
recorded against bytes that response never produced.

The cost lands on the next attempt, not this one. The stale validator goes out as
`If-Range`, the server finds it does not match and answers 200 instead of 206, curl
refuses to append (exit 33), and the runner resets the partial — so 0.1.4's resume
silently degrades to a full re-download. For the recordings this package was built for
that is 250–650 MB re-fetched to save nothing.

A status line now resets the accumulator, so only the final response's validators
survive. `HTTP/2 200` counts as a boundary alongside `HTTP/1.1 302 Found`. A weak `ETag`
in the final block deletes the field rather than setting it to `undefined`, so the key is
absent rather than present-and-empty, and it no longer falls back to an earlier block's
strong one.

**The same defect, one level up.** The code that writes the state file fell back to the
previously recorded validator whenever this response supplied none — which resurrected a
strong `ETag` from an unrelated earlier response exactly when the current one said
`W/"..."`, since a weak validator is dropped by design. A response's validators are now
the whole answer once there is a response at all, and the fallback applies only when this
attempt never got one.

That test is keyed on the header dump, not on the `.part` file's size. Measured: curl
buffers, so a transfer can be well into a response with the partial still reporting zero
bytes — the first version of this check used the size and kept the stale validator. A
header dump left behind by a runner that was killed mid-transfer is now cleared before
curl can write a new one, for the same reason.

**No action for consumers.** A `.state` file written by 0.1.4 may hold a redirect's
`ETag`. It repairs itself on first use: the resume is refused, the partial is reset, and
the next attempt records the right validator — the same one wasted download that
invalidating those files outright would have cost, so they are left alone.

## 0.1.4

**A resume now requires provenance, not just a byte count.**

`curl -C -` asks a server to continue from an offset. That request asserts the bytes
already on disk are a correct prefix of what is being fetched — an assertion nothing
downstream can check. Measured against a Range-capable local server: an 8-byte garbage
prefix resumes to exit 0, HTTP 206, and a published file reading `XXXXXXXX89ABCDEFGHIJ`
where the canonical body is `0123456789ABCDEFGHIJ`. Neither curl, nor the server, nor a
size check can see it, because every one of them is satisfied.

So what is known about a `.part` file is now recorded beside it, keyed by PATH rather
than by download id. Ids cannot protect a file: several can name one `outputPath`, a
retry routinely uses a new one, and a consumer can point an unrelated download at a path
another one left bytes in.

- `<partPath>.state` is durable. It records the URL these bytes came from (as a hash —
  a signed URL is a bearer credential and this file sits in the user's Downloads
  folder), the `ETag`/`Last-Modified` that describe them, and whether a previous attempt
  spoiled them. **A partial is resumed only when its recorded identity matches AND a
  validator was recorded** — including when the URL is byte-for-byte the same, because a
  stable URL is not a stable resource. Everything else restarts. Provenance is written as
  soon as the response headers arrive, so a runner that is SIGKILLed mid-transfer still
  leaves a resumable partial.
- A **re-signed URL still resumes**: identity is matched on origin and path with the
  query dropped, since the documented recovery from an expired link is to request a fresh
  one and continue. `If-Range` is what makes that weaker test safe.
- `<partPath>.claim` is the live-attempt claim. Created by writing the content to a
  temporary file and `link()`ing it into place, not by `open(path, "wx")` — an exclusive
  create makes an EMPTY file and fills it a moment later, and in that window a second
  process reads an empty claim, calls it abandoned, and takes the path while the first
  still believes it holds it. Each claim carries a token, so a release means "release
  mine" rather than "unlink whatever is here": a spawn `error` event fires after
  `startDownload` has thrown, by which time the caller may have retried and taken a new
  claim. A claim whose owner is provably dead is stolen; a damaged one is not, because
  with atomic creation an unreadable claim is damage rather than a race.

**`partialUnsafe` is now enforced, not merely reported.** 0.1.3 wrote the flag to the
status file and nothing consumed it. A status is addressed by id, so a retry — which
normally has a new id — never read it, and the contaminated partial was resumed onto
anyway. The marker now lives on the file, the runner clears it only after the bytes are
provably gone, and an attempt that cannot clear them fails instead of downloading.

**A second live download targeting one `outputPath` is refused** with the new
`conflict` error code, rather than racing the first. Refused rather than queued or
renamed: a queued download looks hung, and silently writing to a different filename than
the caller asked for is the override this package refuses to make elsewhere. Callers who
want a free name can get one from `uniquePath`.

**`If-Range` on every resume.** Same URL, same path, changed resource is the one splice
no marker can catch. With the recorded validator sent, a changed resource comes back 200
and curl refuses (exit 33) instead of appending; without it the server serves the new
bytes from the old offset and exits 0. Weak ETags are ignored, as RFC 9110 requires.

**`Range` and `If-Range` are refused as caller headers.** They are appended after the
generated ones, so a caller-supplied duplicate is what a server or proxy may act on —
and the resume guard then silently stops guarding. `startDownload` rejects them before
it claims a path or spawns anything.

**`killDownload` releases the claim when it records the outcome itself.** That is the
path where the runner was terminated without reaching its own cleanup — SIGKILL, or
`taskkill /T`, which delivers nothing catchable.

**curl exit 33 against a 2xx now resets the partial.** It means the server answered a
ranged request with a whole body, so those bytes can never complete this download —
retained, they made every retry fail the same way forever. Scoped to a 2xx: curl also
reports 33 for a 304, and a 304 says the partial is still valid.

### Consumer obligations

Nothing here is required to keep an existing caller correct — this release exists to
take these obligations away from callers. Two behaviours changed in ways worth knowing:

1. **`startDownload` can now throw `DownloadError` with `code: "conflict"`** when
   another live attempt holds the destination. Callers that catch and surface
   `DownloadError` already handle it; callers that switch exhaustively on
   `DownloadErrorCode` will see a compile error, which is the intent.
2. **A partial written by 0.1.3 or earlier will not be resumed** — it has no recorded
   provenance, so it is reset and the download restarts. One-time, per partial.
3. **A server that sends neither `ETag` nor `Last-Modified` can no longer be resumed.**
   Its transfers restart instead. Both headers are near-universal on the object storage
   that serves signed download links; a server that sends neither gives us nothing to
   check a resume against, and an unchecked resume is the splice this release exists to
   prevent.
4. **Passing a `Range` or `If-Range` header now throws** `DownloadError` with
   `code: "validation"` instead of being sent.
5. Three sidecar files may briefly exist next to a `.part` file (`.state`, `.claim`,
   `.headers`). They are removed on completion. A consumer that enumerates a download
   directory should not present them to the user.
6. **Version skew is not covered, and cannot be.** A 0.1.3 runner neither writes nor
   honours a claim, so a 0.1.3 and a 0.1.4 attempt running at the same time against one
   `outputPath` can still both write to it. Nothing added here can make an
   already-published version respect a file it has never heard of. Upgrade every consumer
   sharing a download directory.

## 0.1.3

**`partialUnsafe` on `DownloadStatus`: a machine-checkable "do not resume this file".**

0.1.2 added the case but not a way to detect it. When the runner writes a redirect body
into the partial and can then neither truncate it back nor delete it, the bytes on disk
must not be resumed — `curl -C -` would append the real download after the HTML. That was
only ever expressed as a sentence glued onto `error.message` and a `bytesDownloaded: 0`,
neither of which a consumer can branch on: zero also means an empty response and a failed
setup.

The flag is deliberately NOT a new error code and does not change the existing one. They
answer different questions: `error.code` is why THIS attempt failed (`http_client`, with
`httpStatus: 302`), `partialUnsafe` is whether the bytes on disk may be reused. A 304
against a resumed transfer proves they are independent — it fails while leaving a
perfectly valid partial behind.

Additive and optional, so no `schema` bump: the reader already accepts unknown fields. It
IS validated as a boolean when present, because a malformed value would otherwise read as
falsy and report a contaminated partial as safe.

**Absence is not proof of safety.** A runner from 0.1.2 or earlier cannot set this field,
so a status it wrote is silent on the question. That is unavoidable for any new signal.

**A rejected spawn no longer crashes the host command.** `spawn` reports ENOENT, EACCES and
EMFILE on the child's `error` event, asynchronously — the existing `pid === undefined`
check only ever caught the synchronous case. An `error` event with no listener is thrown
by EventEmitter, and it fires after `startDownload` has usually already resolved, so it
landed in the Raycast host rather than in the caller's `catch`. Measured on Node 22:
spawning a nonexistent executable returns `pid === undefined` AND emits `error: ENOENT` a
tick later, so both halves fire.

The listener is therefore attached before `child.pid` is inspected. With a pid, the
failure is reported the way every other runner failure is — a terminal `failed` status
with code `runner_failed`, which the watcher the caller already attached will see. Without
one there is no ticket and no valid status to write, so the thrown `DownloadError` stays
the whole contract.

**A redirect body that cannot be deleted is now flagged on a first attempt too.** 0.1.3's
first cut only set `partialUnsafe` when the transfer was resuming. On an initial download
the contaminated partial was discarded best-effort and the outcome ignored, so a denied
delete left redirect HTML on disk with nothing recording it — and `resume` defaults to
true, so the next attempt appended the real download to it. Same corruption the flag
exists to prevent, one path over.

**A malformed `partialUnsafe` is coerced to `true`, not used to reject the status.**
Reading it as falsy would report a contaminated partial as safe; rejecting the whole file
would make a live download invisible to `watchStatus` and un-cancellable through
`killDownload`. It is the only field treated this way — it is advisory, where every other
validated field is structural.

**README gains a quick-start recipe** for driving a toast and preference-gated console
logs from one `watchStatus` handler set, including the two things consumers get wrong —
logging the URL instead of the typed error code, and omitting `onAbandoned`, which leaves
a toast animating forever when the runner dies without recording an outcome.

## 0.1.2

**A rollback that cannot be verified now discards the partial instead of trusting it.**

After an unfollowed 3xx, curl has written the redirect BODY into the `.part`
file. On a resumed transfer the bytes before it are the user's real progress, so
the runner rolls the file back to that length rather than discarding it.

That rollback swallowed its own failure, with the note "the worst case is a
partial that a later resume rejects". That was an assumption about the consumer,
and a false one: consumers accept any non-empty partial. So if the truncate did
not land, the redirect HTML stayed on disk, and the next `curl -C -` appended the
real recording after it and published a corrupt file under the user's filename —
the same silent corruption that refusing to treat a 3xx as success exists to
prevent, arrived at one step later.

`rollbackPartial(partPath, keepBytes)` replaces it: it truncates, **verifies the
resulting size**, and returns false if it cannot vouch for the length — discarding
the partial in that case, so nothing can be appended to bytes we do not trust.
Verifying matters because a truncate that throws is obvious while one that leaves
the file longer than asked is not, and only the second corrupts the next resume.

`rollbackPartial` binds every step to one open file descriptor rather than
operating by pathname, so another attempt replacing the file mid-sequence cannot
have its healthy partial truncated or deleted. `keepBytes` is validated before
anything destructive runs — it is a caller-supplied number on an exported
function, and a negative value would otherwise turn bad input into deleted
progress.

When the partial cannot be deleted either, the runner records that in the status
(`bytesDownloaded: 0` and an explicit message) so consumers refuse to resume that
path. Nothing on disk can be fixed in that case, so the status is the mitigation.

Exported, so a consumer can use the same rollback rather than re-implementing it.

**Behaviour change:** the README previously promised partial files are always
retained. They are not, in this one case — see "Scope of the guarantee".

## 0.1.1

**`followRedirects` now actually works, and an unfollowed redirect is a failure.**

`buildCurlConfig` accepted and honored `followRedirects`, but nothing could reach it:
neither `StartDownloadOptions` nor the runner payload carried the field, so every
detached download followed redirects and the documented option was dead config. It is
now plumbed end to end (default unchanged: `true`).

Making it reachable exposed the reason it mattered. The runner's success predicate
treated any 3xx as success, so with redirects off curl wrote the redirect BODY to the
`.part` file, exited 0, reported 302 — and the stub was renamed to the user's expected
filename and published as a completed download.

**Success is now strictly 2xx, whatever `followRedirects` says.** `--location` only
follows a response carrying a usable `Location`, so a 304 (the caller sent a conditional
header) or a 300 is still the final status with redirects fully enabled — and a 304
writes no body at all, which on a resumed transfer would have published the existing
partial as if it were whole. When a transfer genuinely succeeds behind redirects, curl
reports the 2xx of the final hop, so nothing legitimate is rejected.

`classifyCurlFailure` gained a 3xx branch (`http_client`, non-retryable), worded for the
case at hand — unchanged (304), redirects disabled, or a redirect that could not be
followed. Previously an unfollowed redirect fell through to "Download failed (curl exit
0)." and a 304 surfaced as an ENOENT on the rename. The branch is gated on a clean curl
exit so a redirect loop keeps its own "Too many redirects" (exit 47).

Whatever a 3xx wrote into the `.part` file is rolled back — deleted outright when the
attempt started from nothing, truncated back to the pre-attempt byte count when it was
resuming. A redirect body is not resumable content, and a later retry would otherwise
have `continue-at`-ed past the HTML and spliced the real file onto it.

## 0.1.0

First release.

**Downloads that survive the Raycast window closing.** Raycast unloads a command's process
when the user presses Escape or pops back to root search, and an in-flight stream to disk is
torn down mid-write — leaving a truncated file that looks complete. `no-view` mode does not
help: it runs until its promise resolves, and the promise is the thing doing the downloading.

So the transfer runs in a detached child process that outlives the command and reports through
a status file on disk rather than through memory. `startDownload` returns a ticket; the user
can dismiss Raycast immediately; `watchStatus` picks the transfer back up from any later
command, in any other process.

**The guarantee is stated narrowly on purpose.** It survives Raycast dismissal, the command
being unloaded, and the parent process exiting. It does not survive machine sleep, power loss,
or unattended network drops without user action — detached spawn solves parent-process-exit,
which is the problem Raycast creates, and this is not a download supervisor. Partial files are
always retained, so an interrupted transfer resumes via HTTP Range instead of starting over.

**Two layers, deliberately independent.** Layer A (`status`, `detach`, `curl`) is the
transport, for extensions downloading from a URL. Layer B (`paths`, `errors`, `progress`,
`history`) is useful to any extension that puts a file on disk, however it got the bytes — so
a tool that owns its own transport, like `ipatool`, can consume Layer B without being forced
through a URL-shaped API that does not fit it.

**macOS and Windows.** `curl` ships with both. The supervision around the transfer differs
because the process models genuinely differ: `detached: true` + `unref()` versus `unref()`
alone, `kill(-pid)` on the process group versus `taskkill /T`, and two different ways to ask
the OS for a process's start time. `canVerifyProcessIdentity()` exposes which regime you are
in — and when identity cannot be established, "is it running?" falls back to the runner's
heartbeat while "should I signal this pid?" refuses outright, because guessing wrong about
liveness costs a mislabelled status and guessing wrong about identity kills an unrelated
process tree.

Zero runtime dependencies. `@raycast/api` is a peer accepting `^1.0.0 || ^2.0.0`, loaded lazily
so the runner and the tests work outside a Raycast host. The suite is run against v2.

### Notes for the first consumers

- **Never put a signed URL in `meta`** — it is persisted to the status file verbatim. Store an
  identifier you can re-resolve from instead. History has an opt-in
  `createDownloadHistory({ urlPolicy: "omit-signed" })`; the default is `"allow"`, which
  persists what you pass.
- **Retry policy is yours.** `DownloadError.retryable` gives you the signal; the loop stays in
  your code, because consumers differ too much to share one.
- **Copy `dist/runner.bundle.js`, not `dist/runner.js`.** A bundled extension that copies the
  plain `tsc` output gets a file that resolves but cannot run — its siblings are gone. The
  bundle has its local graph inlined for exactly this reason.
