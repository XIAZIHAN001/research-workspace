# Installed Windows runtime acceptance checkpoint

Status: **integrated; latest Windows acceptance FAIL before application launch**. Run `42212710072` on checkpoint `88d1c79b` passed hosted preflight, same-build installer selection, silent installation and installed-version checks, then failed the resource-hash comparison. Application/WebView2 checks and screenshots were **NOT RUN**. The correction below still needs its own hosted execution. This separate checkpoint adds acceptance scripts and workflow steps, with no application-code changes. Execution results must be checked for its exact commit before claiming a runtime pass.

## Safety and scope

This gate is exclusively for a **fresh GitHub-hosted `windows-latest` job**, with no real workspace, real API key, or parallel Research Workspace test. It rejects non-Windows, self-hosted, missing runner metadata/explicit opt-in, existing application directories, uninstall registrations, application/sidecar processes, or any Credential Manager target beginning `ResearchWorkspace`. Metadata is a workflow guard, not cryptographic proof against someone deliberately spoofing the environment. Do not opt in on a user machine.

The image guard accepts the legacy `win` + digits form and the single additional documented identifier `win25-vs2026`. It does not accept arbitrary suffixes or relax the hosted-runner, opt-in, metadata, commit or source checks. The exact [20261030.294 image manifest](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/Windows2025-VS2026-Readme.md) identifies Windows Server 2025 image version `20261030.294.1`; that release's [image generator](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/helpers/GenerateResourcesAndImage.ps1) sets `ImageOS` to `win25-vs2026`, and [system-environment setup](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/scripts/build/Configure-SystemEnvironment.ps1) persists it.

Run `42210528782` on commit `0035ee07` stopped in build-marker mode on that image. The previous image regex demonstrably rejects its official identifier. The run's first/only failing assertion cannot be recovered because its guard error was replaced by a generic code and its marker report was not retained. Reports now identify `stage: build-marker` versus `stage: runtime`, and known guard codes are preserved in both the report and a sanitized `TERMINAL` console line. Unknown guard error text is not echoed. No environment dump is needed.

Windows Known Folders are read with `SHGetKnownFolderPath`, including both Roaming and Local AppData. Redirecting `APPDATA`/`LOCALAPPDATA` is not an isolation boundary. Credential Manager is scoped to the OS account. The test uses the fresh VM's actual empty profile and current provider target `ResearchWorkspace/Provider/{provider}`.

Missing WebView2, a usable desktop, or CDP/window attachment is BLOCKED / **NOT RUN**, with a nonzero exit. The harness does not install/downgrade WebView2, bypass execution policy, disable security settings, use development executables, call a real model endpoint, or delete unexpected data. The already-installed runtime must be present before silent installation; consumer prerequisite installation remains untested.

Covered runtime checks:

- Match source version, HEAD, tree, GitHub run and attempt to a pre-build marker; require clean source and exactly one fresh x64 NSIS installer. Record SHA-256, version and source identity.
- Install that artifact silently under a unique explicit `RUNNER_TEMP` directory. Require exit code 0, real installed EXE/sidecar/launcher, installed version and whole-file hashes matching the expected NSIS payload described below. No fallback.
- Launch the installed EXE with an allowlisted environment and Windows-only PATH. Attach Playwright to its real WebView2 using CDP and wait on `ai_service_info`, not an obsolete badge.
- Verify Mock mode, the owned installed sidecar, authenticated health and a synthetic offline answer, plus unauthenticated rejection.
- Capture actual Home and 设置 → AI 服务 screenshots with the current 离线模拟 control. No key is present when screenshots are taken.
- Generate a fake key in memory; prove its exact atomic credential record hash; check status, normal-close cleanup, restart persistence and saved endpoint. Switch online against the reserved `windows-smoke.invalid` hostname without issuing a model request. Reject changing the active saved-key endpoint; delete the active key, require a replacement Mock sidecar and old-sidecar exit; force-exit the shell, verify natural sidecar exit, restart and confirm no key resurrection.
- Perform independently bounded process, synthetic-credential and CDP cleanup, then write the final report. Observed-process termination checks PID, executable path and exact creation time through one open OS handle. Each app/installer launch retains its `ChildProcess` immediately, before the first fallible snapshot. If observation fails, Windows-only cleanup can stop that root through its retained native child handle, never by a fresh PID lookup; unverified descendants still force `owned-cleanup: FAIL` and `cleanupIncomplete: true`, even when root termination succeeds. Native identity JSON round-trip is checked before installation. No global process-name kill exists. Credential cleanup deletes only the current provider record if its complete blob hash matches this test's generated fake record. Synthetic installation/profile directories are left for VM disposal.

