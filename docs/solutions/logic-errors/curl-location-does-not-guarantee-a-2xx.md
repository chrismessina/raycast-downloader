---
module: transport
date: 2026-09-17
problem_type: logic_error
component: service_layer
severity: high
symptoms:
  - "A redirect stub is renamed to the user's filename and published as a completed download"
  - "`followRedirects` is accepted and documented but has no effect on any download"
  - "A 304 surfaces as `ENOENT: no such file or directory, rename '<file>.part'`"
root_cause: wrong_api
resolution_type: code_fix
framework_version: "curl 8.7.1 (macOS 15), node 20"
related_components:
  - testing_framework
tags:
  - curl
  - redirects
  - http
  - resume
  - runner
  - data-integrity
---

# `--location` does not guarantee a 2xx, and a 3xx is never a downloaded file

> **Citations refreshed 2026-09-18 and again 2026-10-04.** Eight of the nine `file:line`
> references here pointed at unrelated code after the 0.1.4 resume-safety work moved things in
> `runner.ts` and `curl.ts`. Every one still *resolved* — in range, valid file — which is why a
> path checker reports a document like this as clean. Each now names the symbol as well as the
> line, so the next drift is visible to a reader rather than only to whoever re-runs the greps.
> The 2026-10-04 pass also follows 0.2.0, which replaced the `httpOk` predicate and the
> `redirectStub` rollback quoted below with a status-based rule. The guidance stands; the
> mechanism moved, and the Solution names both.

## Problem

The runner's success predicate accepted any 3xx as success:

```ts
const succeeded = exitCode === 0 && (httpCode === undefined || (httpCode >= 200 && httpCode < 400));
```

The reasoning behind it is seductive and wrong: *"with `--location` curl reports the final hop, so
a 3xx can only mean redirects were off — and that's the caller's choice."* Both halves fail. The
first because `--location` only follows a response carrying a usable `Location`; the second
because an unfollowed redirect is a **failure**, not a permissive outcome — curl has written the
redirect *body* to the output file and exited 0.

## Symptoms

Measured against a local server returning `302 → /final` with redirects disabled:

```
exitCode: 0 | httpCode: 302
runner.ts:273 verdict: SUCCESS  <- the bug
file written: YES (18 bytes: "<html>moved</html>")
```

That stub is then renamed to the user's expected filename and recorded as `completed`. The
download the user asked for is 18 bytes of HTML wearing the name of a video.

Two of the three defects were invisible from the runner alone. `followRedirects` was honored by
the config builder (`src/curl.ts:144`, `lines.push("location")`) and defaulted there (`src/curl.ts:111`, the `followRedirects = true` default), but neither
`StartDownloadOptions` nor the runner payload carried the field, so nothing could reach it: the
option was public, documented, and dead. And with the predicate fixed, an unfollowed 302 fell past
the `>= 400` branch in `classifyCurlFailure`, past `EXIT_CODES[0]` (undefined), and into the
last-resort message — reporting `Download failed (curl exit 0).` for the one outcome that has a
perfectly good explanation.

## What didn't work

**Making the predicate conditional on `followRedirects`.** The obvious repair, and the one already
shipped in the consuming extension:

```ts
const httpOk = httpCode >= 200 && (followRedirects ? httpCode < 400 : httpCode < 300);
```

It still trusts "redirects on ⇒ no 3xx survives". An adversarial review found the hole:
`--location` follows a response only when it carries a `Location` curl can use, so with redirects
**fully enabled** two statuses reach the runner as themselves.

- **304 Not Modified**, when the caller passed a conditional header (`headers` is a public option).
  A 304 carries **no body at all**. On a resumed transfer that means the `.part` file is left at
  exactly its previous length — which then passes every downstream check and publishes a partial
  file as if it were whole.
- **300 Multiple Choices**, which has a body and no `Location`. Same shape as the disabled-redirect
  case, with the option set to `true`.

Measured before the fix, a 304 with `sizeCheck: "advisory"` did fail — but on the rename, with
`ENOENT: no such file or directory, rename '.../out.bin.part'`, because curl never created a file
for a bodyless response. Failing for an unrelated reason is not the same as being handled, and it
is not something a consumer can act on.

## Solution

**Success is strictly 2xx, whatever `followRedirects` says.** As shipped in this fix:

```ts
const httpOk = httpCode === undefined || (httpCode >= 200 && httpCode < 300);
const succeeded = exitCode === 0 && httpOk;
```

