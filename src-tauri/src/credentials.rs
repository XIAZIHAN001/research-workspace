//! Persistent storage for API keys.
//!
//! Keys belong to the operating system's credential store, not to this application's data
//! directory and not to the webview. On Windows that is the Credential Manager: a generic
//! credential scoped to the current user, addressed by a target name that carries the provider
//! id. The front end can learn whether a key exists for a provider; it can never read one back.
//!
//! On other platforms the interface exists but refuses, and says so. Claiming Linux support
//! before it has been built and run there would be worse than an honest error.

use serde::Serialize;

/// The target naming scheme. Stable across versions: changing it would orphan existing keys
/// rather than migrate them.
///
/// The development build uses its own suffix for the same reason it has its own application
/// identifier: a developer running acceptance tests must not be able to overwrite or delete the
/// key belonging to the installed application.
#[cfg(debug_assertions)]
fn target_name(provider: &str) -> String {
    format!("ResearchWorkspace/Provider/{provider}.dev")
}

#[cfg(not(debug_assertions))]
fn target_name(provider: &str) -> String {
    format!("ResearchWorkspace/Provider/{provider}")
}

/// The single-provider target earlier versions wrote. Read as a fallback for DeepSeek so an
/// upgrade does not silently sign the reader out; every new write goes to the per-provider name.
#[cfg(debug_assertions)]
const LEGACY_DEEPSEEK_TARGET: &str = "ResearchWorkspace/DeepSeekApiKey.dev";

#[cfg(not(debug_assertions))]
const LEGACY_DEEPSEEK_TARGET: &str = "ResearchWorkspace/DeepSeekApiKey";

/// The endpoint a key was entered for, stored beside it in the credential store.
///
/// Keeping the binding in the credential store rather than in `ai-preferences.json` matters:
/// the preferences file is ordinary mutable JSON, while a command that changes the endpoint
/// must not also be able to claim a new binding for a key it cannot read.
#[cfg(debug_assertions)]
fn endpoint_target_name(provider: &str) -> String {
    format!("ResearchWorkspace/Provider/{provider}.dev.endpoint")
}

#[cfg(not(debug_assertions))]
fn endpoint_target_name(provider: &str) -> String {
    format!("ResearchWorkspace/Provider/{provider}.endpoint")
}

/// What the credential store holds: the secret and (for keys saved by this build) the authority
/// it was entered for. A key written by an older build has no binding.
#[derive(Clone)]
pub struct StoredKey {
    pub key: String,
    pub endpoint: Option<String>,
}

/// The minimum and maximum lengths accepted before anything is written. Vendor keys are longer
/// than this in practice; the bounds exist to reject an empty or absurd value, not to encode a
/// vendor's current format.
pub const KEY_MIN_CHARS: usize = 8;
pub const KEY_MAX_CHARS: usize = 1024;

/// Windows Credential Manager accepts at most 2560 bytes in one generic credential blob
/// (`CRED_MAX_CREDENTIAL_BLOB_SIZE` is 5 * 512). The combined record is checked against it
/// before anything is written, so a failure is reported without touching the previous record.
const MAX_RECORD_BYTES: usize = 2560;

/// A key and the endpoint it is bound to live in **one** credential blob, so a single
/// `CredWriteW` replaces both. The leading unit separator cannot appear in a valid API key
/// (the command accepts only printable ASCII) and the inner separator cannot appear in a
/// normalized endpoint (URL validation rejects control characters).
const RECORD_MAGIC: &str = "\u{1e}RWK2\u{1f}";
const RECORD_SEPARATOR: char = '\u{1f}';

/// The storage operations used by the public functions. Production uses the OS credential
/// store; tests inject a map that can fail writes or deletes on purpose.
trait Backend {
    fn get(&self, target: &str) -> Result<Option<String>, String>;
    fn set(&self, target: &str, value: &str) -> Result<(), String>;
    fn delete(&self, target: &str) -> Result<(), String>;
}

struct OsBackend;

impl Backend for OsBackend {
    fn get(&self, target: &str) -> Result<Option<String>, String> {
        platform::get(target)
    }

    fn set(&self, target: &str, value: &str) -> Result<(), String> {
        platform::set(target, value)
    }

    fn delete(&self, target: &str) -> Result<(), String> {
        platform::delete(target)
    }
}

