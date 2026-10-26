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
mod providers;

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

/// The documented thinking levels. `none` disables thinking; the other three enable it.
/// Only a provider with `supports_thinking` receives them; the setting is kept for every provider
/// so switching back to DeepSeek does not lose the reader's choice.
const REASONING_EFFORTS: [&str; 4] = ["none", "low", "high", "max"];
const DEFAULT_REASONING_EFFORT: &str = "low";

fn default_provider() -> String {
    providers::DEFAULT_PROVIDER.to_string()
}

fn default_base_url() -> String {
    providers::DEFAULT_BASE_URL.to_string()
}

fn default_model() -> String {
    providers::DEFAULT_MODEL.to_string()
}

fn default_reasoning_effort() -> String {
    DEFAULT_REASONING_EFFORT.to_string()
}

/// Everything the interface may change about how a model call is made: which provider and
/// endpoint, the model, how hard it thinks, and the spending caps. None of it is a secret.
///
/// The sidecar reads these from its environment at spawn time, so a change takes effect by
/// restarting it — unlike the API key, there is no live channel for them.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings {
    #[serde(default)]
    budget: BudgetSettings,
    #[serde(default = "default_provider")]
    provider: String,
    #[serde(default = "default_base_url")]
    base_url: String,
    #[serde(default = "default_model")]
    model: String,
    #[serde(default = "default_reasoning_effort")]
    reasoning_effort: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            budget: BudgetSettings::default(),
            provider: default_provider(),
            base_url: default_base_url(),
            model: default_model(),
            reasoning_effort: default_reasoning_effort(),
        }
    }
}