Nothing legitimate is lost: when a transfer genuinely succeeds behind redirects, curl reports the
2xx of the final hop.

0.2.0 narrowed it further, by the same reasoning one band down: not every 2xx is the file either.
202, 204, 205 and an unrequested 206 are refused too, and one 416 (a resume whose partial is
already whole) is accepted. The predicate is now `wroteTheFile(httpCode)` (`src/runner.ts:518`,
`httpOk`; the rule itself is `wroteTheFile` beside `settlePartial`). A 3xx is still never the file.

**Classify the 3xx, and word it for the case at hand** (`src/curl.ts:364`, the 3xx branch in `classifyCurlFailure`, and `unfollowedRedirectMessage` at `src/curl.ts:428`) —
unchanged (304), redirects disabled, or a redirect that could not be followed. The branch is gated
on `exitCode === 0`, because curl exits **47** on a redirect *loop* while still reporting a 3xx
`http_code`; an ungated branch relabels "Too many redirects" as "redirects are disabled".

**Roll back whatever the 3xx wrote.** Shipped as a `redirectStub` branch; since 0.2.0 it is
`settlePartial` (`src/runner.ts:332`), which applies the same rollback to every response that did
not write the file, 3xx included. The redirect body is never resumable
content, so a retry would `continue-at` past that HTML and splice the real file onto it — the
exact silent corruption `fail` (rather than `fail-with-body`) exists to prevent, reached one step
later. The rollback is a truncate back to the pre-attempt byte count when resuming, so a user's
real progress survives; an outright discard when the attempt started from nothing.

**And verify the rollback.** Shipped one commit later (`src/paths.ts:427`, `rollbackPartial`): the
first version swallowed its own failure, reasoning that "the worst case is a partial that a later
resume rejects". That is an assumption about the consumer, and consumers accept any non-empty
partial. A truncate that *throws* is obvious; one that leaves the file longer than asked is not,
and only the second corrupts the next resume. `rollbackPartial` truncates, re-`stat`s, and
discards the partial when it cannot vouch for the length — and when it can do neither, the runner
reads that failure, marks the partial unsafe on disk (`src/runner.ts:345`, inside `settlePartial`),
and says so in the status as `partialUnsafe`.

## Why this works

`--location` is not "resolve this URL for me". It is "follow a `Location` header when you get
one". Every assumption of the form *"with redirects on, X can't happen"* is an assumption about
what the server sends back, and the server is not a party to your config file.

The deeper pattern: `curl --fail` fails on `>= 400` only, so the 3xx band is a gap that neither
`--fail` nor `--location` closes. Anything that treats "curl exited 0" as "I have the file" owns
that gap itself.

## Prevention

**Assert on the range you actually want, not the range that excludes the errors you thought of.**
`< 400` was written as "not an error". The useful predicate is "is this the body I asked for",
which is `2xx` and nothing else.

**A plumbed-through option needs a test that proves it left the caller.** The easy failure mode
here is a green test that never exercised the new field — every test passes because the *default*
happens to match. Two things are needed:

```js
// 1. The option reaches the runner payload at all (a stub runner captures the
//    payload it reads from stdin).
assert.equal(payload.followRedirects, false);

// 2. And the behaviour differs end to end. This one fails if the plumbing is
//    reverted, because curl would follow the redirect and complete.
assert.equal(status.state, "failed");
```

Both live in `test/redirects.test.mjs`, alongside a **legacy-payload** test: a payload written by
the previous version carries no `followRedirects` field, and the runner must read that absence as
"follow" (`src/runner.ts:357`, `payload.followRedirects ?? true`). An in-flight download must not
fail because the package was upgraded underneath it.

**Test the 3xx band with a local server, not a live redirector.** `test/redirects.test.mjs` runs a
`node:http` server that serves 302, 304, and 300 from one handler, so the whole band is hermetic
and runs offline. One trap worth knowing: **`spawnSync` blocks the event loop**, so a same-process
test server can never answer the request — the first repro of this bug appeared to be a 20-second
`max-time` timeout (curl exit 28) until the child was spawned asynchronously.

**Check what curl does under `-C -` before asserting a resume path failed for your reason.** A 304
against a resumed transfer never reaches the 3xx branch at all: curl exits **33** ("does not
support resuming") first. The outcome is the same — failure, partial preserved — but a test
asserting the redirect wording there tests a path that does not exist.
