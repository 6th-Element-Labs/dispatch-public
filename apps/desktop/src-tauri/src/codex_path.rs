//! Locates the installed `codex` CLI for the agent sidecar.
//!
//! An app launched from Finder inherits a minimal PATH, so the lookup is
//! explicit and ordered. Nothing is invented when the search fails: the agent
//! service reports Codex as not ready, and the searched locations are logged.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Resolution {
    pub path: Option<PathBuf>,
    pub searched: Vec<PathBuf>,
}

const DESKTOP_BUNDLES: [&str; 2] = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
];
const WELL_KNOWN: [&str; 2] = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
const HOME_RELATIVE: [&str; 2] = [".local/bin/codex", ".npm-global/bin/codex"];

/// Every location tried, in priority order, before the login shell is asked.
pub fn candidates(overridden: Option<&str>, path_var: Option<&str>, home: &Path) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(value) = overridden.map(str::trim).filter(|value| !value.is_empty()) {
        list.push(PathBuf::from(value));
    }
    // Keep the embedded experience on the same runtime and catalog as Codex Desktop.
    list.extend(DESKTOP_BUNDLES.iter().map(PathBuf::from));
    for directory in path_var.unwrap_or("").split(':').filter(|d| !d.is_empty()) {
        list.push(Path::new(directory).join("codex"));
    }
    list.extend(WELL_KNOWN.iter().map(PathBuf::from));
    list.extend(HOME_RELATIVE.iter().map(|relative| home.join(relative)));
    list
}

pub fn resolve(
    overridden: Option<&str>,
    path_var: Option<&str>,
    home: &Path,
    is_executable: &dyn Fn(&Path) -> bool,
    login_shell: &dyn Fn() -> Option<PathBuf>,
) -> Resolution {
    let mut searched = Vec::new();
    for candidate in candidates(overridden, path_var, home) {
        searched.push(candidate.clone());
        if is_executable(&candidate) {
            return Resolution { path: Some(candidate), searched };
        }
    }
    match login_shell() {
        Some(found) if is_executable(&found) => {
            searched.push(found.clone());
            Resolution { path: Some(found), searched }
        }
        Some(found) => {
            searched.push(found);
            Resolution { path: None, searched }
        }
        None => {
            searched.push(PathBuf::from("/bin/zsh -lc 'command -v codex'"));
            Resolution { path: None, searched }
        }
    }
}

/// Real filesystem and login-shell wiring.
pub fn resolve_from_environment(home: &Path) -> Resolution {
    let overridden = std::env::var("DISPATCH_CODEX_COMMAND").ok();
    let path_var = std::env::var("PATH").ok();
    resolve(
        overridden.as_deref(),
        path_var.as_deref(),
        home,
        &is_executable_file,
        &login_shell_lookup,
    )
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// `/bin/zsh -lc 'command -v codex'` with a hard 3 second limit.
fn login_shell_lookup() -> Option<PathBuf> {
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", "command -v codex"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut output = String::new();
                use std::io::Read;
                child.stdout.take()?.read_to_string(&mut output).ok()?;
                let line = output.lines().next()?.trim();
                return (!line.is_empty()).then(|| PathBuf::from(line));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/tester")
    }

    #[test]
    fn override_wins_when_executable() {
        let executable = |path: &Path| path == Path::new("/custom/codex");
        let shell = || None;
        let result = resolve(Some("/custom/codex"), Some("/usr/bin"), &home(), &executable, &shell);
        assert_eq!(result.path, Some(PathBuf::from("/custom/codex")));
        assert_eq!(result.searched, vec![PathBuf::from("/custom/codex")]);
    }

    #[test]
    fn desktop_runtime_precedes_path_and_cli_fallbacks() {
        let list = candidates(None, Some("/a:/b"), &home());
        assert_eq!(
            list,
            vec![
                PathBuf::from(DESKTOP_BUNDLES[0]),
                PathBuf::from(DESKTOP_BUNDLES[1]),
                PathBuf::from("/a/codex"),
                PathBuf::from("/b/codex"),
                PathBuf::from("/opt/homebrew/bin/codex"),
                PathBuf::from("/usr/local/bin/codex"),
                PathBuf::from("/Users/tester/.local/bin/codex"),
                PathBuf::from("/Users/tester/.npm-global/bin/codex"),
            ]
        );
    }

    #[test]
    fn desktop_runtime_wins_over_an_older_path_cli() {
        let executable = |path: &Path| path == Path::new(DESKTOP_BUNDLES[1]) || path == Path::new("/opt/homebrew/bin/codex");
        let result = resolve(None, Some("/opt/homebrew/bin"), &home(), &executable, &|| None);
        assert_eq!(result.path, Some(PathBuf::from(DESKTOP_BUNDLES[1])));
    }

    #[test]
    fn explicit_override_still_wins_over_desktop_runtime() {
        let executable = |_: &Path| true;
        let result = resolve(Some("/custom/codex"), Some("/opt/homebrew/bin"), &home(), &executable, &|| None);
        assert_eq!(result.path, Some(PathBuf::from("/custom/codex")));
    }

    #[test]
    fn homebrew_is_found_when_path_is_minimal() {
        let executable = |path: &Path| path == Path::new("/opt/homebrew/bin/codex");
        let shell = || panic!("login shell must not run when a candidate matched");
        let result = resolve(None, Some("/usr/bin:/bin"), &home(), &executable, &shell);
        assert_eq!(result.path, Some(PathBuf::from("/opt/homebrew/bin/codex")));
        assert_eq!(result.searched.len(), 3 + DESKTOP_BUNDLES.len());
    }

    #[test]
    fn login_shell_is_last_resort_and_recorded() {
        let executable = |path: &Path| path == Path::new("/weird/place/codex");
        let shell = || Some(PathBuf::from("/weird/place/codex"));
        let result = resolve(None, Some("/usr/bin"), &home(), &executable, &shell);
        assert_eq!(result.path, Some(PathBuf::from("/weird/place/codex")));
        assert_eq!(result.searched.last(), Some(&PathBuf::from("/weird/place/codex")));
    }

    #[test]
    fn nothing_found_reports_every_location_and_no_path() {
        let executable = |_: &Path| false;
        let shell = || None;
        let result = resolve(None, Some("/usr/bin"), &home(), &executable, &shell);
        assert_eq!(result.path, None);
        assert_eq!(result.searched.len(), 6 + DESKTOP_BUNDLES.len());
        assert!(result.searched.last().unwrap().to_string_lossy().contains("zsh"));
    }
}
