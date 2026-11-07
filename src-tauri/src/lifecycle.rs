//! Bounded child shutdown. The caller retains ownership until exit is confirmed.
use std::io;
use std::process::Child;
use std::time::{Duration, Instant};

pub trait Process {
    fn has_exited(&mut self) -> io::Result<bool>;
    fn kill(&mut self) -> io::Result<()>;
}
impl Process for Child {
    fn has_exited(&mut self) -> io::Result<bool> {
        self.try_wait().map(|exit| exit.is_some())
    }
    fn kill(&mut self) -> io::Result<()> {
        Child::kill(self)
    }
}
pub fn terminate(process: &mut impl Process, grace: Duration) -> io::Result<()> {
    let deadline = Instant::now() + grace;
    loop {
        if matches!(process.has_exited(), Ok(true)) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if let Err(error) = process.kill() {
        // A process may have exited between try_wait and kill.
        return if matches!(process.has_exited(), Ok(true)) {
            Ok(())
        } else {
            Err(error)
        };
    }
    let deadline = Instant::now() + grace;
    loop {
        if process.has_exited()? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "child exit was not confirmed",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        exited: bool,
        kill_fails: bool,
        exit_after_kill: bool,
        kills: usize,
    }
    impl Process for Fake {
        fn has_exited(&mut self) -> io::Result<bool> {
            Ok(self.exited)
        }
        fn kill(&mut self) -> io::Result<()> {
            self.kills += 1;
            if self.kill_fails {
                return Err(io::Error::other("injected stop failure"));
            }
            self.exited = self.exit_after_kill;
            Ok(())
        }
    }
    #[test]
    fn failed_kill_is_not_a_successful_stop() {
        let mut child = Fake {
            exited: false,
            kill_fails: true,
            exit_after_kill: false,
            kills: 0,
        };
        assert!(terminate(&mut child, Duration::ZERO).is_err());
        assert!(!child.exited);
    }
    #[test]
    fn successful_kill_without_confirmed_exit_is_not_a_successful_stop() {
        let mut child = Fake {
            exited: false,
            kill_fails: false,
            exit_after_kill: false,
            kills: 0,
        };
        assert!(terminate(&mut child, Duration::ZERO).is_err());
    }
    #[test]
    fn already_exited_child_is_not_killed() {
        let mut child = Fake {
            exited: true,
            kill_fails: true,
            exit_after_kill: false,
            kills: 0,
        };
        assert!(terminate(&mut child, Duration::ZERO).is_ok());
        assert_eq!(child.kills, 0);
    }
    #[test]
    fn confirmed_exit_after_kill_allows_replacement() {
        let mut child = Fake {
            exited: false,
            kill_fails: false,
            exit_after_kill: true,
            kills: 0,
        };
        assert!(terminate(&mut child, Duration::ZERO).is_ok());
        assert!(child.exited);
    }
}
