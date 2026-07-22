# 0003 — Atomic 0600 write of `logindata.json`

## Status

Accepted (since v0.2.0, 2026-07-22).

## Context

`logindata.json` contains the CareLink OAuth tokens. With those tokens,
any local user on the host can act as the operator against CareLink:
read pump history, change pump settings, see patient-identifying data.

A previous version of the code saved the file with `fs.writeFileSync`,
which on a typical umask-022 system produced a file with mode `0644`
(world-readable). The bridge was therefore placing full CareLink
account credentials in a world-readable file by default. This was
discovered in the v0.1.0 review cycle.

There are two distinct problems:

1. **The write is non-atomic.** If the process is killed (SIGKILL,
   OOM, power loss) between `fs.writeFileSync` returning and the
   `fsync` that would make the data durable, the file can be left
   truncated or partially written. On next startup, `JSON.parse`
   throws and the operator has to re-run `npm run login`.
2. **The mode is wrong.** Even after the write completes, the file is
   `0644`. Any local user can `cat` it. There is no legitimate reason
   for a sibling process to read these tokens.

The previous "fix" was `fs.chmodSync(path, 0o600)` after the write.
This is **not safe**: there is a window between `writeFileSync`
returning and `chmodSync` running during which the file is
world-readable. A race-condition attacker (or a paranoid threat
model) considers that window sufficient.

## Decision

`writeLoginDataAtomic(filePath, data)` in `src/carelink/token.ts`:

1. Opens a temp file with `O_CREAT | O_EXCL | O_WRONLY` and `mode(0o600)`.
   - `O_EXCL` ensures the open fails if the temp file already exists
     (so we don't follow a symlink an attacker may have planted).
   - `mode(0o600)` is set at `open()` time, not via a subsequent
     `chmod()`. There is **no window** during which the file exists
     with looser permissions.
2. Writes the JSON, `fsync()`s the file descriptor, then closes it.
3. `fs.rename()`s the temp file over the destination. `rename` is
   atomic on POSIX when source and destination are on the same
   filesystem — the destination either holds the previous tokens
   or the new ones, never partial.
4. Refuses to write through a symlink. If the destination is a
   symlink, the rename would follow it, sending tokens to wherever
   the symlink points. The `O_EXCL` on the temp file prevents an
   attacker from racing the rename, but refusing the write outright
   is simpler and more obviously correct.

The destination's mode is irrelevant after a successful write because
`rename` preserves the source's mode, and the source was opened
`0o600`. A subsequent `tightenLoginDataIfLoose()` is called on the
**read** path (`loadLoginData`): if the file is older and was written
loose by a previous version, it is tightened in place. This is
idempotent (no-op on a `0o600` file) and runs every load, so an
upgrade from a pre-fix version is closed without a one-shot migration
step.

On Windows (`process.platform === 'win32'`), the tighten step is a
no-op because the default ACL is already user-only.

## Consequences

- **Easier:** A SIGKILL or power loss between fetch iterations
  cannot leave a truncated `logindata.json`. On next startup, the
  either the old valid file is there or the new valid file is
  there, never a half-written file.
- **Easier:** Operators who upgraded from a pre-fix version get
  their loose file closed automatically on the next `loadLoginData`.
  No "run this migration command" instruction in the upgrade notes.
- **Harder:** The temp-file + rename pattern is more code than
  `writeFileSync`. Reviewers have to verify the open flags, the
  `fsync`, and the rename order. The function's docstring records
  the threat model inline so a reader doesn't have to reverse-
  engineer it.
- **Harder:** A symlinked `logindata.json` (e.g. an operator who
  symlinked it into a backup directory) is **refused**. This is
  intentional — the symlink could point to a world-readable
  location. The error is loud; the operator can move the file off
  the symlink.

## What reverses it

- None should. The only thing that could "reverse" this is reverting
  to a world-readable file, which would be a security regression
  with no upside.
- If a future filesystem does not support atomic `rename` (extremely
  rare; not true of any POSIX system the bridge supports), the
  function would need a platform-specific fallback. The current
  implementation assumes POSIX; the `win32` tighten guard is the
  only platform branch, and it does not affect the write path.

## Notes

- Source: `src/carelink/token.ts` `writeLoginDataAtomic` docstring
  records the threat model and the design choices.
- v0.2.0 CHANGELOG entry documents the change.
- `test/atomic-write.test.ts` covers the open flags, the
  permissions, the symlink refusal, the crash safety, and the
  read-path tightening of pre-existing loose files.
- Related: the systemd unit's `ReadWritePaths=` is set to the
  directory, not the file, so the bridge can both rewrite
  `logindata.json` on token refresh AND delete it on permanent
  refresh failure. A per-file grant would have broken the
  delete path with `EBUSY` — see PR #19 (commit history) for the
  investigation.
