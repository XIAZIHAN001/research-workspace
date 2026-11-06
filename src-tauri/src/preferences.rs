//! Non-secret preferences. Replacement must never expose a truncated live file.
use std::io::{self, Write};
use std::path::Path;

pub fn save(path: &Path, bytes: &[u8]) -> io::Result<()> {
    save_with(path, bytes, |_| Ok(()))
}

/// Only call during startup, after the application's single-instance lock is held. A previous
/// process cannot still be writing this directory; normal saves never sweep one another.
pub fn cleanup_interrupted(path: &Path) {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!(".{}.rw-", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    // Bound startup work even if this directory has unexpected contents.
    for entry in entries.take(256).flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(id) = name
            .strip_prefix(&prefix)
            .and_then(|name| name.strip_suffix(".tmp"))
        else {
            continue;
        };
        let Some((pid, sequence)) = id.split_once('-') else {
            continue;
        };
        if pid.parse::<u32>().is_ok()
            && sequence.parse::<u64>().is_ok()
            && entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Write,
    Sync,
    Replace,
}
fn save_with(
    path: &Path,
    bytes: &[u8],
    mut check: impl FnMut(Stage) -> io::Result<()>,
) -> io::Result<()> {
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing preferences directory"))?;
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("missing preferences filename"))?
        .to_string_lossy();
    let (temporary, mut file) = loop {
        let temporary = parent.join(format!(
            ".{name}.rw-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => break (Temporary(temporary), file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    // Close before dropping the cleanup guard, including errors: Windows cannot unlink an
    // open temporary file on every filesystem. No write ever touches the live file.
    let written = (|| {
        check(Stage::Write)?;
        file.write_all(bytes)?;
        file.flush()?;
        check(Stage::Sync)?;
        file.sync_all()
    })();
    drop(file);
    written?;
    check(Stage::Replace)?;
    replace(&temporary.0, path)?;
    // Rename is the commit point. A directory-sync error after it must not be reported as a
    // failed save (that would leave memory on the old value while disk contains the new one).
    // Best-effort directory sync improves power-loss durability where supported.
    #[cfg(unix)]
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

struct Temporary(std::path::PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> io::Result<()> {
    std::fs::rename(source, target)
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same-directory, same-volume rename; never fall back to deleting the destination or to
    // a copy/delete move. Windows rename without REPLACE_EXISTING cannot update preferences.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "rw-preferences-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> std::path::PathBuf {
            self.0.join("ai-preferences.json")
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn failed_write_sync_or_replace_preserves_old_file_and_cleans_temp() {
        for stage in [Stage::Write, Stage::Sync, Stage::Replace] {
            let dir = Directory::new();
            let path = dir.path();
            std::fs::write(&path, b"old settings").unwrap();
            let result = save_with(&path, b"new settings", |at| {
                if at == stage {
                    Err(io::Error::other("injected disk failure"))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"old settings");
            assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
        }
    }
    #[test]
    fn replaces_existing_file_and_creates_missing_file() {
        let dir = Directory::new();
        save(&dir.path(), b"first").unwrap();
        save(&dir.path(), b"second").unwrap();
        assert_eq!(std::fs::read(dir.path()).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
    }
    #[test]
    fn actual_replace_failure_preserves_target_and_cleans_temp() {
        let dir = Directory::new();
        std::fs::create_dir(dir.path()).unwrap();
        assert!(save(&dir.path(), b"settings").is_err());
        assert!(dir.path().is_dir());
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
    }
    #[test]
    fn startup_only_removes_our_interrupted_regular_temporary_files() {
        let dir = Directory::new();
        for name in [
            ".ai-preferences.json.rw-123-7.tmp",
            "ai-preferences.json",
            ".ai-preferences.json.rw-user-backup.tmp",
            ".other.json.rw-123-7.tmp",
        ] {
            std::fs::write(dir.0.join(name), b"preserve unrelated data").unwrap();
        }
        std::fs::create_dir(dir.0.join(".ai-preferences.json.rw-456-8.tmp")).unwrap();
        cleanup_interrupted(&dir.path());
        assert!(!dir.0.join(".ai-preferences.json.rw-123-7.tmp").exists());
        assert!(dir.0.join("ai-preferences.json").is_file());
        assert!(dir
            .0
            .join(".ai-preferences.json.rw-user-backup.tmp")
            .is_file());
        assert!(dir.0.join(".other.json.rw-123-7.tmp").is_file());
        assert!(dir.0.join(".ai-preferences.json.rw-456-8.tmp").is_dir());
    }
}
