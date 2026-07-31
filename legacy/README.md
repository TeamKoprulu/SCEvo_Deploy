# Legacy scripts — do not run

Superseded by the deploy tool in [`../tools/`](../tools/). Start it with
[`../run.cmd`](../run.cmd).

Kept only until the new tool has completed one successful real deploy, then
delete this folder.

## Why they were retired

These are not merely obsolete — running them today will damage production:

- **`deploy-to-r2.ps1`** uploads `manifests` *before* `payload`. For the whole
  duration of a 1.1 GB push, the CDN advertises hashes and sizes for bytes that
  are not there yet, so every user who launches in that window gets a failed
  download. It also rewrites `deploy-config.json` from a template containing
  only `launcherRepoPath`, destroying `sc2InstallPath` and `showVersionDebug`.

- **`build-manifests.ps1`** prompts `Enable critical update?` with a default of
  **No** and pulls no default from the existing manifest, so one forgotten
  keystroke sets `criticalUpdate.enabled` to `false` in production. It also
  prompts for a download URL on every file ≥ 100 MB and defaults it to a dead
  GitHub Releases link — which Enter accepts, and which the launcher actively
  prefers over the working R2 URL.

- **`build-sc2files.ps1`** corrupts its own veto list. `Load-Ignored` ends with
  `return [string[]]$parsed`, and PowerShell's `return` unrolls a one-element
  array to a scalar string — so with exactly one veto on file, `$ignored += x`
  performs string concatenation instead of an array append and destroys the
  first entry. Veto is also only offered for brand-new files, and there is no
  un-veto.

- **`build.ps1`**, **`zip.ps1`**, **`Build.mpq2k`** were already dead before
  this change: hardcoded file lists, obsolete mod names, and the 1000-slot MPQ
  limit that silently drops files from large mods.

The `.cmd` wrappers resolve their `.ps1` via `%~dp0`, so they still work from
this folder — which is exactly why the warning above matters.
