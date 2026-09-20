//! launchd owns the two per-user services independently of the mail window.
//! Versioned runtime copies remain valid while Dispatch.app is replaced.
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use serde_json::Value;
use crate::sidecars::{service_env, Service};

fn label(service: Service) -> String { format!("com.taikun.dispatch.{}", service.name()) }
fn domain() -> String { format!("gui/{}", unsafe { libc::getuid() }) }
fn target(service: Service) -> String { format!("{}/{}", domain(), label(service)) }
fn loaded(service: Service) -> bool { Command::new("/bin/launchctl").args(["print", &target(service)]).output().map(|output| output.status.success()).unwrap_or(false) }

fn xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

pub fn plist(service: Service, runtime: &Path, logs: &Path, codex: Option<&Path>, id: &str) -> String {
    let mut env = service_env(service, codex, false, &std::env::var("PATH").unwrap_or_default());
    env.retain(|(key, _)| key != "DISPATCH_PARENT_PID");
    if let Ok(value) = std::env::var("CODEX_HOME") { env.push(("CODEX_HOME".into(), value)); }
    env.push(("DISPATCH_RUNTIME_ID".into(), id.into()));
    let variables = env.iter().map(|(key, value)| format!("<key>{}</key><string>{}</string>", xml(key), xml(value))).collect::<String>();
    let node = xml(&runtime.join("node").to_string_lossy());
    let script = xml(&runtime.join(service.script()).to_string_lossy());
    let log = xml(&logs.join(service.log_name()).to_string_lossy());
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array><string>{node}</string><string>{script}</string></array><key>EnvironmentVariables</key><dict>{variables}</dict><key>WorkingDirectory</key><string>{}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>{log}</string><key>StandardErrorPath</key><string>{log}</string></dict></plist>", label(service), xml(&runtime.to_string_lossy()))
}

pub fn probe(service: Service, endpoint: &str) -> Result<Value, String> {
    request(service, endpoint, "GET")
}

