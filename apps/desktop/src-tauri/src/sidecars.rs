//! Spawns and supervises the mail and agent services with the bundled Node.
//!
//! Services are not respawned automatically. A child that exits is written to
//! its log; the web client already shows the failed state, and the user can
//! choose Dispatch > Restart Services.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const SIDECAR: &str = "node";
pub const BROWSER_ORIGIN: &str = "http://127.0.0.1:8410";
pub const NATIVE_ORIGIN: &str = "tauri://localhost";
const EXTRA_PATH: &str = "/opt/homebrew/bin:/usr/local/bin";
pub fn persistent() -> bool { cfg!(target_os = "macos") && !tauri::is_dev() }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    Mail,
    Agent,
}

impl Service {
    pub const ALL: [Service; 2] = [Service::Mail, Service::Agent];

    pub fn name(self) -> &'static str {
        match self {
            Service::Mail => "mail",
            Service::Agent => "agent",
        }
    }

    pub fn port(self) -> u16 {
        match self {
            Service::Mail => 8411,
            Service::Agent => 8412,
        }
    }

    /// Path of the compiled entry point below the Tauri resource directory.
    pub fn script(self) -> &'static str {
        match self {
            Service::Mail => "services/mail/server.js",
            Service::Agent => "services/agent/server.js",
        }
    }

    pub fn log_name(self) -> &'static str {
        match self {
            Service::Mail => "mail.log",
            Service::Agent => "agent.log",
        }
    }
}

/// Environment handed to one service, including its native process owner.
pub fn service_env(
    service: Service,
    codex: Option<&Path>,
    dev: bool,
    inherited_path: &str,
) -> Vec<(String, String)> {
    let mut env = vec![("DISPATCH_PARENT_PID".to_string(), std::process::id().to_string()),
        (
            match service {
                Service::Mail => "DISPATCH_MAIL_PORT",
                Service::Agent => "DISPATCH_AGENT_PORT",
            }
            .to_string(),
            service.port().to_string(),
        ),
        (
            "DISPATCH_ALLOWED_ORIGIN".to_string(),
            if dev { BROWSER_ORIGIN } else { NATIVE_ORIGIN }.to_string(),
        ),
        (
            "PATH".to_string(),
            if inherited_path.is_empty() {
                EXTRA_PATH.to_string()
            } else {
                format!("{inherited_path}:{EXTRA_PATH}")
            },
        ),
    ];
    if service == Service::Agent {
        if let Some(codex) = codex {
            env.push(("DISPATCH_CODEX_COMMAND".to_string(), codex.display().to_string()));
        }
    }
    env
}

pub struct Supervisor {
    resources: PathBuf,
    logs: PathBuf,
    codex: Option<PathBuf>,
    children: Mutex<Vec<(Service, CommandChild)>>,
    alive: Arc<AtomicBool>,
    maintenance: Arc<Mutex<()>>,
}

impl Supervisor {
    pub fn new(resources: PathBuf, logs: PathBuf, codex: Option<PathBuf>) -> Self {
        Self { resources, logs, codex, children: Mutex::new(Vec::new()), alive: Arc::new(AtomicBool::new(true)), maintenance: Arc::new(Mutex::new(())) }
    }

    pub fn scripts(&self) -> Vec<PathBuf> {
        Service::ALL.iter().map(|service| self.resources.join(service.script())).collect()
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs
    }