fn normalize_endpoint(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Packs the key and its binding into one blob. Every write is a single credential record, so
/// there is no intermediate state where a new key exists beside the previous binding.
fn encode_record(key: &str, endpoint: Option<&str>) -> Result<String, String> {
    if key.is_empty() || key.contains(RECORD_SEPARATOR) {
        return Err("系统凭据内容不合法，已拒绝保存。".to_string());
    }
    let endpoint = endpoint
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    if endpoint.contains(RECORD_SEPARATOR) {
        return Err("API 地址包含无法保存的字符，已拒绝保存。".to_string());
    }
    let record = format!("{RECORD_MAGIC}{endpoint}{RECORD_SEPARATOR}{key}");
    if record.len() > MAX_RECORD_BYTES {
        return Err("API Key 与 API 地址合计过长，系统凭据无法安全保存。".to_string());
    }
    Ok(record)
}

/// Returns `None` for a record written by an older build (a bare key with no binding), and
/// `Err` for a blob that starts like the current format but cannot be decoded. Treating a
/// damaged current record as an old bare key would invent a binding or a key.
fn decode_record(raw: &str) -> Result<Option<(String, Option<String>)>, String> {
    let Some(rest) = raw.strip_prefix(RECORD_MAGIC) else {
        return Ok(None);
    };
    let Some((endpoint, key)) = rest.split_once(RECORD_SEPARATOR) else {
        return Err("系统凭据格式无法识别，已拒绝使用。".to_string());
    };
    if key.is_empty() {
        return Err("系统凭据格式无法识别，已拒绝使用。".to_string());
    }
    Ok(Some((
        key.to_string(),
        normalize_endpoint(Some(endpoint.to_string())),
    )))
}

/// What the interface is allowed to know: whether a key exists, and why it could not be read.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub configured: bool,
    pub error: Option<String>,
}

fn target_for(provider: &str) -> Result<String, String> {
    // Only ids from the registry may reach the credential store, so an IPC argument cannot be
    // turned into an arbitrary target name.
    if crate::providers::find(provider).is_none() {
        return Err(format!("未知的模型提供方：{provider}。"));
    }
    Ok(target_name(provider))
}

fn endpoint_target_for(provider: &str) -> Result<String, String> {
    if crate::providers::find(provider).is_none() {
        return Err(format!("未知的模型提供方：{provider}。"));
    }
    Ok(endpoint_target_name(provider))
}

pub fn status_for(provider: &str) -> CredentialStatus {
    match get_for(provider) {
        Ok(value) => CredentialStatus {
            configured: value.is_some(),
            error: None,
        },
        Err(error) => CredentialStatus {
            configured: false,
            error: Some(error),
        },
    }
}

/// Reads the key and the endpoint it is bound to. The caller owns the returned secret and must
/// not log it.
pub fn get_for(provider: &str) -> Result<Option<StoredKey>, String> {
    get_for_with(&OsBackend, provider)
}

fn get_for_with(backend: &dyn Backend, provider: &str) -> Result<Option<StoredKey>, String> {
    let target = target_for(provider)?;
    let endpoint_target = endpoint_target_for(provider)?;

    let Some(raw) = backend.get(&target)? else {
        if provider != "deepseek" {
            return Ok(None);
        }
        // Upgrade path: a key written by a version that only knew one provider. The new
        // combined record is written first; if that write fails the legacy key is still
        // returned and the old record is left alone, so a storage hiccup neither signs the
        // reader out nor destroys the only copy.
        let Some(legacy) = backend.get(LEGACY_DEEPSEEK_TARGET)? else {
            return Ok(None);
        };
        let endpoint = normalize_endpoint(backend.get(&endpoint_target)?);
        if let Ok(record) = encode_record(&legacy, endpoint.as_deref()) {
            if backend.set(&target, &record).is_ok() {
                let _ = backend.delete(&endpoint_target);
                let _ = backend.delete(LEGACY_DEEPSEEK_TARGET);
            }
        }
        return Ok(Some(StoredKey {
            key: legacy,
            endpoint,
        }));
    };

    match decode_record(&raw)? {
        Some((key, endpoint)) => Ok(Some(StoredKey { key, endpoint })),
        // A record written by the earlier build that kept the binding in a second target.
        // Read the pair as it is; the next save replaces both with one atomic record.
        None => {
            let endpoint = normalize_endpoint(backend.get(&endpoint_target)?);
            Ok(Some(StoredKey { key: raw, endpoint }))
        }
    }
}

