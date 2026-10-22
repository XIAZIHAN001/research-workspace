//! The Tauri desktop shell.
//!
//! The React front end is unchanged. What this shell adds is the part a browser cannot do:
//! starting the bundled Node AI service as a child process with a per-launch credential,
//! telling the webview where that service is, reporting its lifecycle, and making sure it is
//! gone when the application exits.
//!
//! Deliberate boundaries:
//!
//! - no shell plugin, no filesystem plugin, no HTTP plugin: the only process this app can
//!   start is the sidecar it ships, and the only files it reads are its own resources;
//! - the sidecar binds an ephemeral loopback port and requires a random bearer token, so a
//!   stale service on a known port (or another local page) cannot be mistaken for it;
//! - the sidecar normally runs offline. Online mode is a separate, explicit choice, and the
//!   API key is read from the Windows Credential Manager and handed to the sidecar over its
//!   stdin — never through the environment, the command line or the webview;
//! - one application instance only. A second launch focuses the existing window instead of
//!   starting another shell, another sidecar or another writer to the same WebView data;
//! - the webview's data directory is pinned under the application's local data directory so
//!   LocalStorage/IndexedDB survive reinstalls of the same identifier.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use uuid::Uuid;

const READY_PREFIX: &str = "RW_AI_READY ";
const SECRET_PREFIX: &str = "RW_AI_SECRET ";
const STATUS_EVENT: &str = "ai-service-status";
const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_millis(1200);
const STATUS_STARTING: &str = "starting";
const STATUS_READY: &str = "ready";
const STATUS_FAILED: &str = "failed";
const STATUS_STOPPED: &str = "stopped";

/// The two ways the local service can run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiMode {
    Mock,
    Online,
}

impl AiMode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "mock" => Some(Self::Mock),
            "online" => Some(Self::Online),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::Online => "online",
        }
    }

    fn provider(self) -> &'static str {
        match self {
            Self::Mock => "mock",
            Self::Online => "deepseek",
        }
    }

    fn expects_online(self) -> bool {
        matches!(self, Self::Online)
    }
}

/// The spending caps the interface can change. They are not secrets, so they live in a small
/// JSON file under the application's config directory. The key never goes there.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BudgetSettings {
    requests: u32,
    tokens_per_request: u32,
    tokens_per_session: u32,
}

impl Default for BudgetSettings {
    fn default() -> Self {
        Self {
            requests: 50,
            tokens_per_request: 8192,
            tokens_per_session: 200_000,
        }
    }
}

impl BudgetSettings {
    fn validate(&self) -> Result<(), String> {
        if !(1..=1000).contains(&self.requests) {
            return Err("会话请求上限必须在 1 到 1000 之间。".to_string());
        }
        if !(256..=32_000).contains(&self.tokens_per_request) {
            return Err("单次生成 token 上限必须在 256 到 32000 之间。".to_string());
        }
        if !(256..=10_000_000).contains(&self.tokens_per_session) {
            return Err("会话 token 上限必须在 256 到 10000000 之间。".to_string());
        }
        Ok(())
    }
}

/// Model names this build offers. They match `KNOWN_DEEPSEEK_MODELS` in `server/config.mjs`;
/// the sidecar would accept any syntactically valid name, but a free-text field in the interface
/// would turn a typo into a failed paid request.
const KNOWN_MODELS: [&str; 2] = ["deepseek-flash", "deepseek-v4-pro"];
/// The documented thinking levels. `none` disables thinking; the other three enable it.
const REASONING_EFFORTS: [&str; 4] = ["none", "low", "high", "max"];
const DEFAULT_MODEL: &str = "deepseek-flash";
const DEFAULT_REASONING_EFFORT: &str = "low";

fn default_model() -> String {
    DEFAULT_MODEL.to_string()
}

fn default_reasoning_effort() -> String {
    DEFAULT_REASONING_EFFORT.to_string()
}

/// Everything the interface may change about how a model call is made: the model, how hard it
/// thinks, and the spending caps. None of it is a secret.
///
/// The sidecar reads these from its environment at spawn time, so a change takes effect by
/// restarting it — unlike the API key, there is no live channel for them.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings {
    #[serde(default)]
    budget: BudgetSettings,
    #[serde(default = "default_model")]
    model: String,
    #[serde(default = "default_reasoning_effort")]
    reasoning_effort: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            budget: BudgetSettings::default(),
            model: default_model(),
            reasoning_effort: default_reasoning_effort(),
        }
    }
}

