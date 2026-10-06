//! Native print dialog for a trusted Dispatch mail view. The web client owns
//! the printable email; this adapter grants no filesystem or printer controls.
use tauri::{AppHandle, Emitter, Manager, Webview};

pub const REQUEST_PRINT: &str = "dispatch://print-email";

#[tauri::command]
pub fn print_email(app: AppHandle, webview: Webview) -> Result<(), String> {
    super::web_links::trusted_mail_view(&app, &webview)?;
    webview.print().map_err(|error| format!("Could not open the print dialog: {error}"))
}

pub fn request_from_menu(app: &AppHandle) -> Result<(), String> {
    for window in app.webview_windows().values() {
        if window.is_focused().map_err(|error| error.to_string())? {
            super::web_links::trusted_mail_view(app, window.as_ref())?;
            return app.emit_to(window.label(), REQUEST_PRINT, ()).map_err(|error| error.to_string());
        }
    }
    Err("Select an email in Dispatch to print.".into())
}