/// Stores or replaces the key for one provider, bound to `endpoint`.
///
/// Key and binding are encoded together and written as one credential record. A failed write
/// leaves the previous record untouched, so the store can never hold the new key beside the
/// old binding. An empty endpoint is stored inside the record as "unbound"; the next online
/// start will refuse until the reader saves the key again against a real endpoint.
pub fn set_for(provider: &str, key: &str, endpoint: Option<&str>) -> Result<(), String> {
    set_for_with(&OsBackend, provider, key, endpoint)
}

fn set_for_with(
    backend: &dyn Backend,
    provider: &str,
    key: &str,
    endpoint: Option<&str>,
) -> Result<(), String> {
    let target = target_for(provider)?;
    let endpoint_target = endpoint_target_for(provider)?;
    let record = encode_record(key, endpoint)?;
    backend.set(&target, &record)?;

    // The combined record is authoritative from here on. These are the old separate targets;
    // cleaning them up is best-effort because a failure cannot change which endpoint the saved
    // key is bound to, and reads prefer the combined record anyway.
    let _ = backend.delete(&endpoint_target);
    if provider == "deepseek" {
        let _ = backend.delete(LEGACY_DEEPSEEK_TARGET);
    }
    Ok(())
}

/// Removes the key. Deleting an absent credential succeeds: the desired end state holds.
pub fn delete_for(provider: &str) -> Result<(), String> {
    delete_for_with(&OsBackend, provider)
}

fn delete_for_with(backend: &dyn Backend, provider: &str) -> Result<(), String> {
    let target = target_for(provider)?;
    let endpoint_target = endpoint_target_for(provider)?;
    if provider == "deepseek" {
        // Remove the fallback first. If it cannot be removed, keep the per-provider key so the
        // old fallback cannot become the active credential after a requested deletion.
        backend.delete(LEGACY_DEEPSEEK_TARGET)?;
    }
    backend.delete(&target)?;
    backend.delete(&endpoint_target)?;
    Ok(())
}

#[cfg(windows)]
mod platform {
    use std::ptr;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error(action: &str) -> String {
        let code = unsafe { GetLastError() };
        format!("{action}失败（Windows 错误 {code}）。")
    }

    pub fn get(target_name: &str) -> Result<Option<String>, String> {
        read_target(target_name)
    }

    pub fn set(target_name: &str, key: &str) -> Result<(), String> {
        write_target(target_name, key)
    }

    pub fn delete(target_name: &str) -> Result<(), String> {
        delete_target(target_name)
    }

    fn read_target(target_name: &str) -> Result<Option<String>, String> {
        let target = wide(target_name);
        let mut raw: *mut CREDENTIALW = ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(last_error("读取系统凭据"));
        }
        if raw.is_null() {
            return Ok(None);
        }

        let credential = unsafe { &*raw };
        let size = credential.CredentialBlobSize as usize;
        let mut bytes = if size == 0 || credential.CredentialBlob.is_null() {
            Vec::new()
        } else {
            // Copy before CredFree: the system owns the original buffer.
            unsafe { std::slice::from_raw_parts(credential.CredentialBlob, size) }.to_vec()
        };
        unsafe { CredFree(raw.cast()) };

