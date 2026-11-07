# Installed Windows runtime acceptance checkpoint

Status: **candidate token rejected by the strict ordinary-user policy; predicate diagnostics added, awaiting hosted classification**. [Run `42225263617`](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42225263617) on checkpoint `7b1f8654` passed installation, version and all three payload comparisons. It measured the app as elevated/high integrity and the owned WebView browser process with no debugging flags; CDP remained connection-refused. All ten tracked process identities were positively cleaned up, but application interaction, synthetic credentials, independent normal/forced-exit acceptance and screenshots were **NOT RUN**. This checkpoint tests that measured privilege blocker without changing application code, WebView protection overrides or production DevTools settings.

## Candidate-policy rejection on `7f7b2d3`

[PR run `42240041533`](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42240041533) tested checkpoint `7f7b2d3` through merge commit `3e8580a3`. The bridge compiled and **67 native synthetic tests passed**. Source-token reads/account checks, SAFER token derivation, primary-token duplication and the integrity-adjustment stage completed. The probe then failed at `validate-token` with `TOKEN_REJECTED`, numeric error `0` and no predicate detail. This proves the earlier scalar-query blocker was passed, but does not identify which candidate-policy requirement failed or prove that SAFER produced an acceptable ordinary-user token.

No job or child was created; the build and installed-app acceptance were skipped. The new diagnostics classify each existing candidate-policy predicate: same identity/session, primary type, non-elevation, exact medium integrity, UIAccess/SandboxInert, group authority and deny-only preservation, privilege subset/activation and the privilege allowlist. They use only fixed field/reason labels. No SID, authentication ID, privilege name or raw attribute is reported, and no new native read is added. Predicate evaluation and loop order, acceptance conditions and all launch/security behavior remain unchanged. The next probe must identify the precise incompatibility; a genuine policy mismatch will remain a blocker rather than trigger a weaker gate or fallback launch.

## Fixed-size token query correction after `74290a6`

[PR run `42238096155`](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42238096155) tested checkpoint `74290a6` through merge commit `db702ed8`. Its bridge compiled and **57 native synthetic tests passed**, then the probe failed at `caller-token`: `TOKEN_REJECTED`, field `elevation`, reason `size-query-error`, Windows error **24 (`ERROR_BAD_LENGTH`)**. This identifies the failed operation as the generic NULL/zero-buffer sizing query for `TokenElevation`, not rejection of an observed elevation value or account identity. SAFER, child launch, the build and application acceptance were not reached.

Microsoft defines [TOKEN_ELEVATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_elevation) as one DWORD. The [information-class contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class) also defines the existing session, SandboxInert and UIAccess queries as DWORDs, and token type as `TOKEN_TYPE`. [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation) accepts the corresponding typed buffer and reports the needed length; it does not promise error 122 for every NULL/zero sizing request.

The correction uses one direct four-byte query only for the five existing fixed-size classes `{8, 12, 15, 20, 26}`. API success and returned length exactly four are required before reading the value. Unknown classes, failed calls and malformed lengths are refused. Variable-size queries retain their existing strict sizing checks. There is no generic acceptance of error 24, retry/fallback, value normalization or change to token identity, elevation, integrity, group or privilege requirements.

The native regression supplies a synthetic query that rejects NULL/zero elevation requests with error 24 and checks that the production scalar reader instead performs exactly one non-null four-byte request. It also covers all five permitted classes, failed reads, wrong lengths and unknown classes. Portable tests preserve the actual error-24 failure as non-PASS. The subsequent `7f7b2d3` probe passed these scalar reads and reached candidate-policy validation. That progress does not prove ordinary-user launch or application acceptance.

## Hosted probe result on `1c46b48`