impl AiSettings {
    fn validate(&self) -> Result<(), String> {
        self.budget.validate()?;
        if !KNOWN_MODELS.contains(&self.model.as_str()) {
            return Err(format!(
                "未知的模型：{}。可选：{}。",
                self.model,
                KNOWN_MODELS.join(" / ")
            ));
        }
        if !REASONING_EFFORTS.contains(&self.reasoning_effort.as_str()) {
            return Err(format!(
                "未知的思考强度：{}。可选：{}。",
                self.reasoning_effort,
                REASONING_EFFORTS.join(" / ")
            ));
        }
        Ok(())
    }

    /// A hand-edited preferences file must not stop the application from starting.
    fn sanitized(mut self) -> Self {
        if !KNOWN_MODELS.contains(&self.model.as_str()) {
            self.model = default_model();
        }
        if !REASONING_EFFORTS.contains(&self.reasoning_effort.as_str()) {
            self.reasoning_effort = default_reasoning_effort();
        }
        self
    }
}

/// A partial update from the settings page: each save changes only the section it belongs to.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsPatch {
    budget: Option<BudgetSettings>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

/// What the webview is allowed to know about the AI service.
///
/// `token` is present only in the reply to `ai_service_info`, which is an IPC call from our own
/// window. Lifecycle events carry a copy with the token removed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiServiceStatus {
    state: String,
    mode: String,
    base_url: Option<String>,
    token: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    online: bool,
    instance_id: Option<String>,
    credential_configured: bool,
    error: Option<String>,
}

impl AiServiceStatus {
    fn empty(state: &str, mode: AiMode) -> Self {
        Self {
            state: state.to_string(),
            mode: mode.as_str().to_string(),
            base_url: None,
            token: None,
            provider: None,
            model: None,
            online: false,
            instance_id: None,
            credential_configured: false,
            error: None,
        }
    }

    fn public(&self) -> Self {
        let mut copy = self.clone();
        copy.token = None;
        copy
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyLine {
    port: u16,
    instance_id: String,
    desktop_instance: String,
    provider: String,
    model: String,
    online: bool,
}

struct AiRuntime {
    child: Option<Child>,
    /// Held open on purpose: when the shell exits, this pipe closes and the service sees EOF.
    stdin: Option<ChildStdin>,
    status: AiServiceStatus,
    stderr: Arc<Mutex<VecDeque<String>>>,
    /// Bumped by every start/stop. A monitor thread from an older generation must not write
    /// its result over a newer service's state.
    generation: u64,
    /// The mode this runtime is meant to be in. Restarts reuse it; startup always uses mock.
    mode: AiMode,
    settings: AiSettings,
}

#[derive(Clone)]
struct AiManager(Arc<Mutex<AiRuntime>>);

impl AiManager {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(AiRuntime {
            child: None,
            stdin: None,
            status: AiServiceStatus::empty(STATUS_STOPPED, AiMode::Mock),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            generation: 0,
            // Every launch starts offline. The interface can switch to online in this session,
            // but nothing about a previous session can turn a new launch into a paid one.
            mode: AiMode::Mock,
            settings: AiSettings::default(),
        })))
    }

    fn shutdown(&self) {
        let mut runtime = self.0.lock().expect("AI runtime lock poisoned");
        runtime.generation = runtime.generation.wrapping_add(1);
        stop_child(&mut runtime);
        runtime.status = AiServiceStatus::empty(STATUS_STOPPED, runtime.mode);
    }
}

fn current_status(manager: &AiManager) -> AiServiceStatus {
    let mut status = {
        let runtime = manager.0.lock().expect("AI runtime lock poisoned");
        let mut status = runtime.status.clone();
        if status.state != STATUS_READY {
            // A port or credential that is not usable yet is not something the interface should
            // hold on to; it will arrive with the ready event instead.
            status.base_url = None;
            status.token = None;
        }
        status
    };
    status.credential_configured = credentials::status().configured;
    status
}