    pub fn start<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        if persistent() {
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            let _guard = self.maintenance.lock().map_err(|e| e.to_string())?;
            let current = crate::background::start(&self.resources, &home, &self.logs, self.codex.as_deref())?;
            if !current {
                self.append(Service::Agent, "dispatch: runtime update waiting for active work");
                let (resources, logs, codex, alive, maintenance) = (self.resources.clone(), self.logs.clone(), self.codex.clone(), self.alive.clone(), self.maintenance.clone());
                std::thread::spawn(move || {
                    while alive.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_secs(5));
                        if !alive.load(Ordering::Relaxed) { break; }
                        let Ok(_guard) = maintenance.lock() else { break; };
                        match crate::background::start(&resources, &home, &logs, codex.as_deref()) {
                            Ok(true) => break,
                            Ok(false) => continue,
                            Err(error) => { eprintln!("Dispatch background update: {error}"); break; }
                        }
                    }
                });
            }
            return Ok(());
        }
        std::fs::create_dir_all(&self.logs)
            .map_err(|error| format!("Could not create {}: {error}", self.logs.display()))?;
        let inherited_path = std::env::var("PATH").unwrap_or_default();
        let mut spawned = Vec::new();
        for service in Service::ALL {
            let script = self.resources.join(service.script());
            let env = service_env(service, self.codex.as_deref(), tauri::is_dev(), &inherited_path);
            let (receiver, child) = app
                .shell()
                .sidecar(SIDECAR)
                .map_err(|error| format!("The bundled Node runtime is unavailable: {error}"))?
                .args([script.as_os_str()])
                .envs(env)
                .spawn()
                .map_err(|error| format!("Could not start the {} service: {error}", service.name()))?;
            self.append(service, &format!("dispatch: started {} (pid {})", service.name(), child.pid()));
            spawned.push((service, child));
            self.pipe(service, receiver);
        }
        let mut children = self.children.lock().map_err(|_| "supervisor state poisoned".to_string())?;
        children.extend(spawned);
        Ok(())
    }

    /// SIGTERM every child, wait up to three seconds, then SIGKILL survivors.
    pub fn stop(&self) {
        self.alive.store(false, Ordering::Relaxed);
        if persistent() { return; }
        let Ok(mut children) = self.children.lock() else { return };
        let taken: Vec<(Service, CommandChild)> = children.drain(..).collect();
        for (_, child) in &taken {
            unsafe { libc::kill(child.pid() as i32, libc::SIGTERM) };
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline
            && taken.iter().any(|(_, child)| unsafe { libc::kill(child.pid() as i32, 0) } == 0)
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        for (service, child) in taken {
            if unsafe { libc::kill(child.pid() as i32, 0) } == 0 {
                self.append(service, "dispatch: service ignored SIGTERM; sending SIGKILL");
                let _ = child.kill();
            }
        }
    }

    pub fn restart<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        if persistent() {
            let _guard = self.maintenance.lock().map_err(|e| e.to_string())?;
            let home = app.path().home_dir().map_err(|e| e.to_string())?;
            return crate::background::restart(&self.resources, &home, &self.logs, self.codex.as_deref());
        }
        self.stop();
        self.start(app)
    }

    pub fn append(&self, service: Service, line: &str) {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(self.logs.join(service.log_name())) {
            let _ = writeln!(file, "{line}");
        }
    }

    fn pipe(&self, service: Service, mut receiver: tauri::async_runtime::Receiver<CommandEvent>) {
        let log_path = self.logs.join(service.log_name());
        tauri::async_runtime::spawn(async move {
            let mut file = OpenOptions::new().create(true).append(true).open(&log_path).ok();
            while let Some(event) = receiver.recv().await {
                let line = match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        String::from_utf8_lossy(&bytes).trim_end().to_string()
                    }
                    CommandEvent::Error(message) => format!("dispatch: sidecar error: {message}"),
                    CommandEvent::Terminated(payload) => format!(
                        "dispatch: {} exited (code {:?}, signal {:?})",
                        service.name(),
                        payload.code,
                        payload.signal
                    ),
                    _ => continue,
                };
                eprintln!("[{}] {line}", service.name());
                if let Some(file) = file.as_mut() {
                    let _ = writeln!(file, "{line}");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn mail_release_env_targets_the_native_origin_and_omits_codex() {
        let env = service_env(Service::Mail, Some(Path::new("/x/codex")), false, "/usr/bin");
        assert_eq!(value(&env, "DISPATCH_PARENT_PID"), Some(std::process::id().to_string().as_str()));
        assert_eq!(value(&env, "DISPATCH_MAIL_PORT"), Some("8411"));
        assert_eq!(value(&env, "DISPATCH_ALLOWED_ORIGIN"), Some("tauri://localhost"));
        assert_eq!(value(&env, "PATH"), Some("/usr/bin:/opt/homebrew/bin:/usr/local/bin"));
        assert_eq!(value(&env, "DISPATCH_CODEX_COMMAND"), None);
        assert_eq!(value(&env, "DISPATCH_AGENT_PORT"), None);
    }

    #[test]
    fn agent_dev_env_targets_the_browser_origin_and_pins_codex() {
        let env = service_env(Service::Agent, Some(Path::new("/x/codex")), true, "");
        assert_eq!(value(&env, "DISPATCH_AGENT_PORT"), Some("8412"));
        assert_eq!(value(&env, "DISPATCH_ALLOWED_ORIGIN"), Some("http://127.0.0.1:8410"));
        assert_eq!(value(&env, "PATH"), Some("/opt/homebrew/bin:/usr/local/bin"));
        assert_eq!(value(&env, "DISPATCH_CODEX_COMMAND"), Some("/x/codex"));
    }

    #[test]
    fn agent_without_codex_sets_no_command_so_the_service_reports_it() {
        let env = service_env(Service::Agent, None, false, "/usr/bin");
        assert_eq!(value(&env, "DISPATCH_CODEX_COMMAND"), None);
    }

    #[test]
    fn scripts_live_under_the_resource_directory() {
        let supervisor = Supervisor::new(PathBuf::from("/res"), PathBuf::from("/logs"), None);
        assert_eq!(
            supervisor.scripts(),
            vec![PathBuf::from("/res/services/mail/server.js"), PathBuf::from("/res/services/agent/server.js")]
        );
    }
}
