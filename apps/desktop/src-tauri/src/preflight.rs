//! Checks that must pass before any sidecar is spawned. Every failure is
//! reported to the user and stops the launch; nothing here falls back.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Loopback ports that already accept a TCP connection. A Dispatch port that is
/// open before we start means another Dispatch or `scripts/dev.sh` owns it.
pub fn open_ports(ports: &[u16]) -> Vec<u16> {
    ports
        .iter()
        .copied()
        .filter(|port| {
            let address = SocketAddr::from(([127, 0, 0, 1], *port));
            TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
        })
        .collect()
}

/// Give orphan watchdogs a bounded grace period; never stop unknown port owners.
pub fn wait_for_ports(ports: &[u16], timeout: Duration) -> Vec<u16> {
    let deadline = Instant::now() + timeout;
    loop {
        let open = open_ports(ports);
        if open.is_empty() || Instant::now() >= deadline { return open; }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Paths that are not regular files.
pub fn missing_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths.iter().filter(|path| !path.is_file()).cloned().collect()
}

pub fn describe_port_conflict(ports: &[u16]) -> String {
    let list = ports
        .iter()
        .map(|port| format!("127.0.0.1:{port}"))
        .collect::<Vec<_>>()
        .join(" and ");
    format!(
        "Something is already listening on {list}.\n\nThat is usually another copy of Dispatch or scripts/dev.sh. Quit it, then open Dispatch again."
    )
}

pub fn describe_missing(paths: &[PathBuf]) -> String {
    let list = paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    format!("This build of Dispatch is incomplete. Missing:\n\n{list}\n\nRebuild with `npm --prefix apps/desktop run build:native`.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn detects_a_port_with_a_listener_and_ignores_a_free_one() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert_eq!(open_ports(&[port]), vec![port]);
        drop(listener);
        assert!(open_ports(&[port]).is_empty());
    }

    #[test]
    fn waits_for_exiting_owners_without_stopping_other_listeners() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(wait_for_ports(&[port], Duration::from_millis(10)), vec![port]);
        let thread = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(50)); drop(listener); });
        assert!(wait_for_ports(&[port], Duration::from_secs(1)).is_empty());
        thread.join().unwrap();
    }

    #[test]
    fn reports_missing_files_and_keeps_present_ones_out() {
        let present = std::env::current_exe().expect("exe");
        let absent = present.with_file_name("dispatch-definitely-missing-file");
        assert_eq!(missing_files(&[present.clone(), absent.clone()]), vec![absent]);
    }

    #[test]
    fn conflict_message_names_every_port() {
        let message = describe_port_conflict(&[8411, 8412]);
        assert!(message.contains("127.0.0.1:8411 and 127.0.0.1:8412"));
        assert!(message.contains("scripts/dev.sh"));
    }
}