#[tauri::command]
fn ai_service_info(manager: State<'_, AiManager>) -> AiServiceStatus {
    current_status(manager.inner())
}

#[tauri::command]
fn ai_credentials_status() -> credentials::CredentialStatus {
    credentials::status()
}

#[tauri::command]
fn set_ai_api_key(
    app: AppHandle,
    manager: State<'_, AiManager>,
    key: String,
) -> Result<AiServiceStatus, String> {
    let mut candidate = key.trim().to_string();
    let valid = candidate.chars().count() >= credentials::KEY_MIN_CHARS
        && candidate.chars().count() <= credentials::KEY_MAX_CHARS
        && candidate.chars().all(|value| ('!'..='~').contains(&value));

    if !valid {
        wipe_string(&mut candidate);
        return Err(format!(
            "API Key 的长度必须在 {} 到 {} 个字符之间，并且不能包含空格或非 ASCII 字符。",
            credentials::KEY_MIN_CHARS,
            credentials::KEY_MAX_CHARS
        ));
    }

    let written = credentials::set(&candidate);
    // This local copy exists only for the duration of the call. The IPC argument itself is
    // owned by Tauri and is not persisted or logged by this shell.
    wipe_string(&mut candidate);
    written?;

    // A key change while online takes effect by restarting with the new value. The old
    // sidecar is stopped, so it cannot keep using the previous key.
    let restart = {
        let runtime = manager.0.lock().expect("AI runtime lock poisoned");
        runtime.mode == AiMode::Online
    };
    if restart {
        start_service(&app, manager.inner());
    }
    Ok(current_status(manager.inner()))
}

#[tauri::command]
fn delete_ai_api_key(
    app: AppHandle,
    manager: State<'_, AiManager>,
) -> Result<AiServiceStatus, String> {
    credentials::delete()?;
    // Removing the key must also remove the ability to use it: stop the online child and
    // return to mock in the same action.
    {
        let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
        runtime.mode = AiMode::Mock;
    }
    start_service(&app, manager.inner());
    Ok(current_status(manager.inner()))
}

#[tauri::command]
fn set_ai_mode(
    app: AppHandle,
    manager: State<'_, AiManager>,
    mode: String,
) -> Result<AiServiceStatus, String> {
    let next = AiMode::parse(&mode)
        .ok_or_else(|| "未知的 AI 模式；只能是 mock 或 online。".to_string())?;
    if next == AiMode::Online && !credentials::status().configured {
        return Err("还没有配置 API Key，不能进入在线模式。".to_string());
    }
    {
        let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
        runtime.mode = next;
    }
    start_service(&app, manager.inner());
    Ok(current_status(manager.inner()))
}

#[tauri::command]
fn get_ai_settings(manager: State<'_, AiManager>) -> AiSettings {
    manager
        .0
        .lock()
        .expect("AI runtime lock poisoned")
        .settings
        .clone()
}

#[tauri::command]
fn update_ai_settings(
    app: AppHandle,
    manager: State<'_, AiManager>,
    patch: AiSettingsPatch,
) -> Result<AiSettings, String> {
    let next = {
        let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
        let mut next = runtime.settings.clone();
        if let Some(budget) = patch.budget {
            next.budget = budget;
        }
        if let Some(model) = patch.model {
            next.model = model;
        }
        if let Some(effort) = patch.reasoning_effort {
            next.reasoning_effort = effort;
        }
        next.validate()?;
        runtime.settings = next.clone();
        next
    };
    save_preferences(&app, &next)?;
    // The sidecar reads every one of these from its environment, so applying a change means a
    // fresh process. It also gives the reader a clean session counter to go with the new limits.
    start_service(&app, manager.inner());
    Ok(next)
}

#[tauri::command]
fn restart_ai_service(app: AppHandle, manager: State<'_, AiManager>) -> AiServiceStatus {
    start_service(&app, manager.inner());
    current_status(manager.inner())
}

fn random_token() -> String {
    // 32 hex characters each, well above the service's 32-character floor.
    format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar"))
    }
    #[cfg(not(debug_assertions))]
    {
        app.path()
            .resource_dir()
            .map(|directory| directory.join("sidecar"))
            .map_err(|error| format!("找不到应用资源目录：{error}"))
    }
}

