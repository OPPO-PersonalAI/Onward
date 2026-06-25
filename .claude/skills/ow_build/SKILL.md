---
name: ow_build
description: Build the Onward dev app from the command line, with two modes the user picks EXPLICITLY (there is no default — invoked bare, stop and ask which). `--dev` does a fast clean dev build (`rm -rf out release && pnpm dist:dev`, reusing the existing node_modules) and launches it so the user can experience a change in the real app. `--clear` does a full clean-slate validation — wipes the tree back to a fresh-clone state (removes node_modules + out + release + gitignored test scratch), then runs a fresh `pnpm install` to PROVE the whole postinstall chain (Electron heal, electron-rebuild, node-pty, ripgrep, @parcel/watcher) completes with zero manual intervention, verifies every native module is present and bundled, rebuilds, and launches to confirm the renderer process actually comes up. Use this skill whenever the user wants to build / compile / package the dev app, "编译开发版本", "体验一下", build to see a change in the real app, or validate the build / compilation environment is correct from scratch (after a dependency bump, a build-script change, or before a release). Cross-platform by construction: every step gives both macOS and Windows commands. ow_full_regression_test's `--clear-build` opt-in routes its build through `ow_build --clear`.
---

# ow_build

Two modes the user MUST pick explicitly — when invoked with no argument, do not
guess: stop and ask whether they want `--clear` or `--dev`.

- **`--dev`** — fast dev build + launch to experience. Reuses the existing
  `node_modules`, wipes only `out`/`release`, runs `pnpm dist:dev`, then launches
  the app for the user to try. The common, high-frequency path.
- **`--clear`** — clean-slate validation (rebuild from scratch). Resets the repo
  to a fresh-clone state (removes `node_modules` + `out` + `release` + gitignored
  test scratch), runs a fresh `pnpm install` to PROVE the whole postinstall chain
  completes with zero manual intervention, verifies every native module, rebuilds,
  and launches to confirm the renderer actually comes up. This is the only
  trustworthy way to validate "is the build environment correct" after a
  dependency / build-script change or before a release.

## Hard rules (both modes)

1. **Cross-platform is the floor, not a follow-up.** Design every step for
   **Windows AND macOS** at the same time (this repo also supports Linux, whose
   commands usually match macOS). Each step below gives both forms: PowerShell on
   Windows, POSIX on macOS/Linux. Never "macOS first, port to Windows later".
2. **Kill processes by EXACT name only.** macOS `pkill -x "<exact>"`; Windows
   `taskkill /IM "<exact>.exe" /F`. NEVER a wildcard / substring selector — a
   loose one kills the user's Claude Code session, other branch builds, unrelated
   helpers. Helper child processes are reclaimed by the OS when the main process
   exits; do not kill them yourself.
3. **Run long commands in the background and wait for the notification — never
   poll.** `pnpm install` and `pnpm dist:dev` are minutes-long. Launch them as
   background commands (`run_in_background: true`), wait for the single completion
   `task-notification`, then read the result ONCE. Do not `tail -f`, do not
   repeatedly `Read` a half-written log — the closing summary lands only at the
   very end, so a poller races the writer and reads partial state.
4. **Do NOT pipe `pnpm install` through `| tail` (or any pipe).** A pipe replaces
   the exit code with the pipe-tail command's exit code, MASKING an install
   failure (this repo has hit exactly that: install showed exit 0 while its
   postinstall had failed). Run `pnpm install` plainly so the real exit code
   surfaces.
5. **The smoke-test signal is the renderer process, not the main process.** Main
   process alive != entered main UI — the main process can survive while the
   window fails to load (a `require` throws before the BrowserWindow's content
   loads). The honest "launch succeeded" signal is "a `--type=renderer` helper
   process exists and stays alive a few seconds", which proves web content
   actually loaded.

## Phase 0 — Preflight: derive names and paths

All later commands use these.

**macOS / Linux:**

```bash
REPO_ROOT="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" && pwd)"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
APP_NAME="Under Development ${VERSION}-${BRANCH}"
APP_DIR="$REPO_ROOT/release/mac-arm64/${APP_NAME}.app"          # arm64; x64 -> mac/
APP_BIN="$APP_DIR/Contents/MacOS/${APP_NAME}"
UNPACKED="$APP_DIR/Contents/Resources/app.asar.unpacked"
```

**Windows (PowerShell):**

```powershell
$RepoRoot = (git rev-parse --show-toplevel)
$Version  = (node -p "require('$RepoRoot/package.json').version")
$Branch   = (git rev-parse --abbrev-ref HEAD)
$AppName  = "Under Development $Version-$Branch"
$AppExe   = "$RepoRoot\release\win-unpacked\$AppName.exe"
$Unpacked = "$RepoRoot\release\win-unpacked\resources\app.asar.unpacked"
```

> The dev product name is always `Under Development <package.json version>-<branch>`
> (e.g. `Under Development 2.0.1-master`).

