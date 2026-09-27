# TODO

## Keep caller headers off disk

**Problem.** A caller's `headers` are written to disk twice before curl reads them, both as 0600
files:

1. `startDownload` writes `<statusDir>/<id>.payload.json` (`src/detach.ts`, `writeSecretFile`). The
   runner unlinks it once it has read it (`src/runner.ts`, `unlinkSync(payloadPath)`).
2. The runner writes `<partPath>.curlrc` (`src/runner.ts`, `buildCurlConfig` → `writeSecretFile`)
   **next to the `.part` file, in the destination folder** (for most callers, `~/Downloads`). It's
   unlinked at curl's first output, or by a fallback timer.

If Raycast, the runner, or the machine dies inside either window, the header stays on disk in
plain text. For `raycast-mercury` that header is `Authorization: Bearer <Mercury API token>`,
used whenever a statement's `downloadUrl` answers directly from `api.mercury.com` without
redirecting. Codex flagged it as a P1 on the Mercury Store submission (2026-09-26). Mercury
shipped as is because the windows are short and the fix belongs here, in the shared package.

**Fix options,** in order of preference:

- **Pass secrets through a pipe instead of a file:** write the payload to the runner's stdin, and
  have curl read its config from stdin (`curl -K -`), so neither file exists.
- **Keep the files but out of the destination folder:** write `.curlrc` into `statusDir`, never
  beside the `.part`, and sweep stale `*.payload.json` / `*.curlrc` at the next `startDownload`.
- Document a `sensitiveHeaders` option that forces one of the above, if a general fix costs too
  much.

**Done when:** a test kills the runner between spawn and curl's first byte, and no file under
`statusDir` or the destination folder contains the header value.
