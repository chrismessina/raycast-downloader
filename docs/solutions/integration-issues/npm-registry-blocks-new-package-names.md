---
module: publishing
date: 2026-09-16
problem_type: integration_issue
component: development_workflow
severity: high
symptoms:
  - 'npm publish fails with: E400 "That word is not allowed"'
  - "The same failure repeats after editing the README and description"
  - "The package page 404s because the package was never created"
root_cause: external_service_policy
resolution_type: config_change
related_components:
  - infrastructure
  - tooling
framework_version: "node 20 (CI runner), npm 10.9.8 (local)"
tags:
  - npm
  - publishing
  - package-naming
  - registry
  - github-actions
  - release
---

# npm silently blocks certain words in NEW package names

## Problem

The first publish of `@chrismessina/raycast-download` was rejected by the npm registry with an
opaque content-filter error. The package name contained a word npm refuses to let you *create* a
package with. No amount of editing the README, description, or keywords fixes it, and the error
text does not say which word is at fault.

## Symptoms

```
npm error code E400
npm error 400 Bad Request - PUT https://registry.npmjs.org/@chrismessina%2fraycast-download
  - That word is not allowed. Please contact support at https://npmjs.com/support
    if you believe you received this in error.
```

The publish step runs to completion — it builds the tarball, prints the file list, and even signs
and logs a provenance attestation — before the registry rejects the `PUT`. That ordering makes it
look like a late/flaky failure rather than a naming problem.

## What didn't work

Three things, each of which cost a round trip:

1. **Editing the README.** The packument sent on publish includes the README, so prose is a
   plausible suspect. The only flag-prone token in it was `ipatool` (an App Store IPA fetcher).
   Rewording it changed nothing — same E400.
2. **Reasoning about which word it is.** npm does not publish the blocklist. Two rounds of
   "what in this metadata looks piracy-adjacent?" produced plausible candidates and no answer.
3. **Staged publishing.** It looks tailor-made for this — publish, inspect, promote or discard —
   but the docs rule it out for exactly this case: *"Package must exist: The package you're
   configuring must already exist on the npm registry."* Staging cannot serve a **first** publish.
   It also would not have been a free probe: *"Staged packages share the same semver version
   unique index as published packages"*, so a stage consumes the version until `npm stage reject`.
   (It additionally needs npm >= 11.15.0 and Node >= 22.14.)

## Solution

**Bisect by publishing byte-identical content under a different name.** Change exactly one
variable — the `name` field — and let the registry answer:

| Name | Content | Result |
|---|---|---|
| `@chrismessina/raycast-xfer-probe` | identical | **published** |
| `@chrismessina/raycast-download-probe` | identical | **E400 "That word is not allowed"** |

That isolates the name in one run. A second probe then distinguishes whole-word from substring
matching, which decides what you are allowed to rename *to*:

| Name | Result |
|---|---|
| `raycast-download` | blocked |
| `raycast-downloader` | **allowed** |

So the filter matches **whole words, not substrings**. `download` is blocked; `downloader` is not.

The fix was renaming the package to `@chrismessina/raycast-downloader` (and the GitHub repo to
match; GitHub redirects the old URL).

## Why this works

The filter applies to **package creation**, not to publishing a new version of a name that already
exists. That is why `mongodb-download-url` and `@xhmikosr/downloader` keep shipping versions
happily while a brand-new `raycast-download` cannot be created at all — and why searching npm for
existing packages with the word in their name is misleading evidence that the name is fine.

It is an anti-abuse heuristic catching a false positive on a legitimate download-resumption
library. npm's own error invites an appeal to support.

## Prevention

**Validate the name against the registry before you build anything around it.** The name ends up
in far more places than `package.json`, and each one is cheap to change before the first publish
and expensive after:

- runner/asset resolution paths hardcoded in source (`src/detach.ts` searches
  `node_modules/@scope/<name>/dist/...`)