**Explicitly NOT RUN/out of scope:** clean consumer Windows 10/11 prerequisites, upgrade/uninstall, installer-dialog UX, PDF import/reading UI, backup export/restore UI, all real or paid upstream calls. Passing this narrow gate is not release approval. Screenshot capture is evidence, not a claim of human visual review.

## Installed payload identity

The pinned [Tauri CLI 2.12.3 bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle.rs) replaces the **first** `__TAURI_BUNDLE_TYPE_VAR_UNK` byte sequence with `__TAURI_BUNDLE_TYPE_VAR_NSS` before NSIS packaging, then restores the original build-tree EXE. Its [NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) includes that patched file directly. Raw installed-versus-restored-EXE hash equality was therefore an incorrect harness assumption.

The gate reads the actual installed `node_modules/@tauri-apps/cli/package.json` version and supports only this reviewed `2.12.3` mapping. It copies the build EXE bytes in memory and applies exactly that first-marker replacement. It compares the entire expected buffer's SHA-256 and length with the untouched installed file. A missing build marker, unsupported CLI version, unpatched installed EXE or any other byte difference fails closed. Existing NSS constants are allowed; neither marker uniqueness nor replacement of all occurrences is assumed. Node sidecar and launcher hashes still require exact, unmodified build-byte equality. Signing or custom packaging that introduces other changes requires a separately reviewed mapping, not broader normalization or excluded byte ranges.

Reports retain installer exit/version and all three roles' raw build and installed hashes, sizes, expected packaged hashes, comparison method and match results before a comparison can throw. Unsupported mapping or missing-marker errors leave the main EXE's expected hash unavailable with a classified error; they do not hide the other roles' raw hashes. No file contents, paths containing user data, credential payloads or environment dumps are added.

Run `42212710072` logged successful NSIS bundle-type patching. Static extraction of its SHA-256-verified installer found an EXE containing two NSS markers and no UNK marker, consistent with one original NSS constant plus the documented replacement. No Windows executable was run during that inspection. The old report did not retain individual resource hashes, so the exact first failing comparison and whether another resource also differed cannot be proven retrospectively. The new diagnostics and next hosted run must resolve that remaining uncertainty.

## Workflow integration

Do not run these commands locally. Do not reuse `desktop-isolated.mjs` or `desktop-phase11.mjs` for this gate.

This checkpoint follows the green P1 checkpoint. Keep `runs-on: windows-latest`, set a job timeout, and retain the existing locked dependency install, frontend/sidecar preparation and Rust checks. On the **same fresh job**, add a build-start marker immediately before the existing NSIS build, then run the new gate immediately after a successful build. Do not download an unrelated installer or reuse cached installers/markers. Do not run jobs in parallel in the same OS account.

The existing Windows workflow uses the following same-job sequence:

```yaml
# Both these steps belong in the existing fresh windows-latest job.
- name: Record exact Windows build start
  id: windows_build_marker
  env:
    RW_WINDOWS_FRESH_RUNNER: 'yes'
  run: node scripts/verify/windows-runtime.mjs --record-build-start
- name: Build Windows Tauri NSIS installer
  run: npm run desktop:build -- --bundles nsis
- name: Installed Windows runtime acceptance
  timeout-minutes: 10
  env:
    RW_WINDOWS_FRESH_RUNNER: 'yes'
  run: node scripts/verify/windows-runtime.mjs
- name: Retain sanitized Windows runtime report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: research-workspace-windows-runtime-${{ github.sha }}
    path: .cache/windows-runtime/**/report.json
    include-hidden-files: true
    if-no-files-found: error
    retention-days: 14
- name: Retain synthetic Windows screenshots
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: research-workspace-windows-runtime-screenshots-${{ github.sha }}
    path: .cache/windows-runtime/**/*.png
    include-hidden-files: true
    if-no-files-found: warn
    retention-days: 14
```

The marker records commit/tree/version/run/attempt/start time under `RUNNER_TEMP/rw-windows-build-start.json`, refuses to overwrite an existing marker and refuses old installers. A marker-only NOT RUN report is separate under `.cache/windows-runtime-build/`; it is retained as a separate diagnostics artifact, never merged with runtime evidence or counted as a runtime PASS. Missing-opt-in refusal probes from portable tests report separately under `.cache/windows-runtime-refused/`, so they cannot be confused with the opted-in acceptance artifact. The gate rejects a stale (>1 hour) or source-mismatched marker, mismatched version, older artifact, ambiguous artifact, changed source, or unexpected location.

The runtime has an 8-minute work budget and separately reserved cleanup phases totaling at most about 40 seconds. IPC/attachment/process operations are bounded. An initial NOT RUN report is written before testing, and the final report is written in `finally`; final process exit prevents leaked child/CDP handles from hanging the job. A CI cancellation, host crash or I/O failure can still interrupt finalization: the initial incomplete report is never PASS. Do not use `continue-on-error`, tolerate exit 2 as success, or infer success from a screenshot alone.

Runtime exit codes: **0 PASS**, **1 FAIL**, **2 NOT RUN/BLOCKED**. Build-marker mode exits 0 only to authorize the subsequent build, never to claim a runtime pass. Required checks must all be PASS; excluded checks remain explicitly NOT RUN. Review the exact reported commit/tree/installer hash and both screenshots before promoting the checkpoint. If a run fails after installation, rerun on a new hosted VM, never delete preexisting directories/credentials to make the same VM pass.

Upload only the report and listed synthetic screenshots. Do not upload raw profiles, environment/argv dumps, credential contents, Playwright traces/HAR, crash dumps, or arbitrary application logs. Console evidence contains counts only. Driver debug channels (`DEBUG`, `PWDEBUG`, `NODE_DEBUG`, `NODE_OPTIONS`) are rejected before credential work. Inspect `cleanupIncomplete`/`cleanupFailures` on failures; never broaden cleanup to other PIDs or credentials.

## Portable preparation checks

```sh
npx vitest run scripts/verify/windows-runtime-helpers.test.mjs
npm run check
node --check scripts/verify/windows-runtime.mjs
```

Portable tests exercise runner denial, same-job artifact identity/freshness, installed-only resource paths, exact first-marker payload derivation, unrelated byte mutations and raw-resource mismatches, unsupported CLI/missing-marker refusal, retained per-role failure diagnostics, process identity/PID reuse and descendant ownership, malformed snapshots, injected first-observation failures/timeouts/missing roots for both launch paths, and fail-closed sanitized report/cleanup status. They **do not** validate PowerShell/PInvoke on Windows, NSIS command handling, the actual WebView2 session, Windows Credential Manager, UI screenshots or runtime process behavior. The current correction's hosted execution remains pending; application/WebView2 checks have not yet run.

References: [Playwright WebView2 CDP](https://playwright.dev/docs/webview2), [NSIS installer command line](https://nsis.sourceforge.io/Docs/Chapter3.html). NSIS `/S` is case-sensitive; `/D=<absolute path>` is last and unquoted even when the directory contains spaces. No `/NCRC` flag is used. The Windows-only retained-handle fallback follows [libuv Windows `uv_process_kill`](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c); it never calls PID-based `process.kill`.
