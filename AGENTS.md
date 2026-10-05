# AGENTS.md

`@chrismessina/raycast-downloader` — downloads for Raycast extensions that survive the window
closing. Zero runtime dependencies; `@raycast/api` is a peer, loaded lazily.

Public API and design rationale: `README.md`. Current branch state, open tasks and publish
gating: `HANDOFF.md` (read it before touching anything — it is written per-wave and is more
current than this file).

Documented solutions to past problems (bugs, workflow patterns) live in `docs/solutions/`,
organized by category with YAML frontmatter (`module`, `tags`, `problem_type`) — relevant when
implementing or debugging in a documented area. `CONCEPTS.md` holds the shared domain
vocabulary: runner, status file, Layer A/B, reservation, lease, attempt identity.

## Commands

```bash
npm run build      # tsc + scripts/bundle-runner.mjs  → dist/ and dist/runner.bundle.js
npm test           # build, then node --test test/*.test.mjs (hits the real network)
npm run test:unit  # same with SKIP_INTEGRATION=1
npm run typecheck  # tsc --noEmit
```

`npm test` builds first (`npm run build && node --test`), so it never tests stale output.
Running `node --test test/*.test.mjs` directly does not — build yourself if you go that way.
The suite hits the real network; `SKIP_INTEGRATION=1` (what `test:unit` sets) skips that.

## The load-bearing fact

**Every Raycast command is a separate OS process with no shared memory.** Two commands can act
on the same download id at once. In-process mutexes fix nothing here; synchronization must be
cross-process — that is what `src/lock.ts` (`withFileLock` / `withFileLockSync`) exists for. It is
built on `open(path, "wx")`, and four things about it are load-bearing rather than incidental:
each acquisition stamps the file with an ownership **token**, so release and steal only ever
unlink a file still carrying the token they expect; a lock is stolen as stale only when its owner
is gone **and** its mtime is past `staleMs`; "owner is gone" means `(pid, startedAtMs)` — a bare
pid would be recycled and wedge the lock forever, and when start time is unresolvable it falls
back to mtime alone rather than assuming the owner lives; and async holders heartbeat the lock
while they work, because `history.ts` deliberately holds it across `await`s. Reentrancy is
synchronous-only (`acquireLease` → `writeStatus` on one path would self-deadlock without it);
concurrent **async** callers serialize instead, since "this process holds it" is not the same
claim as "I am nested inside it". Most defects found in this package trace back to code
that forgot this. Any read-modify-write of a file that a second process could also touch goes
through a lock.

## Layout

| File | Layer | Role |
|---|---|---|
| `src/status.ts` | A | status files on disk, liveness, leases, `watchStatus` polling |
| `src/detach.ts` | A | `startDownload` / `killDownload` / `reconcile`; spawns the runner |
| `src/curl.ts` | A | curl config building + meter/write-out parsing |
| `src/runner.ts` | A | the detached child. Runs outside the Raycast host |
| `src/paths.ts` | B | `expandHome`, `isContained`, `resolveDirectory`, `uniquePath`, … |
| `src/errors.ts` `src/progress.ts` `src/history.ts` | B | errors, formatting, history records |
| `src/lock.ts` | — | cross-process file lock, used by both layers |

Layer A is for extensions that download from a URL. **Layer B must stay usable on its own** —
a tool that owns its transport (`ipatool`: no URL, picks its own path, emits no progress)
consumes B without being forced through a URL-shaped API. Don't make B depend on A.

## Invariants

- **Zero runtime dependencies, permanently.** `dist/runner.bundle.js` must bundle standalone;
  the detached process cannot resolve the package's own `node_modules`. Never add a dep, never
  import `@chrismessina/raycast-kit` from here — it is published (0.2.0, live on npm) and does
  export `formatBytes`/`formatSpeed`, and that is *still* not a reason to depend on it. The
  duplication is the deliberate trade: fifteen lines of arithmetic beats coupling the runner to
  another package. Leave it.
- **`src/runner.ts` must not import `@raycast/api`.** It runs outside the host. Anything it
  imports gets inlined by the bundler, so its import graph stays `node:*` + local modules.
- **`@raycast/api` is always lazily `require`d**, never a top-level import — the runner and the
  tests run outside Raycast.
- **Process identity is `(pid, startedAtMs)`, never a bare pid** (`src/status.ts:247-250`, matched
  within a 2s tolerance). pids recycle; `kill(-pid)` on a bare pid can take out an unrelated
  process group. Note `startedAt` is a different field — the download's start, not the process's.
- **Credentials never touch argv or disk.** The URL and the caller's headers (a signed URL, an
  `Authorization: Bearer` token) travel through pipes only: `startDownload` writes the payload to
  the runner's stdin (`src/detach.ts:326`), the runner reads it to EOF (`src/runner.ts:111`), and
  curl is spawned as `curl -K -` with its config on stdin (`src/runner.ts:387`). `ps` is
  world-readable, and a file outlives a process killed before it can unlink it. That is why
  0.2.1 retired the old `<id>.payload.json` and `<part>.curlrc` files. Do not reintroduce a
  file for either, not even a `0600` one: `test/secrets-off-disk.test.mjs` SIGKILLs a runner
  mid-window and scans for the secret.
- **Bytes land in `<outputPath>.part`, renamed only after size verification.** A truncated file
  must never look like a successful one.
- **No breaking API changes.** Do not remove or rename an export or change a signature;
  additive optional params only. `raycast-fathom` consumes this today.
- **A documented security property with no mechanism is a defect, not a docs nit.** (History
  claimed signed URLs were never persisted; nothing enforced it. Now `urlPolicy` does.) **The
  mirror of that is equally a defect: a responsibility the caller really has that nothing tells
  them about.** Layer A writes to the `outputPath` it is given and never calls `isContained` or
  `sanitizeFilename` on it. That is deliberate — the user chooses the destination, and
  constraining it would be wrong more often than right — so do NOT "fix" it by enforcing
  containment. It is documented under "Notes for consumers" in `README.md` instead, with a
  worked example. Keep it documented; if you change the behaviour, change that section first.
  Note `isContained(candidate, root)` takes the candidate FIRST — reversing it rejects valid
  paths rather than admitting invalid ones, so it fails loudly, but it is still wrong.

## Working style here

- **Witnessed red.** Write the failing test, confirm it fails, then fix. Report verification by
  pasting the actual command output, never by asserting you checked.
- Race fixes are provoked with **real spawned processes**, not by asserting a mutex exists —
  see `test/races.test.mjs` and `test/fixtures/`.
- Some races are too rare to test (see the `uniquePath` sidecar note in `HANDOFF.md`). Be
  precise about what a test does and does not cover; don't add a 1-in-100k stress test.
- **Never touch git state** (`add` / `commit` / `stash` / `checkout` / `restore` / `reset`)
  without being told to. The tree is deliberately dirty across concurrent sessions. If a
  command incidentally rewrites the lockfile, say so and leave it.
- Commits are SSH-signed via the 1Password agent. A signing failure while it's locked is
  expected — stage, note it in one line, move on. Never `--no-gpg-sign`.
- **No `npm publish` without an explicit per-publish go-ahead.** A version can't be reused.
- No Claude attribution in anything public — no PR body, issue, or session URL. A
  `Co-Authored-By` commit trailer is fine.