/**
 * Tauri resolves resources to a verbatim path (`\\?\D:\...`). That is useful for Rust's own
 * filesystem calls, but Node treats the prefix as part of the script name and fails before the
 * service starts. The executable and its arguments are the one place the plain path is needed.
 */
fn native_path(path: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(text) = path.to_str() {
            if let Some(rest) = text.strip_prefix(r"\\?\") {
                return PathBuf::from(rest);
            }
        }
    }
    path.to_path_buf()
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("ai-preferences.json"))
        .map_err(|error| format!("找不到应用配置目录：{error}"))
}

fn load_preferences(app: &AppHandle) -> AiSettings {
    let Ok(path) = preferences_path(app) else {
        return AiSettings::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return AiSettings::default();
    };
    serde_json::from_str::<AiSettings>(&text)
        .map(|settings| {
            let mut settings = settings.sanitized();
            if settings.budget.validate().is_err() {
                settings.budget = BudgetSettings::default();
            }
            settings
        })
        .unwrap_or_default()
}

fn save_preferences(app: &AppHandle, settings: &AiSettings) -> Result<(), String> {
    let path = preferences_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建应用配置目录：{error}"))?;
    }
    let text = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("无法序列化 AI 设置：{error}"))?;
    std::fs::write(path, text).map_err(|error| format!("无法保存 AI 设置：{error}"))
}

fn stderr_tail(runtime: &AiRuntime) -> String {
    let lines = runtime.stderr.lock().expect("stderr lock poisoned");
    let text = lines
        .iter()
        .rev()
        .take(6)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" / ");
    if text.chars().count() > 400 {
        format!("{}…", text.chars().take(400).collect::<String>())
    } else {
        text
    }
}

fn with_details(message: String, runtime: &AiRuntime) -> String {
    let tail = stderr_tail(runtime);
    if tail.is_empty() {
        message
    } else {
        format!("{message}（{tail}）")
    }
}

fn stop_child(runtime: &mut AiRuntime) {
    // Closing the pipe first gives the service a chance to shut down by itself; the explicit
    // kill below is bounded so a stuck process cannot hold the application open.
    runtime.stdin.take();
    if let Some(mut child) = runtime.child.take() {
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    }
}

fn emit_status(app: &AppHandle, status: &AiServiceStatus) {
    let _ = app.emit(STATUS_EVENT, status.public());
}

/// Overwrites the bytes of a string in place. The capacity stays, but the secret does not.
fn wipe_string(value: &mut String) {
    // Writing zeroes over a valid UTF-8 string keeps it valid: NUL is valid UTF-8.
    unsafe {
        value.as_bytes_mut().fill(0);
    }
}

/**
 * Hands the key to the child over its stdin.
 *
 * Nothing in this function writes the key to a log or an error: a failure is reported as a bare
 * reason. The line buffer is wiped after the write; the child keeps the key in its own memory.
 */
fn write_secret(stdin: &mut ChildStdin, key: &str) -> Result<(), String> {
    #[derive(Serialize)]
    struct SecretPayload<'a> {
        #[serde(rename = "apiKey")]
        api_key: &'a str,
    }

    let mut payload = serde_json::to_string(&SecretPayload { api_key: key })
        .map_err(|error| format!("无法构造凭据消息：{error}"))?;
    let mut line = format!("{SECRET_PREFIX}{payload}\n").into_bytes();
    let result = stdin
        .write_all(&line)
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("无法把 API Key 交给本地 AI 服务：{error}"));
    line.fill(0);
    unsafe {
        payload.as_bytes_mut().fill(0);
    }
    result
}

#[cfg(debug_assertions)]
fn is_loopback_http(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or("");
    let Some((name, port)) = host.rsplit_once(':') else {
        return false;
    };
    (name == "127.0.0.1" || name == "localhost")
        && port.parse::<u16>().map(|value| value > 0).unwrap_or(false)
}

