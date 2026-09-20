//! Native webview composition. Remote pages never replace the mail view or own its controls.
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, Url, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri_plugin_opener::OpenerExt;

const WINDOW: &str = "web-link";
const TOOLBAR: &str = "link-toolbar";
const CONTENT: &str = "link-content";
const GMAIL_PLUGIN_URL: &str = "codex://plugins/gmail@openai-curated";
// Reserve the native title bar as well as the 80px local controls.
const TOOLBAR_HEIGHT: f64 = 104.0;
#[derive(Default)]
pub struct WebLinks { opening: Mutex<()> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkState { url: String, can_go_back: bool, can_go_forward: bool }

fn web_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "This link is not a valid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS pages can open in the web window".into());
    }
    Ok(url)
}
fn external_app_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "This link is not a valid URL".to_string())?;
    if url.as_str() != GMAIL_PLUGIN_URL { return Err("This external app link is not allowed".into()); }
    Ok(url)
}
fn local_page(url: &Url, path: &str, dev: Option<&Url>) -> bool {
    let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || dev.is_some_and(|base| url.origin() == base.origin());
    origin && (url.path() == path || (path == "/" && (url.path().is_empty() || url.path() == "/index.html")))
}
fn trusted(app: &AppHandle, view: &Webview, label: &str, path: &str) -> Result<(), String> {
    let dev = if cfg!(debug_assertions) { app.config().build.dev_url.as_ref() } else { None };
    if view.label() != label || !local_page(&view.url().map_err(|e| e.to_string())?, path, dev) {
        return Err("This command is only available from Dispatch controls".into());
    }
    Ok(())
}
pub fn queue_open(app: &AppHandle, url: Url) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = open_page(&app, url) { super::show_error(&app, "Dispatch could not open this link", &error); }
    });
}
pub fn create_mail_window(app: &AppHandle) -> tauri::Result<()> {
    let navigation_app = app.clone();
    let popup_app = app.clone();
    let dev = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
    WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .on_navigation(move |url| {
            if local_page(url, "/", dev.as_ref()) { return true; }
            if web_url(url.as_str()).is_ok() { queue_open(&navigation_app, url.clone()); }
            false
        })
        .on_new_window(move |url, _| { if web_url(url.as_str()).is_ok() { queue_open(&popup_app, url); } NewWindowResponse::Deny })
        .build()?;
    Ok(())
}
fn layout(app: &AppHandle, size: PhysicalSize<u32>, scale: f64) {
    let top = (TOOLBAR_HEIGHT * scale).round() as u32;
    if let Some(view) = app.get_webview(TOOLBAR) {
        let _ = view.set_bounds(Rect { position: PhysicalPosition::new(0, 0).into(), size: PhysicalSize::new(size.width, top).into() });
    }
    if let Some(view) = app.get_webview(CONTENT) {
        let _ = view.set_bounds(Rect { position: PhysicalPosition::new(0, top as i32).into(), size: PhysicalSize::new(size.width, size.height.saturating_sub(top)).into() });
    }
}
fn open_page(app: &AppHandle, url: Url) -> Result<(), String> {
    let state = app.state::<WebLinks>();
    let _lock = state.opening.lock().map_err(|_| "Web window is unavailable")?;
    if let Some(view) = app.get_webview(CONTENT) {
        view.navigate(url).map_err(|e| e.to_string())?;
        view.window().show().map_err(|e| e.to_string())?;
        view.window().set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = WindowBuilder::new(app, WINDOW).title("Web link — Dispatch")
        .inner_size(1080.0, 800.0).min_inner_size(600.0, 420.0).build().map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        let dev = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
        window.add_child(WebviewBuilder::new(TOOLBAR, WebviewUrl::App("browser.html".into()))
            .on_navigation(move |url| local_page(url, "/browser.html", dev.as_ref()))
            .on_new_window(|_, _| NewWindowResponse::Deny),
            tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1080.0, TOOLBAR_HEIGHT)).map_err(|e| e.to_string())?;
        let popup_app = app.clone();
        window.add_child(WebviewBuilder::new(CONTENT, WebviewUrl::External(url))
            .on_navigation(|url| web_url(url.as_str()).is_ok())
            .on_new_window(move |url, _| {
                // Keep target=_blank pages inside the same controlled viewer.
                if web_url(url.as_str()).is_ok() { queue_open(&popup_app, url); }
                NewWindowResponse::Deny
            }), tauri::LogicalPosition::new(0.0, TOOLBAR_HEIGHT), tauri::LogicalSize::new(1080.0, 800.0 - TOOLBAR_HEIGHT)).map_err(|e| e.to_string())?;
        let event_app = app.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::Resized(size) => if let Some(window) = event_app.get_window(WINDOW) { layout(&event_app, *size, window.scale_factor().unwrap_or(1.0)); },
            WindowEvent::ScaleFactorChanged { scale_factor, new_inner_size, .. } => layout(&event_app, *new_inner_size, *scale_factor),
            WindowEvent::Destroyed => focus_mail(&event_app),
            _ => {}
        });
        layout(app, window.inner_size().map_err(|e| e.to_string())?, window.scale_factor().map_err(|e| e.to_string())?);
        window.set_focus().map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = window.close(); }
    result
}
fn focus_mail(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
}
pub fn return_to_mail(app: &AppHandle) { if let Some(window) = app.get_window(WINDOW) { let _ = window.close(); } focus_mail(app); }