- any file a consumer copies out of the package (here, `raycast-downloader-runner.js`)
- override environment variables (`RAYCAST_DOWNLOADER_RUNNER`)
- the fallback state directory (`~/.raycast-downloader`)
- the GitHub repo name, and `repository`/`bugs`/`homepage` in the manifest

**A failed publish costs nothing, so make the real publish the probe.** npm only consumes a
version number on *success*. Five rejected attempts at `0.1.0` left it fully reusable. This
inverts the usual instinct to build a safe test harness: publishing the actual package under the
candidate name is both the test and the ship, and it leaves no junk package behind needing
cleanup. Only fall back to a throwaway probe name when you need to vary something you are not
willing to ship.

**If you do publish a probe package, you cannot clean it up from CI.** Unpublishing requires 2FA,
and an automation token is specifically forbidden from it:

```
npm error 403 Forbidden - DELETE .../raycast-xfer-probe
  Granular access tokens that bypass two-factor authentication may not perform this action.
```

The same 2FA-bypass property that lets the token publish also blocks it from unpublishing. A human
must remove it interactively or via npmjs.com, within the 72-hour window.

## Other publish failures that look like this one

Each is a distinct cause with a similar shape — an opaque registry rejection late in a publish.
The first two preceded the name problem in this same release; the third bit a sibling package
earlier and is the easiest of all to misread:

**`EBADPLATFORM` on `npm ci`.** `package.json` declares `"os": ["darwin", "win32"]`, and `npm ci`
enforces that field against the *root* package — so a `ubuntu-latest` runner fails before it can
install anything:

```
npm error notsup Unsupported platform for <pkg>: wanted {"os":"darwin,win32"} (current: {"os":"linux"})
```

Keep the `os` field — it is what stops a Linux consumer installing something that cannot work —
and move the runner instead (`.github/workflows/publish.yml:28` is `runs-on: macos-latest`). macOS
runners are free on public repos.

**`EOTP` on publish.** A classic **Publish** token still requires a one-time password when the
account enforces 2FA for writes. Only a **Granular Access Token** or a classic **Automation**
token bypasses it:

```
npm error code EOTP
npm error This operation requires a one-time password from your authenticator.
```

Note the trade-off with the unpublish restriction above: the token type that can publish
unattended is precisely the one that cannot unpublish.

**A 404 on publish usually means auth, not a missing package.** npm answers `PUT` on a *scoped*
package with 404 rather than 401/403, so that private package names cannot be probed. An expired
or revoked token therefore surfaces as "Not Found" on a package you know exists. This cost a
separate session on raycast-kit 0.2.0 (2026-09-10) before it was traced to a stale `_authToken` in
the user-level npmrc; `npm whoami` returning 401 is the quick confirmation, and
`npm login --scope=@chrismessina` the fix.

Read-only access is anonymous, so `npm view <pkg> version` still answers correctly while writes
fail — which is what makes the 404 so convincing. **Do not use a 404 to conclude a package does
not exist when you are authenticating.** The inverse also caught this session out: immediately
after a *successful* publish, the packument 404s for several minutes (~4 here) while the versioned
endpoint `https://registry.npmjs.org/<pkg>/<version>` already returns 200. That one is ordinary
CDN propagation, not auth.

**Since 0.2.0 (2026-09-30) the versioned endpoint lags too.** `npm publish` now ends with `npm
notice Your package is being processed and may take a few minutes to become available.` before
the `+ <pkg>@<version>` line. Until processing finishes, `GET …/<pkg>/<version>` answers
`"version not found: <version>"` and `dist-tags.latest` still names the previous version. Both
0.2.0 and 0.2.1 appeared within a few minutes. The `+ <pkg>@<version>` line is the proof the
publish succeeded; to know when consumers can install it, poll `dist-tags.latest` (or `npm view
<pkg> version --prefer-online`) rather than trusting either endpoint's first answer.