fn request(service: Service, endpoint: &str, method: &str) -> Result<Value, String> {
    let control = if method == "POST" {
        let health = probe(service, "/health")?;
        let id = health["runtimeId"].as_str().ok_or("Missing runtime identity")?;
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid runtime identity".into()); }
        format!("X-Dispatch-Runtime: {id}\r\n")
    } else { String::new() };
    let address = SocketAddr::from(([127, 0, 0, 1], service.port()));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    write!(stream, "{method} {endpoint} HTTP/1.0\r\nHost: 127.0.0.1\r\n{control}Content-Length: 0\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream.take(65536).read_to_string(&mut response).map_err(|e| e.to_string())?;
    let body = response.split_once("\r\n\r\n").ok_or("Invalid service response")?.1;
    let value: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if value["service"] != format!("dispatch-{}", service.name()) { return Err("Another application owns a Dispatch port".into()); }
    Ok(value)
}

fn all_services_idle(idle: &[bool]) -> bool {
    idle.iter().copied().all(|value| value)
}

/// Drain loaded services so an app replacement can proceed.
pub fn prepare_for_app_update() -> Result<(), String> {
    if drain()? {
        Ok(())
    } else {
        Err("Codex or a mail operation is still working. Let it finish before installing the update.".into())
    }
}

/// Resume drained services after a failed install so mail and Codex stay usable.
pub fn resume_after_failed_app_update() {
    for service in Service::ALL {
        if loaded(service) {
            let _ = request(service, "/v1/runtime/resume", "POST");
        }
    }
}

fn drain() -> Result<bool, String> {
    let mut drained = Vec::new();
    for service in [Service::Agent, Service::Mail] {
        if loaded(service) {
            let status = request(service, "/v1/runtime/drain", "POST");
            match status {
                Ok(value) if value["draining"] == true && value["activeOperations"] == 0 => drained.push(service),
                other => {
                    for item in drained { let _ = request(item, "/v1/runtime/resume", "POST"); }
                    return match other { Ok(_) => Ok(false), Err(error) => Err(error) };
                }
            }
        }
    }
    Ok(true)
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let destination = target.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() { copy_tree(&entry.path(), &destination)?; }
        else { fs::copy(entry.path(), destination).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

fn stage(resources: &Path, home: &Path, id: &str) -> Result<PathBuf, String> {
    let root = home.join("Library/Application Support/Dispatch/runtimes");
    let destination = root.join(id);
    if destination.join("complete").is_file() { return Ok(destination); }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let temporary = root.join(format!(".staging-{}", std::process::id()));
    if temporary.exists() { fs::remove_dir_all(&temporary).map_err(|e| e.to_string())?; }
    copy_tree(&resources.join("services"), &temporary.join("services"))?;
    let node = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("Missing application directory")?.join("node");
    fs::copy(node, temporary.join("node")).map_err(|e| e.to_string())?;
    fs::write(temporary.join("complete"), id).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
    Ok(destination)
}

/// Boots the job out and waits until launchd has released its registration.
/// `bootout` returns as soon as the request is accepted; the agent, which has a
/// Codex child to tear down, can stay listed for a while afterwards, and a
/// caller that saw it as still loaded would skip bootstrapping the new job.
fn unload(service: Service) -> Result<(), String> {
    if !loaded(service) { return Ok(()); }
    let result = Command::new("/bin/launchctl").args(["bootout", &target(service)]).output().map_err(|e| e.to_string())?;
    if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).to_string()); }
    let deadline = Instant::now() + Duration::from_secs(15);
    while loaded(service) {
        if Instant::now() >= deadline { return Err(format!("The {} service did not stop within 15 seconds. Quit Dispatch and open it again.", service.name())); }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

/// A loaded job is kept only when it answers with the runtime this app ships;
/// a job that is listed but silent or on another runtime is replaced.
fn needs_bootstrap(loaded: bool, health_runtime: Option<&str>, id: &str) -> bool {
    !loaded || health_runtime != Some(id)
}

fn needs_runtime_drain(health_runtime: Option<&str>, id: &str) -> bool {
    health_runtime.is_some_and(|current| current != id)
}

fn bootstrap(service: Service, path: &Path, id: &str) -> Result<(), String> {
    // bootout can return before launchd releases the old job's registration.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = Command::new("/bin/launchctl").arg("bootstrap").arg(domain()).arg(path).output().map_err(|e| e.to_string())?;
        if result.status.success() { return Ok(()); }
        if loaded(service) && probe(service, "/health").map(|value| value["runtimeId"] == id).unwrap_or(false) { return Ok(()); }
        if result.status.code() != Some(5) || Instant::now() >= deadline { return Err(format!("Could not start {}: {}", service.name(), String::from_utf8_lossy(&result.stderr))); }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Returns false when a runtime update must wait for active work to finish.
pub fn start(resources: &Path, home: &Path, logs: &Path, codex: Option<&Path>) -> Result<bool, String> {
    let id = fs::read_to_string(resources.join("services/runtime-id")).map_err(|e| format!("Runtime manifest is missing: {e}"))?;
    let id = id.trim();
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid runtime manifest".into()); }
    let mut update = false;
    for service in Service::ALL {
        if loaded(service) {
            // A launchd job can remain listed after its executable crashes.
            // Let the bootstrap pass unload that silent job instead of making
            // every subsequent app launch fail at this probe.
            let health_runtime = probe(service, "/health").ok()
                .and_then(|health| health["runtimeId"].as_str().map(str::to_owned));
            if needs_runtime_drain(health_runtime.as_deref(), id) { update = true; }
        } else if !crate::preflight::open_ports(&[service.port()]).is_empty() {
            return Err(crate::preflight::describe_port_conflict(&[service.port()]));
        }
    }
    let runtime = stage(resources, home, id)?;
    if update {
        if !drain()? { return Ok(false); }
        for service in Service::ALL { unload(service)?; }
        let occupied = crate::preflight::wait_for_ports(&[8411, 8412], Duration::from_secs(5));
        if !occupied.is_empty() { return Err(crate::preflight::describe_port_conflict(&occupied)); }
    }
    let agents = home.join("Library/LaunchAgents");
    fs::create_dir_all(&agents).map_err(|e| e.to_string())?;
    fs::create_dir_all(logs).map_err(|e| e.to_string())?;
    for service in Service::ALL {
        let is_loaded = loaded(service);
        let health_runtime = if is_loaded { probe(service, "/health").ok().and_then(|value| value["runtimeId"].as_str().map(str::to_owned)) } else { None };
        if !needs_bootstrap(is_loaded, health_runtime.as_deref(), id) { continue; }
        if is_loaded { unload(service)?; }
        let path = agents.join(format!("{}.plist", label(service)));
        let temporary = path.with_extension("plist.tmp");
        fs::write(&temporary, plist(service, &runtime, logs, codex, id)).map_err(|e| e.to_string())?;
        fs::rename(temporary, &path).map_err(|e| e.to_string())?;
        bootstrap(service, &path, id)?;
    }
    Ok(true)
}

pub fn restart(resources: &Path, home: &Path, logs: &Path, codex: Option<&Path>) -> Result<(), String> {
    if !drain()? { return Err("Codex or a mail operation is still working. Let it finish before restarting services.".into()); }
    for service in Service::ALL { unload(service)?; }
    let occupied = crate::preflight::wait_for_ports(&[8411, 8412], Duration::from_secs(5));
    if !occupied.is_empty() { return Err(crate::preflight::describe_port_conflict(&occupied)); }
    start(resources, home, logs, codex).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_agents_have_independent_lifetimes_and_versioned_paths() {
        let value = plist(Service::Agent, Path::new("/user/runtime/abc"), Path::new("/user/logs"), Some(Path::new("/Applications/Codex & Tools/codex")), "abc");
        assert!(value.contains("com.taikun.dispatch.agent"));
        assert!(value.contains("/user/runtime/abc/node"));
        assert!(value.contains("<key>KeepAlive</key><true/>"));
        assert!(value.contains("Codex &amp; Tools"));
        assert!(!value.contains("DISPATCH_PARENT_PID"));
        assert!(value.contains("DISPATCH_RUNTIME_ID"));
    }
    #[test]
    fn a_job_is_kept_only_when_it_answers_with_the_shipped_runtime() {
        assert!(needs_bootstrap(false, None, "abc"));
        assert!(needs_bootstrap(true, None, "abc"), "listed but silent: launchd is still tearing it down or it is crash-looping");
        assert!(needs_bootstrap(true, Some("old"), "abc"));
        assert!(!needs_bootstrap(true, Some("abc"), "abc"));
        assert!(!needs_runtime_drain(None, "abc"), "a crashed job must be re-bootstrapped without draining healthy services");
        assert!(needs_runtime_drain(Some("old"), "abc"));
    }
    #[test]
    fn labels_keep_mail_and_agent_as_independent_jobs() {
        assert_ne!(label(Service::Mail), label(Service::Agent));
        let value = plist(Service::Mail, Path::new("/runtime"), Path::new("/logs"), None, "id");
        assert!(value.contains("/runtime/services/mail/server.js"));
        assert!(!value.contains("DISPATCH_CODEX_COMMAND"));
    }

    #[test]
    fn update_requires_every_loaded_service_to_be_idle() {
        assert!(all_services_idle(&[true, true]));
        assert!(!all_services_idle(&[true, false]));
    }
}