fn spawn_child(
    app: &AppHandle,
    mode: AiMode,
    token: &str,
    instance: &str,
    settings: &AiSettings,
    stderr_sink: Arc<Mutex<VecDeque<String>>>,
) -> Result<(Child, Option<ChildStdin>, ChildStdout), String> {
    let directory = sidecar_dir(app)?;
    // The same filename on every platform keeps the bundle resource list identical. On Linux
    // this is a Linux binary that happens to carry a .exe suffix; the shell never relies on
    // the extension, only on the path.
    let node = native_path(&directory.join("rw-node.exe"));
    let launcher = native_path(&directory.join("server").join("desktop.mjs"));

    if !node.is_file() {
        return Err(format!(
            "打包的 AI 服务运行时不存在：{}。请先运行 npm run desktop:prepare。",
            node.display()
        ));
    }
    if !launcher.is_file() {
        return Err(format!(
            "打包的 AI 服务入口不存在：{}。请先运行 npm run desktop:prepare。",
            launcher.display()
        ));
    }

    let mut command = Command::new(&node);
    command
        .arg(&launcher)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The child must not inherit a key, a proxy or a provider selection from whoever
        // launched the desktop app. Only the variables Windows itself needs are restored.
        .env_clear()
        .env("AI_SESSION_TOKEN", token)
        .env("AI_DESKTOP_INSTANCE", instance)
        .env("AI_DESKTOP_MODE", mode.as_str())
        .env("AI_PROVIDER", mode.provider())
        .env("AI_PARENT_PID", std::process::id().to_string())
        .env("AI_PORT", "0")
        .env("AI_LOG_REQUESTS", "0")
        .env("AI_BUDGET_REQUESTS", settings.budget.requests.to_string())
        .env(
            "AI_BUDGET_TOKENS_PER_REQUEST",
            settings.budget.tokens_per_request.to_string(),
        )
        .env(
            "AI_BUDGET_TOKENS_SESSION",
            settings.budget.tokens_per_session.to_string(),
        )
        .env("DEEPSEEK_MODEL", &settings.model)
        // `none` means no thinking at all; the service resolves a disabled thinking mode to
        // effort `none` itself, so both variables are always sent and always agree.
        .env(
            "DEEPSEEK_THINKING",
            if settings.reasoning_effort == "none" {
                "disabled"
            } else {
                "enabled"
            },
        )
        .env("DEEPSEEK_REASONING_EFFORT", &settings.reasoning_effort)
        // Windows serves the built front end from http://tauri.localhost; Linux and macOS use
        // the custom tauri://localhost scheme. All three are listed so the same sidecar
        // configuration works on every desktop target.
        .env(
            "AI_ALLOWED_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost,tauri://localhost",
        );

    // Test-only upstream simulation. It exists in debug builds so the offline integration run
    // can stand a fake DeepSeek on loopback; a release build has no such branch, so the shipped
    // application can only talk to the official endpoint. The value comes from the process
    // environment, never from a page or from an IPC call.
    #[cfg(debug_assertions)]
    {
        if let Ok(value) = std::env::var("RW_AI_TEST_UPSTREAM") {
            if is_loopback_http(&value) {
                command.env("DEEPSEEK_BASE_URL", value);
                command.env("AI_ALLOW_LOOPBACK_UPSTREAM", "1");
            }
        }
    }

    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "HOME",
        "PATH",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMDATA",
    ] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本地 AI 服务：{error}"))?;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取本地 AI 服务的启动输出。".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let mut sink = stderr_sink.lock().expect("stderr lock poisoned");
                if sink.len() >= 24 {
                    sink.pop_front();
                }
                sink.push_back(line);
            }
        });
    }

    Ok((child, stdin, stdout))
}

