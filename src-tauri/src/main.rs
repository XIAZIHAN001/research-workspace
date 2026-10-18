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
//! - the sidecar is started offline. A key exported in the parent environment is not inherited
//!   because the child environment is cleared and only the minimal variables are set;
//! - the webview's data directory is pinned under the application's local data directory so
//!   LocalStorage/IndexedDB survive reinstalls of the same identifier.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use uuid::Uuid;

const READY_PREFIX: &str = "RW_AI_READY ";
const STATUS_EVENT: &str = "ai-service-status";
const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_millis(1200);
const STATUS_STARTING: &str = "starting";
const STATUS_READY: &str = "ready";
const STATUS_FAILED: &str = "failed";
const STATUS_STOPPED: &str = "stopped";

/// What the webview is allowed to know about the AI service.
///
/// `token` is present only in the reply to `ai_service_info`, which is an IPC call from our own
/// window. Lifecycle events carry a copy with the token removed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiServiceStatus {
    state: String,
    base_url: Option<String>,
    token: Option<String>,
    provider: Option<String>,
    instance_id: Option<String>,
    error: Option<String>,
}

impl AiServiceStatus {
    fn empty(state: &str) -> Self {
        Self {
            state: state.to_string(),
            base_url: None,
            token: None,
            provider: None,
            instance_id: None,
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
}

#[derive(Clone)]
struct AiManager(Arc<Mutex<AiRuntime>>);

impl AiManager {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(AiRuntime {
            child: None,
            stdin: None,
            status: AiServiceStatus::empty(STATUS_STOPPED),
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            generation: 0,
        })))
    }

    fn shutdown(&self) {
        let mut runtime = self.0.lock().expect("AI runtime lock poisoned");
        runtime.generation = runtime.generation.wrapping_add(1);
        stop_child(&mut runtime);
        runtime.status = AiServiceStatus::empty(STATUS_STOPPED);
    }
}

#[tauri::command]
fn ai_service_info(manager: State<'_, AiManager>) -> AiServiceStatus {
    let runtime = manager.0.lock().expect("AI runtime lock poisoned");
    let mut status = runtime.status.clone();
    if status.state != STATUS_READY {
        // A port or credential that is not usable yet is not something the interface should
        // hold on to; it will arrive with the ready event instead.
        status.base_url = None;
        status.token = None;
    }
    status
}

#[tauri::command]
fn restart_ai_service(app: AppHandle, manager: State<'_, AiManager>) -> AiServiceStatus {
    start_service(&app, manager.inner());
    let runtime = manager.0.lock().expect("AI runtime lock poisoned");
    runtime.status.public()
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

fn spawn_child(
    app: &AppHandle,
    token: &str,
    instance: &str,
    stderr_sink: Arc<Mutex<VecDeque<String>>>,
) -> Result<(Child, Option<ChildStdin>, ChildStdout), String> {
    let directory = sidecar_dir(app)?;
    // The same filename on every platform keeps the bundle resource list identical. On Linux
    // this is a Linux binary that happens to carry a .exe suffix; the shell never relies on
    // the extension, only on the path.
    let node = directory.join("rw-node.exe");
    let launcher = directory.join("server").join("desktop.mjs");

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
        .env("AI_PARENT_PID", std::process::id().to_string())
        .env("AI_PORT", "0")
        .env("AI_LOG_REQUESTS", "0")
        // The production webview origin on Windows. Tauri serves the built front end from
        // http://tauri.localhost; both schemes are listed so a future useHttpsScheme change
        // does not silently break the service.
        .env(
            "AI_ALLOWED_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost",
        );

    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
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

    // The ready line is the child's own claim. It must name the instance this shell generated
    // and it must say it is offline; anything else is not the service we started.
    let valid = ready
        .as_ref()
        .map(|value| {
            value.port != 0
                && value.desktop_instance == instance
                && value.instance_id.len() >= 8
                && !value.online
        })
        .unwrap_or(false);

    if !valid {
        stop_child(&mut runtime);
        let reason = if ready.is_some() {
            "本地 AI 服务返回的身份不匹配，已停止该进程。".to_string()
        } else {
            "本地 AI 服务没有在限定时间内就绪。".to_string()
        };
        let error = with_details(reason, &runtime);
        runtime.status = AiServiceStatus {
            state: STATUS_FAILED.to_string(),
            base_url: None,
            token: None,
            provider: None,
            instance_id: None,
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
        base_url: Some(format!("http://127.0.0.1:{}", value.port)),
        token: Some(token),
        provider: Some(value.provider),
        instance_id: Some(value.instance_id),
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
            base_url: None,
            token: None,
            provider: None,
            instance_id: None,
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
    let stderr_sink = Arc::new(Mutex::new(VecDeque::new()));
    runtime.stderr = stderr_sink.clone();
    runtime.status = AiServiceStatus::empty(STATUS_STARTING);
    let starting = runtime.status.clone();

    match spawn_child(app, &token, &instance, stderr_sink) {
        Ok((child, stdin, stdout)) => {
            runtime.child = Some(child);
            runtime.stdin = stdin;
            drop(runtime);
            emit_status(app, &starting);
            let app = app.clone();
            let manager = manager.clone();
            thread::spawn(move || {
                monitor_service(app, manager, generation, stdout, instance, token);
            });
        }
        Err(error) => {
            let error = with_details(error, &runtime);
            runtime.status = AiServiceStatus {
                state: STATUS_FAILED.to_string(),
                base_url: None,
                token: None,
                provider: None,
                instance_id: None,
                error: Some(error),
            };
            let failed = runtime.status.clone();
            drop(runtime);
            emit_status(app, &failed);
        }
    }
}

fn main() {
    let manager = AiManager::new();

    let app = tauri::Builder::default()
        .manage(manager)
        .invoke_handler(tauri::generate_handler![
            ai_service_info,
            restart_ai_service
        ])
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

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