#[tauri::command]
pub async fn open_web_link(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    trusted(&app, &webview, "main", "/")?;
    let parsed = Url::parse(&url).map_err(|_| "This link is not a valid URL")?;
    if parsed.scheme() == "mailto" { return app.opener().open_url(parsed.to_string(), None::<&str>).map_err(|e| e.to_string()); }
    if parsed.scheme() == "codex" { return app.opener().open_url(external_app_url(&url)?.to_string(), None::<&str>).map_err(|e| e.to_string()); }
    open_page(&app, web_url(&url)?)
}
// Query and navigate the actual WKWebView history, not a JavaScript history invented by the page.
#[cfg(target_os = "macos")]
fn history(view: &Webview, action: &str) -> Result<(bool, bool), String> {
    let action = action.to_string();
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |native| unsafe {
        let view = &*native.inner().cast::<objc2::runtime::AnyObject>();
        if action == "back" { let _: *mut objc2::runtime::AnyObject = objc2::msg_send![view, goBack]; }
        if action == "forward" { let _: *mut objc2::runtime::AnyObject = objc2::msg_send![view, goForward]; }
        let back: bool = objc2::msg_send![view, canGoBack];
        let forward: bool = objc2::msg_send![view, canGoForward];
        let _ = tx.send((back, forward));
    }).map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "Web navigation did not respond".into())
}
#[cfg(not(target_os = "macos"))]
fn history(view: &Webview, action: &str) -> Result<(bool, bool), String> {
    if action == "back" { view.eval("history.back()").map_err(|e| e.to_string())?; }
    if action == "forward" { view.eval("history.forward()").map_err(|e| e.to_string())?; }
    Ok((true, true))
}
#[tauri::command]
pub async fn web_link_state(app: AppHandle, webview: Webview) -> Result<LinkState, String> {
    trusted(&app, &webview, TOOLBAR, "/browser.html")?;
    let view = app.get_webview(CONTENT).ok_or("Web page is not ready")?;
    let url = view.url().map_err(|e| e.to_string())?;
    let (can_go_back, can_go_forward) = history(&view, "state")?;
    Ok(LinkState { url: url.to_string(), can_go_back, can_go_forward })
}
#[tauri::command]
pub async fn web_link_action(app: AppHandle, webview: Webview, action: String) -> Result<(), String> {
    trusted(&app, &webview, TOOLBAR, "/browser.html")?;
    perform_action(&app, &action)
}
pub fn perform_action(app: &AppHandle, action: &str) -> Result<(), String> {
    if action == "close" { return_to_mail(app); return Ok(()); }
    let view = app.get_webview(CONTENT).ok_or("No web page is open")?;
    match action {
        "back" | "forward" => { history(&view, action)?; Ok(()) },
        "reload" => view.reload().map_err(|e| e.to_string()),
        "external" => app.opener().open_url(web_url(view.url().map_err(|e| e.to_string())?.as_str())?.to_string(), None::<&str>).map_err(|e| e.to_string()),
        _ => Err("Unknown web navigation action".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_web_pages_enter_remote_view() {
        for url in ["https://example.com/a?b=c#d", "http://example.com"] { assert!(web_url(url).is_ok()); }
        for url in ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost", "data:text/html,test", "mailto:a@example.com"] { assert!(web_url(url).is_err()); }
    }
    #[test]
    fn only_the_pinned_gmail_plugin_may_open_as_a_custom_url() {
        assert!(external_app_url("codex://plugins/gmail@openai-curated").is_ok());
        for url in ["codex://plugins/other@openai-curated", "codex://threads/new", "javascript:alert(1)"] {
            assert!(external_app_url(url).is_err());
        }
    }
    #[test]
    fn mail_origin_is_exact_and_cannot_navigate_to_another_local_document() {
        for url in ["tauri://localhost", "tauri://localhost/", "tauri://localhost/index.html#thread", "http://tauri.localhost/"] { assert!(local_page(&Url::parse(url).unwrap(), "/", None)); }
        for url in ["https://example.com", "tauri://localhost/browser.html", "http://localhost:8411/", "https://tauri.localhost/", "http://tauri.localhost.evil/"] { assert!(!local_page(&Url::parse(url).unwrap(), "/", None)); }
        let dev = Url::parse("http://127.0.0.1:8410/").unwrap();
        assert!(local_page(&dev, "/", Some(&dev)));
        assert!(!local_page(&Url::parse("http://127.0.0.1:8411/").unwrap(), "/", Some(&dev)));
    }
}