---

## Mode `--dev` — fast dev build + launch to experience

Goal: reuse the existing `node_modules` and produce a launchable dev build as
fast as possible, then launch it. Does NOT reinstall (that is `--clear`'s job).

### Steps

1. **Kill the old instance (exact name).**
   - macOS: `pkill -x "$APP_NAME" 2>/dev/null; sleep 0.5`
   - Windows: `taskkill /IM "$AppName.exe" /F 2>$null`
2. **Clean build (wipe only `out`/`release`, keep `node_modules`).** Background,
   wait for the notification.
   - macOS/Linux: `cd "$REPO_ROOT" && rm -rf out release && pnpm dist:dev`
   - Windows: `Remove-Item -Recurse -Force -EA SilentlyContinue out,release; pnpm dist:dev`
   - The build rule requires the wipe and `pnpm dist:dev` in ONE command (so you
     never package against stale artefacts).
3. **Smoke test.** After a successful `pnpm dist:dev` the build auto-opens the
   packaged app (`ONWARD_DIST_DEV_OPEN=0` disables it). Wait a few seconds, then
   confirm `--type=renderer` is present and stable via
   [renderer smoke](#renderer-smoke-both-platforms).
4. **Report.** Artefact path, version/branch, whether the renderer came up. Leave
   the app running for the user to experience.

---

## Mode `--clear` — clean-slate validation (rebuild from scratch)

Goal: return to a "just cloned" state and PROVE the build environment is correct
— a fresh `pnpm install` completes the postinstall chain with zero manual
intervention, every native module is present and bundled, and the build launches
with the renderer up. This is the only trustworthy validation after a dependency
/ build-script change.

### Step 1 — Reset to fresh-clone state

1. Kill the old instance (same as `--dev` step 1, exact name).
2. Remove build artefacts + `node_modules`:
   - macOS/Linux: `rm -rf out release node_modules`
   - Windows: `Remove-Item -Recurse -Force -EA SilentlyContinue out,release,node_modules`
3. Wipe test scratch (via the repo's supported cleaner — gitignored scratch only):
   - macOS/Linux: `python3 scripts/clean-test-data.py --yes`
   - Windows: `py scripts/clean-test-data.py --yes`
4. **Keep the Electron cache** so install re-EXTRACTS instead of re-downloading
   (faster, and it exercises the extraction + self-heal path that is exactly what
   `--clear` should validate):
   - macOS: `~/Library/Caches/electron/` (do not delete)
   - Windows: `%LOCALAPPDATA%\electron\Cache\` (do not delete)

### Step 2 — Fresh `pnpm install` (validate the whole postinstall chain)

Background, wait for the notification, read once. **No `| tail`** (hard rule 4).

```bash
pnpm install            # same on macOS/Linux and Windows
```

This is `--clear`'s decisive checkpoint. Read the output and confirm the
postinstall chain ran FULLY with no mid-chain exit 1:

| Expected log line | Meaning |
|---|---|
| `[electron] Binary OK …` or `[electron] Re-extracted OK …` | Electron health check passed (`scripts/ensure-electron-binary.js` largest-file probe); chain not aborted |
| `✔ Rebuild Complete` | `electron-rebuild better-sqlite3` ran (chain continued) |
| `[node-pty] Added executable bit …` | node-pty spawn-helper step ran |
| `[ripgrep] Binary OK …` | ripgrep step ran |

> If postinstall aborts at the electron gate with `exit 1` and the later
> `electron-rebuild` / node-pty / ripgrep steps get skipped — that is a REAL
> environment / build-script defect, not something to "manually re-run the skipped
> steps and move past". The entire value of `--clear` is surfacing exactly this
> "only-shows-up-on-a-clean-install" class of defect. Report it; do not paper over
> it by hand-running the skipped steps.

### Step 3 — Native-module inventory (both platforms)

Confirm each is present; a missing one means the environment is incomplete.

```bash
# Cross-platform: electron health (has win/mac/linux branches, prints Binary OK)
node scripts/ensure-electron-binary.js
```

| Module | macOS path | Windows path |
|---|---|---|
| better-sqlite3 | `node_modules/better-sqlite3/build/Release/better_sqlite3.node` | same |
| node-pty | `node_modules/node-pty/prebuilds/darwin-arm64/pty.node` | `…/prebuilds/win32-x64/pty.node` |
| ripgrep | `node_modules/@vscode/ripgrep-darwin-arm64/bin/rg` | `node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe` |
| @parcel/watcher | `node_modules/@parcel/watcher-darwin-arm64/watcher.node` (+ top-level symlink) | `node_modules/@parcel/watcher-win32-x64/watcher.node` |

> Platform packages are filtered by `os`/`cpu`/`libc`: each platform installs only
> its own (`*-darwin-arm64` on macOS, `*-win32-x64` on Windows). The others being
> absent from disk is EXPECTED, not a miss.

### Step 4 — Clean build

Background, wait for the notification. Same as `--dev` step 2:

- macOS/Linux: `cd "$REPO_ROOT" && rm -rf out release && pnpm dist:dev`
- Windows: `Remove-Item -Recurse -Force -EA SilentlyContinue out,release; pnpm dist:dev`

> **Stop on a COMPILE failure — it is a code signal, not an environment chore.**
> If `pnpm dist:dev` fails to COMPILE here (TypeScript error, broken import,
> electron-vite / electron-builder rejecting the source, a bad build-config
> change), STOP and report it as a real code defect — do NOT retry, do NOT
> self-heal, do NOT proceed to launch. Steps 1–3 already wiped and reinstalled
> a clean tree, so the usual environment causes (stale `node_modules`, ABI
> drift, a skipped postinstall step) are already ruled out: a compile failure on
> a fresh tree means the SOURCE genuinely does not build. Retrying only burns the
> reinstall again and hides the bug. (A failure BEFORE the compiler runs — `pnpm`
> missing, disk full — is an environment blocker you may heal once and re-run;
> the compiler having run and rejected the source is not.)

### Step 5 — Verify the packaged app contains the native modules

The thing electron-builder most easily drops is a platform-specific native module
(this repo hit `@parcel/watcher` not bundled into `asar.unpacked` -> launch
crash). Confirm this platform's `.node` made it into `app.asar.unpacked`:

- macOS: `find "$UNPACKED" -path '*parcel*watcher*' -name '*.node'` -> expect
  `@parcel/watcher-darwin-arm64/watcher.node`
- Windows: `Get-ChildItem -Recurse "$Unpacked" -Filter *.node | Where-Object FullName -match 'parcel.*watcher'`
  -> expect `@parcel/watcher-win32-x64/watcher.node`

Also list every `.node` (better-sqlite3 / node-pty / parcel should all be there)
as an overview.

### Step 6 — Launch + strong renderer smoke (closing step)

`--clear` MUST end with a launch check — "environment correct" has to land on
"the app actually starts".

1. Kill the old instance (exact name) -> launch:
   - macOS: `open "$APP_DIR"`
   - Windows: `Start-Process "$AppExe"`
2. Wait 6–8 s, confirm `--type=renderer` exists via
   [renderer smoke](#renderer-smoke-both-platforms); re-check a few seconds later
   to confirm it is NOT crash-looping; check for no new crash report.

### Step 7 — Report the environment-validation verdict

State plainly: did the postinstall chain run with zero intervention, is the
native-module inventory complete, did the parcel `.node` get bundled, did the
renderer come up and stay up. One-line conclusion: "can a fresh machine now run
`pnpm install && pnpm dist:dev` and get a launchable app?"

---

## renderer smoke (both platforms)

Main process alive does not count — look for a `--type=renderer` helper process.

**macOS:**

```bash
ps -Axo args | grep -F "$APP_NAME Helper" | grep -v grep \
  | grep -oE -- '--type=[a-z-]+' | sort | uniq -c
# expect: 1 --type=renderer (plus gpu-process / utility)
```

**Windows (PowerShell):**

```powershell
Get-CimInstance Win32_Process -Filter "Name = '$AppName.exe'" |
  Where-Object { $_.CommandLine -match '--type=renderer' } |
  Measure-Object | Select-Object -ExpandProperty Count
# expect >= 1
```

> Note: `grep "Helper (Renderer)"` treats the literal parens as a regex group and
> won't match the literal `()` — use `grep -F` (fixed string) or match on the
> `--type=renderer` command-line flag instead.

---

## No argument → stop and ask

When `ow_build` is invoked without `--clear` / `--dev`, do NOT build by default.
Reply asking the user to pick:

> ow_build needs an explicit mode: `--dev` (fast build + experience, reuses
> node_modules) or `--clear` (delete node_modules and reinstall from scratch to
> validate the whole compilation environment)?

Why no default: `--clear` deletes `node_modules` and triggers a minutes-long
reinstall, so an accidental trigger is costly; the two modes differ enough in
intent that the user should choose deliberately.

---

## Integration with ow_full_regression_test

Full regression runs its own **light** `--build` by default (wipe `out`/`release`
+ `pnpm dist:dev`, reusing `node_modules`) — fast and enough for routine use.

When the user passes `ow_full_regression_test --clear-build`, run **`ow_build
--clear`** first (full wipe + reinstall + native-module check + build + launch
verification), then run the regression runners against that freshly-produced,
validated package (the regression does not need its own `--build` here, because
`ow_build --clear` just did a clean `dist:dev` seconds earlier, so the package is
provably fresh). Use it before a release / after a dependency or build-script
change, when the regression should run from a "fresh machine" posture. The cost
is one extra reinstall per run (~6–15 min), so it is opt-in, not the default.
