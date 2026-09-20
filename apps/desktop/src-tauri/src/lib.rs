//! Dispatch macOS shell.
//!
//! This crate composes a native window around the existing Dispatch web client
//! and supervises the mail and agent services as bundled-Node sidecars. It owns
//! no product behavior: mail, agent, and presentation logic stay in `services/`.

mod appearance;
mod codex_path;
mod context_menu;
mod menu;
mod preflight;
mod sidecars;
mod background;
mod updater;
mod web_links;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, RunEvent, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use sidecars::{Service, Supervisor};

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(context_menu::ContextMenuPending::default())
        .manage(appearance::AppearanceMenu::<tauri::Wry>::default())
        .manage(updater::UpdateCoordinator::default())
        .manage(web_links::WebLinks::default())
        .invoke_handler(tauri::generate_handler![context_menu::popup_context_menu, web_links::open_web_link, web_links::web_link_state, web_links::web_link_action, appearance::set_appearance])
        .setup(|app| {
            let handle = app.handle().clone();
            let resources = handle.path().resource_dir()?;
            let home = handle.path().home_dir()?;
            let logs = home.join("Library").join("Logs").join("Dispatch");

            let resolution = codex_path::resolve_from_environment(&home);
            let supervisor = Supervisor::new(resources, logs, resolution.path.clone());

            let mut required = vec![sidecar_binary()];
            required.extend(supervisor.scripts());
            let missing = preflight::missing_files(&required);
            if !missing.is_empty() {
                fatal(&handle, &preflight::describe_missing(&missing));
            }
            let ports: Vec<u16> = Service::ALL.iter().map(|service| service.port()).collect();
            let open = if sidecars::persistent() { vec![] } else { preflight::wait_for_ports(&ports, std::time::Duration::from_secs(5)) };
            if !open.is_empty() {
                fatal(&handle, &preflight::describe_port_conflict(&open));
            }

            if resolution.path.is_none() {
                let searched = resolution
                    .searched
                    .iter()
                    .map(|path| format!("  {}", path.display()))
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = std::fs::create_dir_all(supervisor.logs_dir());
                supervisor.append(Service::Agent, &format!("dispatch: codex was not found. Searched:\n{searched}"));
            }

            if let Err(message) = supervisor.start(&handle) {
                fatal(&handle, &message);
            }
            app.manage(supervisor);
            updater::spawn_post_launch_check(handle.clone());

            web_links::create_mail_window(&handle)?;
            handle.set_menu(menu::build(&handle)?)?;
            handle.on_menu_event(|app, event| match event.id().as_ref() {
                menu::RESTART_SERVICES => {
                    if let Err(message) = app.state::<Supervisor>().restart(app) {
                        show_error(app, "Dispatch could not restart its services", &message);
                    }
                }
                menu::CHECK_FOR_UPDATES => updater::check_from_menu(app.clone()),
                menu::OPEN_LOGS => {
                    let logs = app.state::<Supervisor>().logs_dir().to_path_buf();
                    let _ = std::fs::create_dir_all(&logs);
                    if let Err(error) = app.opener().open_path(logs.to_string_lossy(), None::<&str>) {
                        show_error(app, "Dispatch could not open its log folder", &error.to_string());
                    }
                }
                menu::RETURN_TO_MAIL => web_links::return_to_mail(app),
                appearance::SYSTEM | appearance::LIGHT | appearance::DARK => {
                    if let Err(message) = appearance::choose(app, event.id().as_ref()) {
                        show_error(app, "Dispatch could not change its appearance", &message);
                    }
                }
                menu::WEB_BACK | menu::WEB_FORWARD | menu::WEB_RELOAD => {
                    let action = match event.id().as_ref() { menu::WEB_BACK => "back", menu::WEB_FORWARD => "forward", _ => "reload" };
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || { if let Err(error) = web_links::perform_action(&app, action) { show_error(&app, "Web navigation unavailable", &error); } });
                }
                id => context_menu::record_choice(app, id),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Dispatch failed to build its Tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(supervisor) = app.try_state::<Supervisor>() {
                supervisor.stop();
            }
        }
    });
}

/// Where Tauri places the `node` sidecar: beside the main executable.
fn sidecar_binary() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(sidecars::SIDECAR)))
        .unwrap_or_else(|| PathBuf::from(sidecars::SIDECAR))
}

fn show_error<R: Runtime>(app: &AppHandle<R>, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn fatal<R: Runtime>(app: &AppHandle<R>, message: &str) -> ! {
    eprintln!("dispatch: {message}");
    show_error(app, "Dispatch cannot start", message);
    std::process::exit(1)
}
