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

/// The minimum and maximum lengths accepted before anything is written. Vendor keys are longer
/// than this in practice; the bounds exist to reject an empty or absurd value, not to encode a
/// vendor's current format.
pub const KEY_MIN_CHARS: usize = 8;
pub const KEY_MAX_CHARS: usize = 1024;

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

/// Reads the key. The caller owns the returned string and must not log it.
pub fn get_for(provider: &str) -> Result<Option<String>, String> {
    let target = target_for(provider)?;
    if let Some(key) = platform::get(&target)? {
        return Ok(Some(key));
    }
    if provider != "deepseek" {
        return Ok(None);
    }
    // Upgrade path: a key written by a version that only knew one provider. Copy it to the new
    // target and clear the old one; a failed copy still returns the key, so the reader is not
    // locked out by a storage hiccup.
    let Some(key) = platform::get(LEGACY_DEEPSEEK_TARGET)? else {
        return Ok(None);
    };
    if platform::set(&target, &key).is_ok() {
        let _ = platform::delete(LEGACY_DEEPSEEK_TARGET);
    }
    Ok(Some(key))
}

/// Stores or replaces the key for one provider.
pub fn set_for(provider: &str, key: &str) -> Result<(), String> {
    let target = target_for(provider)?;
    platform::set(&target, key)?;
    if provider == "deepseek" {
        // Two targets for one key would make "delete" ambiguous; now the legacy one is gone.
        let _ = platform::delete(LEGACY_DEEPSEEK_TARGET);
    }
    Ok(())
}

/// Removes the key. Deleting an absent credential succeeds: the desired end state holds.
pub fn delete_for(provider: &str) -> Result<(), String> {
    let target = target_for(provider)?;
    platform::delete(&target)?;
    if provider == "deepseek" {
        platform::delete(LEGACY_DEEPSEEK_TARGET)?;
    }
    Ok(())
}

#[cfg(windows)]
mod platform {
    use std::ptr;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree, CredReadW,
        CredWriteW,
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
    use super::target_for;

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
}