impl AiSettings {
    fn validate(&self) -> Result<(), String> {
        self.budget.validate()?;
        if providers::find(&self.provider).is_none() {
            return Err(format!(
                "未知的模型提供方：{}。可选：{}。",
                self.provider,
                providers::all()
                    .iter()
                    .map(|preset| preset.id)
                    .collect::<Vec<_>>()
                    .join(" / ")
            ));
        }
        // Empty values are allowed while the reader is still filling the form; they become an
        // error only when an online start is attempted. What is present must be well formed.
        if !self.model.is_empty() && !providers::is_valid_model_name(&self.model) {
            return Err(format!(
                "模型名称不合法：{}。只能包含字母、数字和 . _ - : / @，最长 128 个字符。",
                self.model
            ));
        }
        if !self.base_url.is_empty() {
            providers::validate_base_url(&self.base_url)?;
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

    /// The extra conditions for a call that can reach a paid endpoint.
    fn online_ready(&self) -> Result<(), String> {
        self.validate()?;
        if self.provider == "custom" && self.base_url.is_empty() {
            return Err("自定义供应商需要先填写 API 地址。".to_string());
        }
        if self.base_url.is_empty() {
            return Err("请先填写 API 地址。".to_string());
        }
        if self.model.is_empty() {
            return Err("请先填写或获取模型名称。".to_string());
        }
        Ok(())
    }

    /// A hand-edited preferences file must not stop the application from starting.
    fn sanitized(mut self) -> Self {
        let preset = providers::find(&self.provider);
        if preset.is_none() {
            self.provider = default_provider();
        }
        let preset = providers::find(&self.provider);
        let base_url = providers::normalize_base_url(&self.base_url);
        self.base_url = if providers::validate_base_url(&base_url).is_ok() {
            base_url
        } else {
            preset
                .map(|value| value.base_url.to_string())
                .unwrap_or_default()
        };
        if !providers::is_valid_model_name(&self.model) {
            self.model = preset
                .map(|value| value.default_model.to_string())
                .unwrap_or_default();
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
    provider: Option<String>,
    base_url: Option<String>,
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
    let provider = {
        let runtime = manager.0.lock().expect("AI runtime lock poisoned");
        runtime.settings.provider.clone()
    };
    status.credential_configured = credentials::status_for(&provider).configured;
    status
}

#[tauri::command]
fn ai_service_info(manager: State<'_, AiManager>) -> AiServiceStatus {
    current_status(manager.inner())
}

/// The provider table the settings page renders. One source of truth: the same ids are used for
/// credential targets, for the sidecar's environment and for the preferences file.
#[tauri::command]
fn ai_providers() -> Vec<providers::ProviderPreset> {
    providers::all().to_vec()
}

#[tauri::command]
fn ai_credentials_status(provider: String) -> credentials::CredentialStatus {
    credentials::status_for(&provider)
}

#[tauri::command]
fn set_ai_api_key(
    app: AppHandle,
    manager: State<'_, AiManager>,
    provider: String,
    key: String,
    base_url: Option<String>,
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

    // A key is saved *for an endpoint*. Binding it here means changing the endpoint later cannot
    // move the stored secret to a host it was never entered for.
    let endpoint = match base_url.as_deref().map(providers::normalize_base_url) {
        Some(value) if value.is_empty() => {
            let runtime = manager.0.lock().expect("AI runtime lock poisoned");
            if runtime.settings.provider == provider {
                providers::endpoint_key(&runtime.settings.base_url)
            } else {
                providers::find(&provider)
                    .and_then(|preset| providers::endpoint_key(preset.base_url))
            }
        }
        Some(value) => {
            if let Err(error) = providers::validate_base_url(&value) {
                wipe_string(&mut candidate);
                return Err(error);
            }
            providers::endpoint_key(&value)
        }
        None => {
            let runtime = manager.0.lock().expect("AI runtime lock poisoned");
            if runtime.settings.provider == provider {
                providers::endpoint_key(&runtime.settings.base_url)
            } else {
                providers::find(&provider)
                    .and_then(|preset| providers::endpoint_key(preset.base_url))
            }
        }
    };

    let written = credentials::set_for(&provider, &candidate, endpoint.as_deref());
    // This local copy exists only for the duration of the call. The IPC argument itself is
    // owned by Tauri and is not persisted or logged by this shell.
    wipe_string(&mut candidate);
    written?;

    // A key change while online takes effect by restarting with the new value. The old
    // sidecar is stopped, so it cannot keep using the previous key. Only a change to the
    // provider actually in use needs that restart.
    let restart = {
        let runtime = manager.0.lock().expect("AI runtime lock poisoned");
        runtime.mode == AiMode::Online && runtime.settings.provider == provider
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
    provider: String,
) -> Result<AiServiceStatus, String> {
    credentials::delete_for(&provider)?;
    // Removing the key of the provider in use must also remove the ability to use it: stop the
    // online child and return to mock in the same action. A key belonging to some other provider
    // does not affect the running service.
    let affected = {
        let mut runtime = manager.0.lock().expect("AI runtime lock poisoned");
        if runtime.mode == AiMode::Online && runtime.settings.provider == provider {
            runtime.mode = AiMode::Mock;
            true
        } else {
            false
        }
    };
    if affected {
        start_service(&app, manager.inner());
    }
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
    if next == AiMode::Online {
        let settings = {
            let runtime = manager.0.lock().expect("AI runtime lock poisoned");
            runtime.settings.clone()
        };
        settings.online_ready()?;
        check_online_credential(&settings.provider, &settings.base_url)?;
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
        if let Some(provider) = patch.provider {
            next.provider = provider;
        }
        if let Some(base_url) = patch.base_url {
            next.base_url = providers::normalize_base_url(&base_url);
        }
        if let Some(model) = patch.model {
            next.model = model.trim().to_string();
        }
        if let Some(effort) = patch.reasoning_effort {
            next.reasoning_effort = effort;
        }
        // A save while online must not leave the running service with settings it cannot use.
        if runtime.mode == AiMode::Online {
            next.online_ready()?;
            check_online_credential(&next.provider, &next.base_url)?;
        } else {
            next.validate()?;
        }
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

/// How much of a `/models` reply is read. A model list is a few kilobytes; anything larger is
/// not a model list.
const MODELS_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
/// A catalogue larger than this is not worth a dropdown.
const MODEL_LIST_LIMIT: usize = 500;

/// Asks the provider what models the account can use.
///
/// The key never goes to the webview: the page either names a key it is about to save, or asks
/// the shell to use the stored one. The request is made here, over https (or a loopback address),
/// with redirects disabled so the Authorization header cannot be forwarded somewhere else.
#[tauri::command]
async fn list_ai_models(
    manager: State<'_, AiManager>,
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let preset =
        providers::find(&provider).ok_or_else(|| format!("未知的模型提供方：{provider}。"))?;
    let (stored_provider, stored_base_url) = {
        let runtime = manager.0.lock().expect("AI runtime lock poisoned");
        (
            runtime.settings.provider.clone(),
            runtime.settings.base_url.clone(),
        )
    };

    let stored_base = providers::normalize_base_url(&stored_base_url);
    // The stored endpoint belongs to the stored provider; asking a different provider for its
    // catalogue must not borrow someone else's address.
    let saved_base = if stored_provider == provider && !stored_base.is_empty() {
        stored_base
    } else {
        preset.base_url.to_string()
    };
    let requested = providers::normalize_base_url(base_url.as_deref().unwrap_or(""));

    let explicit_key = match api_key {
        Some(value) if !value.trim().is_empty() => {
            let candidate = value.trim().to_string();
            let valid = candidate.chars().count() >= credentials::KEY_MIN_CHARS
                && candidate.chars().count() <= credentials::KEY_MAX_CHARS
                && candidate.chars().all(|value| ('!'..='~').contains(&value));
            if !valid {
                let mut candidate = candidate;
                wipe_string(&mut candidate);
                return Err(format!(
                    "API Key 的长度必须在 {} 到 {} 个字符之间，并且不能包含空格或非 ASCII 字符。",
                    credentials::KEY_MIN_CHARS,
                    credentials::KEY_MAX_CHARS
                ));
            }
            Some(candidate)
        }
        _ => None,
    };

    // A caller that supplies a key is allowed to ask an arbitrary endpoint: the secret is the
    // one it just typed, not the one in the credential store. With no new key, the endpoint
    // must be the saved one; otherwise the stored credential could be sent to a host it was
    // never entered for.
    let base = if explicit_key.is_some() {
        if requested.is_empty() {
            saved_base
        } else {
            requested
        }
    } else {
        if !requested.is_empty()
            && providers::endpoint_key(&requested) != providers::endpoint_key(&saved_base)
        {
            return Err(
                "使用已保存的 API Key 时不能更换 API 地址；请先输入 Key，或先保存新的端点。"
                    .to_string(),
            );
        }
        saved_base
    };
    if base.is_empty() {
        return Err("请先填写 API 地址。".to_string());
    }
    providers::validate_base_url(&base)?;

    let mut key = if let Some(key) = explicit_key {
        key
    } else {
        let stored = credentials::get_for(&provider)?.ok_or_else(|| {
            "还没有保存这个提供方的 API Key，可以先保存再获取模型列表。".to_string()
        })?;
        if let Err(error) = check_credential_endpoint(&provider, &stored, &base) {
            let mut stored = stored;
            wipe_string(&mut stored.key);
            return Err(error);
        }
        stored.key
    };

    let outcome = fetch_models(&base, &key).await;
    wipe_string(&mut key);
    outcome
}

async fn fetch_models(base: &str, key: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        // A redirect could carry the key to a host the reader never configured.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("无法初始化网络请求：{error}"))?;

    let response = client
        .get(format!("{base}/models"))
        .header("Accept", "application/json")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "请求模型列表超时（20 秒）。".to_string()
            } else {
                "连接不上模型服务，请检查地址、网络或代理设置。".to_string()
            }
        })?;

    let status = response.status();
    if !status.is_success() {
        // The body may quote the request back; it is not read and not reported.
        return Err(match status.as_u16() {
            401 | 403 => "模型服务拒绝了这次请求（API Key 无效或没有权限）。".to_string(),
            404 => "这个服务没有提供 GET /models 接口，请手动填写模型名称。".to_string(),
            429 => "模型服务的频率限制已触发，请稍后再试。".to_string(),
            code => format!("模型服务返回了错误（HTTP {code}）。"),
        });
    }
    if let Some(length) = response.content_length() {
        if length > MODELS_RESPONSE_LIMIT as u64 {
            return Err("模型列表的响应过大，已放弃读取。".to_string());
        }
    }
    // Read with the cap enforced while the bytes arrive. `text()` would buffer an unbounded
    // chunked response before the length check could run.
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取模型列表的响应失败。".to_string())?
    {
        if body.len() + chunk.len() > MODELS_RESPONSE_LIMIT {
            return Err("模型列表的响应过大，已放弃读取。".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    let text =
        String::from_utf8(body).map_err(|_| "模型服务返回的不是有效的 UTF-8 JSON。".to_string())?;
    parse_models(&text)
}

/// Reads the model ids out of the shapes in use: `{"data": [{"id": …}]}` (OpenAI and most
/// gateways), `{"models": [{"name": …}]}` (Ollama's native shape) or a bare array of strings.
fn parse_models(text: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "模型服务返回的不是 JSON。".to_string())?;

    let mut found: Vec<String> = Vec::new();
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(|list| list.as_array())
        .or_else(|| value.as_array());

    if let Some(entries) = entries {
        for entry in entries {
            let id = entry
                .as_str()
                .or_else(|| entry.get("id").and_then(|value| value.as_str()))
                .or_else(|| entry.get("name").and_then(|value| value.as_str()));
            let Some(id) = id else { continue };
            let id = id.trim();
            if !providers::is_valid_model_name(id) {
                continue;
            }
            if !found.iter().any(|existing| existing == id) {
                found.push(id.to_string());
            }
            if found.len() >= MODEL_LIST_LIMIT {
                break;
            }
        }
    }

    if found.is_empty() {
        return Err("模型服务没有返回可用的模型名称。".to_string());
    }
    found.sort();
    Ok(found)
}

fn random_token() -> String {
    // 32 hex characters each, well above the service's 32-character floor.
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
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

/// Why a stored key must not be used for the endpoint currently selected, if it must not.
///
/// A key saved by this build carries the scheme and authority it was entered for. A key from an
/// older build has no binding; it is accepted only against the provider's own preset endpoint,
/// which is the address the reader saw when they saved it. Any other endpoint requires saving
/// the key again — that is what keeps a changed setting from forwarding the old secret
/// elsewhere.
fn credential_endpoint_problem(
    provider: &str,
    stored: &credentials::StoredKey,
    base_url: &str,
) -> Option<String> {
    let Some(expected) = providers::endpoint_key(base_url) else {
        return Some("API 地址无效，无法校验 API Key 的绑定关系。".to_string());
    };
    let label = providers::find(provider)
        .map(|preset| preset.label)
        .unwrap_or("当前供应商");
    match stored.endpoint.as_deref() {
        Some(bound) if bound.eq_ignore_ascii_case(&expected) => None,
        Some(bound) => Some(format!(
            "保存的 {label} API Key 绑定的是 {bound}，当前 API 地址是 {expected}。更换地址后请重新保存 Key。"
        )),
        None => {
            let preset = providers::find(provider)
                .and_then(|preset| providers::endpoint_key(preset.base_url));
            if preset
                .as_deref()
                .is_some_and(|value| value.eq_ignore_ascii_case(&expected))
            {
                None
            } else {
                Some(format!(
                    "保存的 {label} API Key 还没有绑定当前 API 地址；请先重新保存 Key，再使用这个地址。"
                ))
            }
        }
    }
}

fn check_credential_endpoint(
    provider: &str,
    stored: &credentials::StoredKey,
    base_url: &str,
) -> Result<(), String> {
    match credential_endpoint_problem(provider, stored, base_url) {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

/// Reads the key that would serve the current online settings, and checks its endpoint binding.
fn online_credential(provider: &str, base_url: &str) -> Result<credentials::StoredKey, String> {
    let label = providers::find(provider)
        .map(|preset| preset.label)
        .unwrap_or("当前供应商");
    let mut stored = credentials::get_for(provider)?
        .ok_or_else(|| format!("还没有配置 {label} 的 API Key，不能进入在线模式。"))?;
    if let Err(error) = check_credential_endpoint(provider, &stored, base_url) {
        wipe_string(&mut stored.key);
        return Err(error);
    }
    Ok(stored)
}

/// The same check without keeping the secret: used by commands that only need to know whether an
/// online start is allowed.
fn check_online_credential(provider: &str, base_url: &str) -> Result<(), String> {
    let mut stored = online_credential(provider, base_url)?;
    wipe_string(&mut stored.key);
    Ok(())
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

    let provider = if mode.expects_online() {
        settings.provider.as_str()
    } else {
        "mock"
    };

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
        .env("AI_PROVIDER", provider)
        .env("AI_BASE_URL", &settings.base_url)
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
        .env("AI_MODEL", &settings.model)
        // `none` means no thinking at all; the service resolves a disabled thinking mode to
        // effort `none` itself, so both variables are always sent and always agree. Only the
        // DeepSeek dialect sends them upstream; the others ignore the pair.
        .env(
            "AI_THINKING",
            if settings.reasoning_effort == "none" {
                "disabled"
            } else {
                "enabled"
            },
        )
        .env("AI_REASONING_EFFORT", &settings.reasoning_effort)
        // Windows serves the built front end from http://tauri.localhost; Linux and macOS use
        // the custom tauri://localhost scheme. All three are listed so the same sidecar
        // configuration works on every desktop target.
        .env(
            "AI_ALLOWED_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost,tauri://localhost",
        );

    // Test-only upstream simulation. It exists in debug builds so the offline integration run
    // can stand a fake provider on loopback; a release build has no such branch, so the shipped
    // application can only talk to the address it was configured with. The value comes from the
    // process environment, never from a page or from an IPC call.
    #[cfg(debug_assertions)]
    {
        if let Ok(value) = std::env::var("RW_AI_TEST_UPSTREAM") {
            if is_loopback_http(&value) {
                command.env("AI_BASE_URL", value);
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
    expected_provider: String,
    expected_credential: bool,
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
                && value.provider == expected_provider
                && value.online == expected_mode.expects_online()
                && !value.model.trim().is_empty()
        })
        .unwrap_or(false);

    if !valid {
        stop_child(&mut runtime);
        let reason = if ready.is_some() {
            format!(
                "本地 AI 服务返回的身份或模式不匹配（期望 {} / {}），已停止该进程。",
                expected_mode.as_str(),
                expected_provider
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
            credential_configured: expected_credential,
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
        credential_configured: expected_credential,
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
            credential_configured: expected_credential,
            error: Some(error),
        };
        let failed = runtime.status.clone();
        drop(runtime);
        emit_status(&app, &failed);
        return;
    }
}

fn failed_status(mode: AiMode, credential_configured: bool, error: String) -> AiServiceStatus {
    AiServiceStatus {
        state: STATUS_FAILED.to_string(),
        mode: mode.as_str().to_string(),
        base_url: None,
        token: None,
        provider: None,
        model: None,
        online: false,
        instance_id: None,
        credential_configured,
        error: Some(error),
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
    let expected_provider = if mode.expects_online() {
        settings.provider.clone()
    } else {
        "mock".to_string()
    };
    let credential_configured = credentials::status_for(&settings.provider).configured;
    let stderr_sink = Arc::new(Mutex::new(VecDeque::new()));
    runtime.stderr = stderr_sink.clone();
    runtime.status = AiServiceStatus::empty(STATUS_STARTING, mode);
    runtime.status.credential_configured = credential_configured;
    let starting = runtime.status.clone();

    if mode == AiMode::Online {
        if let Err(error) = settings.online_ready() {
            let failed = failed_status(mode, credential_configured, error);
            runtime.status = failed.clone();
            drop(runtime);
            emit_status(app, &failed);
            return;
        }
    }

    match spawn_child(app, mode, &token, &instance, &settings, stderr_sink) {
        Ok((mut child, mut stdin, stdout)) => {
            if mode == AiMode::Online {
                // Read the key only now, after the child exists. An absent or unreadable key is
                // a failed start, not a quiet fallback to a different service.
                let read = credentials::get_for(&settings.provider);
                match read {
                    Ok(Some(mut stored)) => {
                        if let Err(error) = check_credential_endpoint(
                            &settings.provider,
                            &stored,
                            &settings.base_url,
                        ) {
                            wipe_string(&mut stored.key);
                            let _ = child.kill();
                            let _ = child.wait();
                            let failed = failed_status(mode, credential_configured, error);
                            runtime.status = failed.clone();
                            drop(runtime);
                            emit_status(app, &failed);
                            return;
                        }
                        let handed = match stdin.as_mut() {
                            Some(pipe) => write_secret(pipe, &stored.key),
                            None => Err("本地 AI 服务没有可用的凭据通道。".to_string()),
                        };
                        wipe_string(&mut stored.key);
                        if let Err(error) = handed {
                            let _ = child.kill();
                            let _ = child.wait();
                            let failed = failed_status(mode, credential_configured, error);
                            runtime.status = failed.clone();
                            drop(runtime);
                            emit_status(app, &failed);
                            return;
                        }
                    }
                    Ok(None) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        let label = providers::find(&settings.provider)
                            .map(|preset| preset.label)
                            .unwrap_or("当前供应商");
                        let failed = failed_status(
                            mode,
                            false,
                            format!("没有找到 {label} 的 API Key，在线服务没有启动。"),
                        );
                        runtime.status = failed.clone();
                        drop(runtime);
                        emit_status(app, &failed);
                        return;
                    }
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        let failed = failed_status(mode, false, error);
                        runtime.status = failed.clone();
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
                    expected_provider,
                    credential_configured,
                );
            });
        }
        Err(error) => {
            let error = with_details(error, &runtime);
            let failed = failed_status(mode, credential_configured, error);
            runtime.status = failed.clone();
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
            ai_providers,
            ai_credentials_status,
            set_ai_api_key,
            delete_ai_api_key,
            set_ai_mode,
            get_ai_settings,
            update_ai_settings,
            list_ai_models,
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
            // No native title bar: the page draws its own strip with the window controls
            // (see `WindowBar.tsx`). Resizing and window dragging still work — Tao hit-tests
            // the undecorated frame, and the strip is a drag region.
            .decorations(false)
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

#[cfg(test)]
mod tests {
    use super::{credential_endpoint_problem, credentials::StoredKey};

    fn stored(endpoint: Option<&str>) -> StoredKey {
        StoredKey {
            key: "sk-test-value".to_string(),
            endpoint: endpoint.map(str::to_string),
        }
    }

    #[test]
    fn a_bound_key_only_matches_its_authority() {
        let bound = stored(Some("https://api.deepseek.com"));
        assert!(
            credential_endpoint_problem("deepseek", &bound, "https://api.deepseek.com/v1")
                .is_none()
        );
        assert!(
            credential_endpoint_problem("deepseek", &bound, "https://evil.example/v1").is_some()
        );
        // A scheme downgrade is a different endpoint even when the host is the same.
        assert!(
            credential_endpoint_problem("deepseek", &bound, "http://api.deepseek.com/v1").is_some()
        );
    }

    #[test]
    fn a_legacy_key_is_accepted_only_for_the_provider_preset() {
        let legacy = stored(None);
        assert!(
            credential_endpoint_problem("deepseek", &legacy, "https://api.deepseek.com").is_none()
        );
        assert!(credential_endpoint_problem(
            "deepseek",
            &legacy,
            "https://api.deepseek.example/v1"
        )
        .is_some());
        assert!(
            credential_endpoint_problem("custom", &legacy, "https://evil.example/v1").is_some()
        );
    }
}