/// Reads the ready handshake and then watches the child for the rest of its life.
///
/// Runs on its own thread: `setup` must not wait for a process to start, and a failed start
/// must become a status the interface can show rather than an application that never appears.
fn monitor_service(
    app: AppHandle,
    manager: AiManager,
    generation: u64,
    stdout: ChildStdout,
    instance: String,
    token: String,
    expected_mode: AiMode,
) {
    let (ready_tx, ready_rx) = mpsc::channel::<Option<ReadyLine>>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(rest) = line.strip_prefix(READY_PREFIX) {
                if let Ok(ready) = serde_json::from_str::<ReadyLine>(rest) {
                    let _ = ready_tx.send(Some(ready));
                }
            }
        }
        let _ = ready_tx.send(None);
    });

    let deadline = Instant::now() + START_TIMEOUT;
    let mut ready: Option<ReadyLine> = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match ready_rx.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(Some(value)) => {
                ready = Some(value);
                break;
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
                if runtime.generation != generation {
                    return;
                }
                let exited = runtime
                    .child
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten());
                if exited.is_some() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
    if runtime.generation != generation {
        return;
    }

    // The ready line is the child's own claim. It must name the instance this shell generated,
    // it must say the mode we asked for, and it must name the provider that mode implies.
    // Anything else is not the service we started.
    let valid = ready
        .as_ref()
        .map(|value| {
            value.port != 0
                && value.desktop_instance == instance
                && value.instance_id.len() >= 8
                && value.provider == expected_mode.provider()
                && value.online == expected_mode.expects_online()
                && !value.model.trim().is_empty()
        })
        .unwrap_or(false);

    if !valid {
        stop_child(&mut runtime);
        let reason = if ready.is_some() {
            format!(
                "本地 AI 服务返回的身份或模式不匹配（期望 {}），已停止该进程。",
                expected_mode.as_str()
            )
        } else {
            "本地 AI 服务没有在限定时间内就绪。".to_string()
        };
        let error = with_details(reason, &runtime);
        runtime.status = AiServiceStatus {
            state: STATUS_FAILED.to_string(),
            mode: expected_mode.as_str().to_string(),
            base_url: None,
            token: None,
            provider: None,
            model: None,
            online: false,
            instance_id: None,
            credential_configured: credentials::status().configured,
            error: Some(error),
        };
        let status = runtime.status.clone();
        drop(runtime);
        emit_status(&app, &status);
        return;
    }

    let value = ready.expect("the ready line was checked above");

    runtime.status = AiServiceStatus {
        state: STATUS_READY.to_string(),
        mode: expected_mode.as_str().to_string(),
        base_url: Some(format!("http://127.0.0.1:{}", value.port)),
        token: Some(token),
        provider: Some(value.provider),
        model: Some(value.model),
        online: value.online,
        instance_id: Some(value.instance_id),
        credential_configured: credentials::status().configured,
        error: None,
    };
    let ready_status = runtime.status.clone();
    drop(runtime);
    emit_status(&app, &ready_status);

    // Stay with the child. A sidecar that dies later must become a visible failure, not a
    // service the interface keeps trying to reach.
    loop {
        thread::sleep(Duration::from_secs(1));
        let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
        if runtime.generation != generation || runtime.status.state != STATUS_READY {
            return;
        }
        let exited = runtime
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok().flatten());
        let Some(status) = exited else { continue };
        runtime.child = None;
        runtime.stdin = None;
        let code = status
            .code()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "未知".to_string());
        let error = with_details(format!("本地 AI 服务已退出（退出码 {code}）。"), &runtime);
        runtime.status = AiServiceStatus {
            state: STATUS_FAILED.to_string(),
            mode: expected_mode.as_str().to_string(),
            base_url: None,
            token: None,
            provider: None,
            model: None,
            online: false,
            instance_id: None,
            credential_configured: credentials::status().configured,
            error: Some(error),
        };
        let failed = runtime.status.clone();
        drop(runtime);
        emit_status(&app, &failed);
        return;
    }
}