[Push run `42236045874`](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42236045874) retained a completed probe failure before that run was later cancelled. [PR run `42236056011`](https://github.com/XIAZIHAN001/research-workspace/actions/runs/42236056011), testing merge commit `22823dbc` with the same tree as `1c46b48`, independently retained the same result. The C# bridge compiled and **47 native synthetic tests passed**, then the probe stopped at `caller-token` with `TOKEN_REJECTED` and numeric error `0`. The source-token open/noninheritance checks completed, but the report cannot identify which subsequent token-fact or account-identity predicate rejected the context. It does not prove that a logon SID was absent or that a particular account type was used.

SAFER, token duplication/lowering, job creation and child launch were **not reached**. The expensive build and installed-app acceptance steps were skipped. No application, synthetic-credential or CDP acceptance is established by this probe result.

The `74290a6` diagnostic-only revision preserved query order, token requirements and every accept/refuse condition. Reports now distinguish fixed token-query fields and predicate reasons, including sizing/read failures, malformed query shapes, missing/multiple logon SIDs, integrity-label checks and source-account checks. Unexpected query failures retain their actual numeric Windows error. Only closed classifications are retained, never raw SIDs, authentication IDs, token values or buffers. Its subsequent hosted result identified the elevation sizing-query failure described above; the diagnostics did not relax any token requirement.

## Ordinary-permission launch checkpoint

The Windows job now runs `node scripts/verify/windows-bootstrap.mjs --probe` immediately after `npm ci`. Only a complete **PASS** permits the existing frontend/Rust/NSIS build steps. After the build, `--runtime` launches the existing installed-app driver through the same bootstrap. Both modes construct fresh tokens and handles; the runtime never reuses the probe's token or falls back to direct elevated execution. The build-marker-only command remains unchanged.

The shared native bridge opens its own primary token and uses `SaferCreateLevel(SAFER_SCOPEID_USER, SAFER_LEVELID_NORMALUSER, SAFER_LEVEL_OPEN)` and `SaferComputeTokenFromLevel` with zero flags and null reserved input. It duplicates a noninheritable primary token with `TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT`. It lowers only that new token to medium integrity when necessary, never raises a low/untrusted token, and rejects unexpected results. Required proofs are the same account SID, authentication ID, logon SID and session, elevation=false, exact medium integrity, UIAccess=false and SandboxInert=false. System/service identities are refused. Administrator/Power User and other known privileged groups must be absent or deny-only, and existing deny-only restrictions are preserved.

The only permitted privileges are `SeChangeNotifyPrivilege`, `SeShutdownPrivilege`, `SeUndockPrivilege`, `SeIncreaseWorkingSetPrivilege` and `SeTimeZonePrivilege`. They must already be present in the caller, with no newly enabled privileges; the four non-traversal privileges must remain disabled. Every other privilege is rejected even when disabled. This is an ordinary-user acceptance context, **not a hostile-code sandbox**: disabled standard-user privileges can later be enabled and the same user retains access to its account resources. Windows checkout disables persisted Git credentials, and the child environment contains only explicit system/profile variables, validated runner metadata and a Windows/Git tool PATH. No secret/proxy/auth/debug variables or wildcard `ACTIONS_*`/`GITHUB_*` inheritance are allowed. The installed app retains its stricter Windows-only PATH and its existing isolated credential/data guards.

`CreateProcessAsUserW` is the only launch API. It may temporarily enable already-held caller privileges as documented by Microsoft; this is not a privilege grant. Error 1314 stops the gate. There is no explicit privilege enabling, account creation, password use, token harvesting, session switch, registry/UAC/policy/ACL change, breakaway or permission repair. Desktop, profile, tool or nested-job access failures remain blockers.

The executable must match the retained outer Node parent's image and verified whole-file hash. A fixed script, explicit application name, quoted mutable command line, fixed checkout directory and newly allowlisted Unicode environment are used. Node and script files are held read-only during execution. No handles are inherited. Runtime progress is report-only in bootstrap mode. The child is created suspended, atomically inside a new unnamed, noninheritable kill-on-close job via `STARTUPINFOEX` / `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Before the single expected resume, the bridge rechecks the actual child token, image, full 100 ns creation identity and exact job membership. No UI/security/breakaway job flags are set.

The native supervisor waits on retained driver **and outer-parent** process handles. Parent death, timeout or a failed proof triggers bounded cleanup through retained job/process handles, never a fresh PID lookup. Normal completion requires positively signaled driver exit and zero job members before emergency cleanup. Forced teardown cannot convert an application/orphan failure into PASS. If the driver is killed or its final report is missing/incomplete, synthetic Credential Manager cleanup remains **unverified**, even if process teardown succeeds. Completed driver reports separately distinguish credentials never exercised from exact-owned-record cleanup positively verified.

The fixed disposable probe independently verifies its actual ordinary token and creation identity, existing desktop access, checkout/dependency readability, executable Git access, and read/write/delete access to its own output and temporary fixture files. It never installs/runs the app or touches credentials/CDP. Probe PASS does **not** prove NSIS, WebView2, Credential Manager or UI acceptance. Runtime repeats its own context proof and requires each installed app launch to be observed as non-elevated/medium before CDP.

Separate artifacts retain the probe wrapper/child reports, runtime wrapper report, existing build marker, actual runtime report and synthetic screenshots. A random run-local ID ties each wrapper to its own child report. Known native API phases and numeric Windows errors, plus a bounded compiler code when available, are retained; SIDs, authentication IDs, handles, environment/argv dumps and raw exceptions are not. Missing/contradictory proofs, a partial required-check list or an incomplete report cannot pass. Initial reports remain incomplete until finalization.

Portable tests cover environment refusal/redaction, fixed-mode refusal, strict report linking/completeness, probe access proofs and process-versus-credential cleanup classification. Native synthetic policy tests cover rejected identities/groups/privileges, 100 ns comparison, quoting, no-inheritance policy, job/creation configuration, resume count and cleanup predicates. They run inside the hosted probe. **C# compilation, P/Invoke layouts and real Windows token/job/desktop behavior have not been executed locally; the next hosted probe is required.** Application acceptance remains pending regardless of portable tests.

References: [SAFER level](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercreatelevel), [SAFER token](https://learn.microsoft.com/en-us/windows/win32/api/winsafer/nf-winsafer-safercomputetokenfromlevel), [process creation and temporary caller privileges](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw), [atomic job-list attribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [nested jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), [standard filtered-token privileges, Figure 5](https://learn.microsoft.com/en-us/archive/msdn-magazine/2007/january/teach-your-apps-to-work-with-windows-vista-user-account-control).

## Safety and scope

This gate is exclusively for a **fresh GitHub-hosted `windows-latest` job**, with no real workspace, real API key, or parallel Research Workspace test. It rejects non-Windows, self-hosted, missing runner metadata/explicit opt-in, existing application directories, uninstall registrations, application/sidecar processes, or any Credential Manager target beginning `ResearchWorkspace`. Metadata is a workflow guard, not cryptographic proof against someone deliberately spoofing the environment. Do not opt in on a user machine.

The image guard accepts the legacy `win` + digits form and the single additional documented identifier `win25-vs2026`. It does not accept arbitrary suffixes or relax the hosted-runner, opt-in, metadata, commit or source checks. The exact [20261030.294 image manifest](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/Windows2025-VS2026-Readme.md) identifies Windows Server 2025 image version `20261030.294.1`; that release's [image generator](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/helpers/GenerateResourcesAndImage.ps1) sets `ImageOS` to `win25-vs2026`, and [system-environment setup](https://github.com/actions/runner-images/blob/win25-vs2026/20261030.294/images/windows/scripts/build/Configure-SystemEnvironment.ps1) persists it.

Run `42210528782` on commit `0035ee07` stopped in build-marker mode on that image. The previous image regex demonstrably rejects its official identifier. The run's first/only failing assertion cannot be recovered because its guard error was replaced by a generic code and its marker report was not retained. Reports now identify `stage: build-marker` versus `stage: runtime`, and known guard codes are preserved in both the report and a sanitized `TERMINAL` console line. Unknown guard error text is not echoed. No environment dump is needed.

Windows Known Folders are read with `SHGetKnownFolderPath`, including both Roaming and Local AppData. Redirecting `APPDATA`/`LOCALAPPDATA` is not an isolation boundary. Credential Manager is scoped to the OS account. The test uses the fresh VM's actual empty profile and current provider target `ResearchWorkspace/Provider/{provider}`.

Known missing prerequisites, such as an unavailable WebView2 runtime or usable desktop, are BLOCKED / **NOT RUN**, with a nonzero exit. A failed attachment attempt such as `CDP_TIMEOUT` is **FAIL**; dependent IPC/UI checks remain **NOT RUN**. Do not relabel a failed attempt as a successful environment check. The harness does not install/downgrade WebView2, bypass execution policy, disable security settings, use development executables, call a real model endpoint, or delete unexpected data. The already-installed runtime must be present before silent installation; consumer prerequisite installation remains untested.

Covered runtime checks:

- Match source version, HEAD, tree, GitHub run and attempt to a pre-build marker; require clean source and exactly one fresh x64 NSIS installer. Record SHA-256, version and source identity.
- Install that artifact silently under a unique explicit `RUNNER_TEMP` directory. Require exit code 0, real installed EXE/sidecar/launcher, installed version and whole-file hashes matching the expected NSIS payload described below. No fallback.
- Launch the installed EXE with an allowlisted environment and Windows-only PATH. Attach Playwright to its real WebView2 using CDP and wait on `ai_service_info`, not an obsolete badge.
- Verify Mock mode, the owned installed sidecar, authenticated health and a synthetic offline answer, plus unauthenticated rejection.
- Capture actual Home and 设置 → AI 服务 screenshots with the current 离线模拟 control. No key is present when screenshots are taken.
- Generate a fake key in memory; prove its exact atomic credential record hash; check status, normal-close cleanup, restart persistence and saved endpoint. Switch online against the reserved `windows-smoke.invalid` hostname without issuing a model request. Reject changing the active saved-key endpoint; delete the active key, require a replacement Mock sidecar and old-sidecar exit; force-exit the shell, verify natural sidecar exit, restart and confirm no key resurrection.
- Perform independently bounded process, synthetic-credential and CDP cleanup, then write the final report. Observed-process termination checks PID, executable path and exact creation time through one open OS handle. Each app/installer launch retains its `ChildProcess` immediately, before the first fallible snapshot. If observation fails, Windows-only cleanup can stop that root through its retained native child handle, never by a fresh PID lookup; unverified descendants still force `owned-cleanup: FAIL` and `cleanupIncomplete: true`, even when root termination succeeds. Native identity JSON round-trip is checked before installation. No global process-name kill exists. Credential cleanup deletes only the current provider record if its complete blob hash matches this test's generated fake record. Synthetic installation/profile directories are left for VM disposal.

**Not covered by this checkpoint:** clean consumer Windows 10/11 prerequisites, upgrade/uninstall, installer-dialog UX, PDF import/reading UI and backup export/restore UI remain **NOT RUN**. The original user task still requires feature acceptance; PDF/backup UI and recovery checks must continue in a separate Windows UI stage rather than being treated as unnecessary. Consumer installation and upgrade acceptance also remain separate release gates. Real or paid upstream calls are not performed. Passing this narrow gate is not release approval. Screenshot capture is evidence, not a claim of human visual review.

## Attachment and cleanup diagnostics

The app's release window, WebView2 version, security settings, production DevTools configuration, profile location and stripped launch environment are unchanged. Attachment retains its **45-second total budget**. Each discovery request, CDP connection and page-event wait receives the remaining budget and its own smaller timeout; an established connection is retained while its first page arrives. A late connection is tracked and disconnected, never silently abandoned. Discovery requests are bounded to 64 KiB, use only the chosen loopback port and never follow redirects. Reports contain only fixed discovery/attach/page classifications, HTTP status, timing and context/page counts, not response bodies, URLs, titles or exception text.

A separate bounded observation records counts of observable, identity-matched owned processes and top-level windows belonging to the verified app process. Window evidence contains only total/visible/minimized/nonzero-area counts. Unavailable observations remain explicit; a missing snapshot row does not prove exit. No raw profiles, command lines, environment, process paths or application logs are output.

The new read-only diagnostic has a combined eight-second budget, passed through to the actual native subprocess timeouts. It queries the verified app process token only for an elevation boolean and an allowlisted integrity-level class. It also inspects at most 32 currently observable, tracked WebView identities. Each targeted command-line read is enclosed by full identity and liveness checks on one held process handle. Windows argument parsing happens inside the native bridge; only process-type classification, debugging-switch counts, expected-port equality, loopback-address classification and pipe presence leave it. Embedded switch text and positional arguments after `--` are not switches. Duplicate flags never count as a match. Missing/unreadable/invalid observations stay unavailable rather than becoming absent flags. Renderer processes are not assumed to carry browser-process switches.

[Microsoft's current security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) says elevated/high-integrity WebView2 hosts ignore `WEBVIEW2_*` environment overrides, including the debugging arguments. [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges) describes Windows hosted jobs as administrator-run. The earlier run lacked token/flag measurements. Run `42225263617` subsequently measured elevated/high integrity and absent browser debugging flags. The ordinary-permission checkpoint above tests the documented explanation; CDP success is still unproven.

All normal-close, force-exit and final-cleanup exit checks query each tracked identity natively. PID, path and exact creation time are verified before stopping through the same opened handle. A signaled verified handle proves exit; an OpenProcess error 87 proves that PID is absent. Access denied, identity mismatch and unknown state remain non-success. Termination requests receive at most two seconds for same-handle exit confirmation. A failed termination can count as already exited only if that same verified handle is positively signaled; error 5 alone never suffices. Reports retain fixed API phase, numeric Windows status, identity/exit classification and run-local role/ordinal. A later observation does not erase an earlier unresolved cleanup failure.

If image lookup fails, the bridge now preserves that error and makes two further read-only observations on the same, unreopened handle: its complete 100 ns creation time and zero-time signaled state. Only an exact tracked creation-time match plus a positively signaled handle permits the distinct `creation-time` **exit-only** identity. This follows the PID-plus-creation-time identity model of [RM_UNIQUE_PROCESS](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ns-restartmanager-rm_unique_process). The branch returns before any termination call. A successful image lookup with a wrong path never enters this fallback; any timestamp difference, failed read or nonsignaled/unknown state remains non-success. Error 31 is not an exit proof and is not used to select success.

Run `42220406169`'s image-query failure prevented the old code from observing creation time or exit state. It is consistent with an exited process object retained by a handle, but does not establish that explanation or an orphan. The new evidence must distinguish those cases. A synthetic native self-test runs before installation on Windows, checking the real argument parser, full-precision timestamp comparison and exit-proof classifier. Its pass/count is recorded separately and is not application acceptance. Those original diagnostic paths passed their hosted self-test in run `42225263617`; portable tests alone do not verify Windows APIs. The complete ordinary-permission launch path still requires hosted execution; `1c46b48` stopped during the caller-token checks described above.

## Installed payload identity

The pinned [Tauri CLI 2.12.3 bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle.rs) replaces the **first** `__TAURI_BUNDLE_TYPE_VAR_UNK` byte sequence with `__TAURI_BUNDLE_TYPE_VAR_NSS` before NSIS packaging, then restores the original build-tree EXE. Its [NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) includes that patched file directly. Raw installed-versus-restored-EXE hash equality was therefore an incorrect harness assumption.

The gate reads the actual installed `node_modules/@tauri-apps/cli/package.json` version and supports only this reviewed `2.12.3` mapping. It copies the build EXE bytes in memory and applies exactly that first-marker replacement. It compares the entire expected buffer's SHA-256 and length with the untouched installed file. A missing build marker, unsupported CLI version, unpatched installed EXE or any other byte difference fails closed. Existing NSS constants are allowed; neither marker uniqueness nor replacement of all occurrences is assumed. Node sidecar and launcher hashes still require exact, unmodified build-byte equality. Signing or custom packaging that introduces other changes requires a separately reviewed mapping, not broader normalization or excluded byte ranges.

Reports retain installer exit/version and all three roles' raw build and installed hashes, sizes, expected packaged hashes, comparison method and match results before a comparison can throw. Unsupported mapping or missing-marker errors leave the main EXE's expected hash unavailable with a classified error; they do not hide the other roles' raw hashes. No file contents, paths containing user data, credential payloads or environment dumps are added.

Run `42212710072` logged successful NSIS bundle-type patching. Static extraction of its SHA-256-verified installer found an EXE containing two NSS markers and no UNK marker, consistent with one original NSS constant plus the documented replacement. No Windows executable was run during that inspection. That old report did not retain individual resource hashes, so its exact first/only failing comparison cannot be proven retrospectively. The subsequent run `42216224997` passed the corrected expected EXE comparison and verbatim Node/launcher comparisons, validating the payload gate for that run.

## Workflow integration

Do not run these commands locally. Do not reuse `desktop-isolated.mjs` or `desktop-phase11.mjs` for this gate.

This checkpoint follows the green P1 checkpoint. Keep `runs-on: windows-latest`, set a job timeout, and retain the existing locked dependency install, frontend/sidecar preparation and Rust checks. On the **same fresh job**, add a build-start marker immediately before the existing NSIS build, then run the new gate immediately after a successful build. Do not download an unrelated installer or reuse cached installers/markers. Do not run jobs in parallel in the same OS account.

The following partial example shows the same-job sequence. The complete probe, bootstrap, marker and screenshot artifact rules are in [quality.yml](../.github/workflows/quality.yml):

```yaml
# Immediately after npm ci, before expensive build steps:
- name: Probe ordinary-permission Windows driver
  id: windows_ordinary_probe
  timeout-minutes: 3
  env:
    RW_WINDOWS_FRESH_RUNNER: 'yes'
  run: node scripts/verify/windows-bootstrap.mjs --probe
# Continue only after probe success. Keep existing frontend/Rust build checks.
- name: Record exact Windows build start
  id: windows_build_marker
  env:
    RW_WINDOWS_FRESH_RUNNER: 'yes'
  run: node scripts/verify/windows-runtime.mjs --record-build-start
- name: Build Windows Tauri NSIS installer
  run: npm run desktop:build -- --bundles nsis
- name: Installed Windows runtime acceptance
  id: windows_runtime
  timeout-minutes: 11
  env:
    RW_WINDOWS_FRESH_RUNNER: 'yes'
  run: node scripts/verify/windows-bootstrap.mjs --runtime
- name: Retain sanitized Windows runtime report
  if: always() && steps.windows_runtime.outcome != 'skipped'
  uses: actions/upload-artifact@v4
  with:
    name: research-workspace-windows-runtime-${{ github.sha }}
    path: .cache/windows-runtime/**/report.json
    include-hidden-files: true
    if-no-files-found: error
    retention-days: 14
- name: Retain synthetic Windows screenshots
  if: always() && steps.windows_runtime.outcome != 'skipped'
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

Inner runtime driver exit codes: **0 PASS**, **1 FAIL**, **2 NOT RUN/BLOCKED**. The workflow executes the bootstrap, which exits **0 only for a complete linked PASS**, otherwise **1**, including an inner NOT RUN. Build-marker mode exits 0 only to authorize the subsequent build, never to claim a runtime pass. Required checks must all be PASS; excluded checks remain explicitly NOT RUN. Review the exact reported commit/tree/installer hash and both screenshots before promoting the checkpoint. If a run fails after installation, rerun on a new hosted VM, never delete preexisting directories/credentials to make the same VM pass.

Upload only the report and listed synthetic screenshots. Do not upload raw profiles, environment/argv dumps, credential contents, Playwright traces/HAR, crash dumps, or arbitrary application logs. Console evidence contains counts only. Driver debug channels (`DEBUG`, `PWDEBUG`, `NODE_DEBUG`, `NODE_OPTIONS`) are rejected before credential work. Inspect `cleanupIncomplete`/`cleanupFailures` on failures; never broaden cleanup to other PIDs or credentials.

## Portable preparation checks

```sh
npx vitest run scripts/verify/windows-bootstrap-helpers.test.mjs scripts/verify/windows-runtime-helpers.test.mjs
npm run check
node --check scripts/verify/windows-runtime.mjs
```

Portable tests exercise runner denial, same-job artifact identity/freshness, installed-only resource paths, exact first-marker payload derivation, unrelated byte mutations and raw-resource mismatches, unsupported CLI/missing-marker refusal, retained per-role failure diagnostics, delayed page attachment, bounded/late CDP connection handling, real loopback discovery limits and redaction, process identity/PID reuse, strict exit-only proof acceptance, token/flag projection, diagnostic budgets and missing-row handling, malformed snapshots, injected launch-observation failures and fail-closed cleanup status. They **do not** execute PowerShell/PInvoke, the Windows argument parser/native self-test, the actual WebView2 session, Windows Credential Manager or runtime process behavior. The candidate-policy diagnostic revision's hosted execution remains pending; application/WebView2 checks and screenshots have not yet completed.

References: [Playwright WebView2 CDP](https://playwright.dev/docs/webview2), [NSIS installer command line](https://nsis.sourceforge.io/Docs/Chapter3.html). NSIS `/S` is case-sensitive; `/D=<absolute path>` is last and unquoted even when the directory contains spaces. No `/NCRC` flag is used. The Windows-only retained-handle fallback follows [libuv Windows `uv_process_kill`](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c); it never calls PID-based `process.kill`.