        let result = String::from_utf8(bytes.clone());
        // The copy exists only long enough to become a String; wipe it either way.
        bytes.fill(0);
        match result {
            Ok(text) => Ok(Some(text)),
            Err(_) => Err("系统凭据不是有效的文本，已拒绝使用。".to_string()),
        }
    }

    fn write_target(target_name: &str, key: &str) -> Result<(), String> {
        let mut target = wide(target_name);
        let mut user = wide("research-workspace-api-key");
        let mut blob = key.as_bytes().to_vec();

        let mut credential: CREDENTIALW = CREDENTIALW::default();
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_mut_ptr();
        credential.CredentialBlobSize = blob.len() as u32;
        credential.CredentialBlob = blob.as_mut_ptr();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        credential.UserName = user.as_mut_ptr();

        let ok = unsafe { CredWriteW(&credential, 0) };
        // The API has copied what it needs; this process should not keep the key in a mutable
        // heap buffer longer than necessary. (The key also exists in the caller's String.)
        blob.fill(0);
        if ok == 0 {
            return Err(last_error("写入系统凭据"));
        }
        Ok(())
    }

    fn delete_target(target_name: &str) -> Result<(), String> {
        let target = wide(target_name);
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(());
            }
            return Err(last_error("删除系统凭据"));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{delete_target, read_target, write_target};
        use uuid::Uuid;

        /// A credential this test creates and deletes. It never touches the application's own
        /// target, so running the suite cannot disturb a real configured key.
        fn test_target() -> String {
            format!("ResearchWorkspace/__test__/{}", Uuid::new_v4())
        }

        #[test]
        fn round_trips_a_key_through_the_credential_store() {
            let target = test_target();
            let key = "sk-phase11-test-value-0123456789";
            write_target(&target, key).expect("write a test credential");
            let read = read_target(&target).expect("read the test credential");
            assert_eq!(read.as_deref(), Some(key));
            delete_target(&target).expect("delete the test credential");
            assert!(read_target(&target).expect("read after delete").is_none());
        }

        #[test]
        fn deleting_an_absent_credential_is_not_an_error() {
            let target = test_target();
            delete_target(&target).expect("delete an absent credential");
        }

        #[test]
        fn replaces_an_existing_value() {
            let target = test_target();
            write_target(&target, "sk-first-value-000000").expect("write first");
            write_target(&target, "sk-second-value-00000").expect("replace");
            assert_eq!(
                read_target(&target).expect("read").as_deref(),
                Some("sk-second-value-00000")
            );
            delete_target(&target).expect("cleanup");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    const MESSAGE: &str = "当前平台还没有接入系统凭据存储；Linux 版本尚未编译和验证。";

    pub fn get(_target_name: &str) -> Result<Option<String>, String> {
        Err(MESSAGE.to_string())
    }

    pub fn set(_target_name: &str, _key: &str) -> Result<(), String> {
        Err(MESSAGE.to_string())
    }

    pub fn delete(_target_name: &str) -> Result<(), String> {
        Err(MESSAGE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    /// A credential store in memory. Failure counters let a test fail exactly one write or one
    /// delete, which is how the "key written but binding not" state used to appear.
    #[derive(Default)]
    struct FakeBackend {
        values: RefCell<BTreeMap<String, String>>,
        get_failures: RefCell<BTreeMap<String, usize>>,
        set_failures: RefCell<BTreeMap<String, usize>>,
        delete_failures: RefCell<BTreeMap<String, usize>>,
        set_calls: Cell<usize>,
    }

    impl FakeBackend {
        fn seed(&self, target: &str, value: &str) {
            self.values
                .borrow_mut()
                .insert(target.to_string(), value.to_string());
        }

        fn value(&self, target: &str) -> Option<String> {
            self.values.borrow().get(target).cloned()
        }

        fn fail_set(&self, target: &str, times: usize) {
            self.set_failures
                .borrow_mut()
                .insert(target.to_string(), times);
        }

        fn fail_delete(&self, target: &str, times: usize) {
            self.delete_failures
                .borrow_mut()
                .insert(target.to_string(), times);
        }

        fn set_calls(&self) -> usize {
            self.set_calls.get()
        }

        fn take_failure(counter: &RefCell<BTreeMap<String, usize>>, target: &str) -> bool {
            let mut map = counter.borrow_mut();
            if let Some(remaining) = map.get_mut(target) {
                if *remaining > 0 {
                    *remaining -= 1;
                    return true;
                }
            }
            false
        }
    }

    impl Backend for FakeBackend {
        fn get(&self, target: &str) -> Result<Option<String>, String> {
            if Self::take_failure(&self.get_failures, target) {
                return Err("模拟读取失败".to_string());
            }
            Ok(self.values.borrow().get(target).cloned())
        }

        fn set(&self, target: &str, value: &str) -> Result<(), String> {
            if Self::take_failure(&self.set_failures, target) {
                return Err("模拟写入失败".to_string());
            }
            self.set_calls.set(self.set_calls.get() + 1);
            self.values
                .borrow_mut()
                .insert(target.to_string(), value.to_string());
            Ok(())
        }

        fn delete(&self, target: &str) -> Result<(), String> {
            if Self::take_failure(&self.delete_failures, target) {
                return Err("模拟删除失败".to_string());
            }
            self.values.borrow_mut().remove(target);
            Ok(())
        }
    }

    fn read_key(backend: &FakeBackend, provider: &str) -> Option<StoredKey> {
        get_for_with(backend, provider).expect("read the credential")
    }

    #[test]
    fn only_registered_providers_get_a_target() {
        assert!(target_for("deepseek").is_ok());
        assert!(target_for("custom").is_ok());
        assert!(target_for("mock").is_err());
        assert!(target_for("../etc/passwd").is_err());
        assert!(target_for("DeepSeek").is_err());
    }

    #[test]
    fn targets_are_per_provider() {
        assert_ne!(
            target_for("deepseek").expect("target"),
            target_for("openai").expect("target")
        );
    }

    #[test]
    fn legacy_endpoint_targets_stay_distinct_and_validated() {
        let key_target = target_for("deepseek").expect("target");
        let endpoint_target = endpoint_target_for("deepseek").expect("endpoint target");
        assert_ne!(key_target, endpoint_target);
        assert!(endpoint_target.ends_with(".endpoint"));
        assert!(endpoint_target_for("mock").is_err());
    }

    #[test]
    fn a_first_save_writes_one_record_with_the_binding() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-first-value-000000",
            Some("https://a.example"),
        )
        .expect("save");
        // One CredWriteW: key and binding cannot be observed apart.
        assert_eq!(backend.set_calls(), 1);
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-first-value-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://a.example"));
        let target = target_for("deepseek").expect("target");
        assert!(backend
            .value(&target)
            .expect("record")
            .starts_with(RECORD_MAGIC));
        assert!(backend
            .value(&endpoint_target_for("deepseek").expect("endpoint target"))
            .is_none());
    }

    #[test]
    fn updating_the_key_for_the_same_endpoint_replaces_the_record() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-old-value-000000",
            Some("https://a.example"),
        )
        .expect("save old");
        set_for_with(
            &backend,
            "deepseek",
            "sk-new-value-000000",
            Some("https://a.example"),
        )
        .expect("save new");
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-new-value-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://a.example"));
        assert_eq!(backend.set_calls(), 2);
    }

    #[test]
    fn changing_the_key_and_the_endpoint_updates_both_together() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-old-value-000000",
            Some("https://a.example"),
        )
        .expect("save old");
        set_for_with(
            &backend,
            "deepseek",
            "sk-new-value-000000",
            Some("https://b.example"),
        )
        .expect("save new");
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-new-value-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://b.example"));
    }

    /// The exact failure the old two-write layout allowed: the key write succeeds, the binding
    /// write fails, and the next read pairs the new key with the old endpoint. Here the single
    /// record write fails as a whole, so the previous pair is still what the store returns.
    #[test]
    fn a_failed_save_never_pairs_the_new_key_with_the_old_endpoint() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-old-value-000000",
            Some("https://old.example"),
        )
        .expect("seed old pair");
        let target = target_for("deepseek").expect("target");
        backend.fail_set(&target, 1);

        let result = set_for_with(
            &backend,
            "deepseek",
            "sk-new-value-000000",
            Some("https://new.example"),
        );
        assert!(result.is_err());
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-old-value-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://old.example"));
        assert!(!backend
            .value(&target)
            .expect("record")
            .contains("sk-new-value-000000"));
    }

    /// A store left by the earlier build: the key alone in one target, the endpoint in another.
    /// It must still be read, and a failed replacement must leave that pair untouched.
    #[test]
    fn a_legacy_dual_record_is_read_and_a_failed_write_leaves_it_intact() {
        let backend = FakeBackend::default();
        let target = target_for("deepseek").expect("target");
        let endpoint_target = endpoint_target_for("deepseek").expect("endpoint target");
        backend.seed(&target, "sk-legacy-old-000000");
        backend.seed(&endpoint_target, "https://legacy.example");

        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-legacy-old-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://legacy.example"));
        // Reading does not rewrite the old layout.
        assert_eq!(
            backend.value(&target).as_deref(),
            Some("sk-legacy-old-000000")
        );

        backend.fail_set(&target, 1);
        assert!(set_for_with(
            &backend,
            "deepseek",
            "sk-legacy-new-000000",
            Some("https://new.example"),
        )
        .is_err());
        assert_eq!(
            backend.value(&target).as_deref(),
            Some("sk-legacy-old-000000")
        );
        assert_eq!(
            backend.value(&endpoint_target).as_deref(),
            Some("https://legacy.example")
        );
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-legacy-old-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://legacy.example"));
    }

    /// A store already left in the old failure state (new key written, old binding still
    /// there) can only be read as it is; there is no record of what the intended endpoint was.
    /// What matters is that the new code does not create another one and does not rewrite it
    /// behind the reader's back.
    #[test]
    fn a_legacy_pair_left_by_a_failed_two_write_save_is_read_as_stored() {
        let backend = FakeBackend::default();
        let target = target_for("deepseek").expect("target");
        let endpoint_target = endpoint_target_for("deepseek").expect("endpoint target");
        backend.seed(&target, "sk-partial-new-000000");
        backend.seed(&endpoint_target, "https://old.example");

        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-partial-new-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://old.example"));

        backend.fail_set(&target, 1);
        assert!(set_for_with(
            &backend,
            "deepseek",
            "sk-next-value-000000",
            Some("https://next.example"),
        )
        .is_err());
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-partial-new-000000");
        assert_eq!(stored.endpoint.as_deref(), Some("https://old.example"));
    }

    #[test]
    fn a_legacy_single_key_is_migrated_to_one_record() {
        let backend = FakeBackend::default();
        backend.seed(LEGACY_DEEPSEEK_TARGET, "sk-legacy-value-000000");
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-legacy-value-000000");
        assert_eq!(stored.endpoint, None);
        let target = target_for("deepseek").expect("target");
        assert!(backend
            .value(&target)
            .expect("record")
            .starts_with(RECORD_MAGIC));
        assert!(backend.value(LEGACY_DEEPSEEK_TARGET).is_none());
    }

    #[test]
    fn a_failed_migration_keeps_the_legacy_key_readable() {
        let backend = FakeBackend::default();
        backend.seed(LEGACY_DEEPSEEK_TARGET, "sk-legacy-value-000000");
        let target = target_for("deepseek").expect("target");
        backend.fail_set(&target, 1);
        let stored = read_key(&backend, "deepseek").expect("legacy key");
        assert_eq!(stored.key, "sk-legacy-value-000000");
        assert!(backend.value(LEGACY_DEEPSEEK_TARGET).is_some());
        assert!(backend.value(&target).is_none());
    }

    #[test]
    fn deleting_fails_closed_and_is_idempotent() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-delete-value-000000",
            Some("https://a.example"),
        )
        .expect("save");
        let target = target_for("deepseek").expect("target");
        backend.fail_delete(&target, 1);
        assert!(delete_for_with(&backend, "deepseek").is_err());
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-delete-value-000000");

        delete_for_with(&backend, "deepseek").expect("delete");
        assert!(read_key(&backend, "deepseek").is_none());
        delete_for_with(&backend, "deepseek").expect("delete again");
    }

    #[test]
    fn a_failed_legacy_delete_does_not_resurrect_the_old_key() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-current-value-000000",
            Some("https://a.example"),
        )
        .expect("save");
        backend.seed(LEGACY_DEEPSEEK_TARGET, "sk-ancient-value-000000");
        backend.fail_delete(LEGACY_DEEPSEEK_TARGET, 1);

        assert!(delete_for_with(&backend, "deepseek").is_err());
        // The per-provider key was not deleted, so the old fallback cannot take over.
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-current-value-000000");
    }

    #[test]
    fn an_unbound_key_stays_unbound() {
        let backend = FakeBackend::default();
        set_for_with(&backend, "deepseek", "sk-unbound-value-00000", None).expect("save");
        let stored = read_key(&backend, "deepseek").expect("key");
        assert_eq!(stored.key, "sk-unbound-value-00000");
        assert_eq!(stored.endpoint, None);
    }

    #[test]
    fn keys_are_isolated_per_provider() {
        let backend = FakeBackend::default();
        set_for_with(
            &backend,
            "deepseek",
            "sk-deepseek-value-0000",
            Some("https://deepseek.example"),
        )
        .expect("save deepseek");
        set_for_with(
            &backend,
            "openai",
            "sk-openai-value-000000",
            Some("https://openai.example"),
        )
        .expect("save openai");
        assert_eq!(
            read_key(&backend, "deepseek").expect("deepseek").key,
            "sk-deepseek-value-0000"
        );
        assert_eq!(
            read_key(&backend, "openai").expect("openai").key,
            "sk-openai-value-000000"
        );
        delete_for_with(&backend, "deepseek").expect("delete deepseek");
        assert!(read_key(&backend, "deepseek").is_none());
        assert!(read_key(&backend, "openai").is_some());
    }

    #[test]
    fn an_oversized_record_is_rejected_before_any_write() {
        let backend = FakeBackend::default();
        let key = "k".repeat(64);
        let endpoint = format!("https://{}", "a".repeat(MAX_RECORD_BYTES));
        assert!(set_for_with(&backend, "deepseek", &key, Some(&endpoint)).is_err());
        assert_eq!(backend.set_calls(), 0);
    }

    #[test]
    fn a_damaged_record_fails_closed_instead_of_becoming_a_bare_key() {
        let backend = FakeBackend::default();
        let target = target_for("deepseek").expect("target");
        backend.seed(&target, &format!("{RECORD_MAGIC}missing-separator"));
        assert!(get_for_with(&backend, "deepseek").is_err());
    }
}