fn start_service(app: &AppHandle, manager: &AiManager) {
    let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
    stop_child(&mut runtime);
    runtime.generation = runtime.generation.wrapping_add(1);
    let generation = runtime.generation;
    let token = random_token();
    let instance = Uuid::new_v4().to_string();
    let mode = runtime.mode;
    let settings = runtime.settings.clone();
    let stderr_sink = Arc::new(Mutex::new(VecDeque::new()));
    runtime.stderr = stderr_sink.clone();
    runtime.status = AiServiceStatus::empty(STATUS_STARTING, mode);
    runtime.status.credential_configured = credentials::status().configured;
    let starting = runtime.status.clone();

    match spawn_child(app, mode, &token, &instance, &settings, stderr_sink) {
        Ok((mut child, mut stdin, stdout)) => {
            if mode == AiMode::Online {
                // Read the key only now, after the child exists. An absent or unreadable key is
                // a failed start, not a quiet fallback to a different service.
                match credentials::get() {
                    Ok(Some(mut key)) => {
                        let handed = match stdin.as_mut() {
                            Some(pipe) => write_secret(pipe, &key),
                            None => Err("本地 AI 服务没有可用的凭据通道。".to_string()),
                        };
                        wipe_string(&mut key);
                        if let Err(error) = handed {
                            let _ = child.kill();
                            let _ = child.wait();
                            runtime.status = AiServiceStatus {
                                state: STATUS_FAILED.to_string(),
                                mode: mode.as_str().to_string(),
                                base_url: None,
                                token: None,
                                provider: None,
                                model: None,
                                online: false,
                                instance_id: None,
                                credential_configured: credentials::status().configured,
                                error: Some(error),
                            };
                            let failed = runtime.status.clone();
                            drop(runtime);
                            emit_status(app, &failed);
                            return;
                        }
                    }
                    Ok(None) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        runtime.status = AiServiceStatus {
                            state: STATUS_FAILED.to_string(),
                            mode: mode.as_str().to_string(),
                            base_url: None,
                            token: None,
                            provider: None,
                            model: None,
                            online: false,
                            instance_id: None,
                            credential_configured: false,
                            error: Some(
                                "没有找到已保存的 API Key，在线服务没有启动。".to_string(),
                            ),
                        };
                        let failed = runtime.status.clone();
                        drop(runtime);
                        emit_status(app, &failed);
                        return;
                    }
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        runtime.status = AiServiceStatus {
                            state: STATUS_FAILED.to_string(),
                            mode: mode.as_str().to_string(),
                            base_url: None,
                            token: None,
                            provider: None,
                            model: None,
                            online: false,
                            instance_id: None,
                            credential_configured: false,
                            error: Some(error),
                        };
                        let failed = runtime.status.clone();
                        drop(runtime);
                        emit_status(app, &failed);
                        return;
                    }
                }
            }

            runtime.child = Some(child);
            runtime.stdin = stdin;
            drop(runtime);
            emit_status(app, &starting);
            let app = app.clone();
            let manager = manager.clone();
            thread::spawn(move || {
                monitor_service(
                    app,
                    manager,
                    generation,
                    stdout,
                    instance,
                    token,
                    mode,
                );
            });
        }
        Err(error) => {
            let error = with_details(error, &runtime);
            runtime.status = AiServiceStatus {
                state: STATUS_FAILED.to_string(),
                mode: mode.as_str().to_string(),
                base_url: None,
                token: None,
                provider: None,
                model: None,
                online: false,
                instance_id: None,
                credential_configured: credentials::status().configured,
                error: Some(error),
            };
            let failed = runtime.status.clone();
            drop(runtime);
            emit_status(app, &failed);
        }
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let manager = AiManager::new();

    let app = tauri::Builder::default()
        // The single-instance guard must be the first plugin: it needs to decide whether this
        // process is allowed to continue before any window or sidecar is created. It keys on
        // the bundle identifier, so the dev build (com.researchworkspace.desktop.dev) is a
        // separate instance namespace and can run beside the installed application.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            ai_service_info,
            ai_credentials_status,
            set_ai_api_key,
            delete_ai_api_key,
            set_ai_mode,
            get_ai_settings,
            update_ai_settings,
            restart_ai_service
        ])
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // The spending caps are ordinary preferences, not secrets. A corrupt or missing
            // file falls back to the defaults rather than stopping the application.
            let settings = load_preferences(&app.handle().clone());
            let manager = app.state::<AiManager>().inner().clone();
            {
                let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
                runtime.settings = settings;
            }

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Research Workspace")
            .inner_size(1280.0, 860.0)
            .min_inner_size(960.0, 640.0)
            .center();

            // Pin WebView2's user data (LocalStorage, IndexedDB, cache) to a stable path
            // under the application identifier. Without this the folder would follow the
            // executable name, which makes the persistence rule harder to state and to keep.
            #[cfg(target_os = "windows")]
            {
                let webview_data = data_dir.join("webview");
                std::fs::create_dir_all(&webview_data)?;
                builder = builder.data_directory(webview_data);
            }

            builder.build()?;

            let handle = app.handle().clone();
            let manager = app.state::<AiManager>().inner().clone();
            start_service(&handle, &manager);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Research Workspace desktop application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(manager) = handle.try_state::<AiManager>() {
                manager.shutdown();
            }
        }
    });
}
