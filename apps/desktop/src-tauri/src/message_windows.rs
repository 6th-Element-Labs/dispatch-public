//! Message windows: one conversation from the mail list in its own native window.
//!
//! A message window runs the same local web client as the main window, with a
//! query that names the conversation. The web client owns everything it shows;
//! the shell only creates, finds, focuses and closes these windows.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Url, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::web_links;

pub const LABEL_PREFIX: &str = "message-";
/// File → Open in New Window: the main window opens its selected conversation.
pub const OPEN_SELECTED: &str = "dispatch://open-message-window";
const MAX_IDENTIFIER: usize = 512;
const MAX_TITLE: usize = 200;

/// Open message windows by conversation id, so a second request focuses the first window.
#[derive(Default)]
pub struct MessageWindows { next: AtomicU64, open: Mutex<HashMap<String, String>> }

fn identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER || value.chars().any(char::is_control) {
        return Err(format!("This message window needs a valid {name}"));
    }
    Ok(())
}
fn window_title(subject: &str) -> String {
    let clean: String = subject.chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX_TITLE).collect();
    let clean = clean.trim();
    if clean.is_empty() { "Message".into() } else { clean.to_string() }
}
/// The local page for one conversation, with every value encoded as a query parameter.
fn page(conversation_id: &str, thread_id: &str, account_id: Option<&str>, mailbox: &str, draft_key: Option<&str>) -> Result<String, String> {
    identifier("conversation", conversation_id)?;
    identifier("thread", thread_id)?;
    identifier("mailbox", mailbox)?;
    if let Some(account) = account_id { identifier("account", account)?; }
    if let Some(key) = draft_key {
        identifier("draft", key)?;
        if mailbox != "drafts" { return Err("Draft windows must use Drafts".into()); }
    }
    let mut url = Url::parse("tauri://localhost/index.html").map_err(|e| e.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("window", if draft_key.is_some() { "draft" } else { "message" }).append_pair("conversation", conversation_id).append_pair("thread", thread_id).append_pair("mailbox", mailbox);
        if let Some(account) = account_id { query.append_pair("account", account); }
        if let Some(key) = draft_key { query.append_pair("draftKey", key); }
    }
    Ok(format!("index.html?{}", url.query().unwrap_or_default()))
}

#[tauri::command]
pub async fn open_message_window(app: AppHandle, webview: Webview, conversation_id: String, thread_id: String, account_id: Option<String>, mailbox: String, title: String, draft_key: Option<String>) -> Result<(), String> {
    // Only the main window lists conversations.
    web_links::trusted_main(&app, &webview)?;
    let path = page(&conversation_id, &thread_id, account_id.as_deref(), &mailbox, draft_key.as_deref())?;
    let state = app.state::<MessageWindows>();
    // Reserve the conversation before building, without holding the lock while
    // the window is created (window events take the same lock on the main thread).
    let label = {
        let mut open = state.open.lock().map_err(|_| "Message windows are unavailable")?;
        if let Some(window) = open.get(&conversation_id).and_then(|label| app.get_webview_window(label)) {
            window.unminimize().map_err(|e| e.to_string())?;
            return window.set_focus().map_err(|e| e.to_string());
        }
        let label = format!("{LABEL_PREFIX}{}", state.next.fetch_add(1, Ordering::Relaxed) + 1);
        open.insert(conversation_id.clone(), label.clone());
        label
    };
    let forget = |app: &AppHandle, label: &str| {
        if let Ok(mut open) = app.state::<MessageWindows>().open.lock() { open.retain(|_, value| value != label); }
    };
    // Same chrome as the mail window: overlay title bar, traffic lights, no file drop.
    let mut config = app.config().app.windows[0].clone();
    config.label = label.clone();
    config.url = WebviewUrl::App(path.into());
    config.title = window_title(&title);
    config.width = 960.0;
    config.height = 780.0;
    config.min_width = Some(640.0);
    config.min_height = Some(480.0);
    let built = WebviewWindowBuilder::from_config(&app, &config)
        .map(|builder| web_links::guard_mail_view(&app, builder))
        .and_then(|builder| builder.build());
    let window = match built {
        Ok(window) => window,
        Err(error) => { forget(&app, &label); return Err(error.to_string()); }
    };
    let event_app = app.clone();
    window.on_window_event(move |event| if let WindowEvent::Destroyed = event { forget(&event_app, &label) });
    Ok(())
}

/// Closing the mail window closes its message windows, so the app quits as it did before they existed.
pub fn close_with_main(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    let event_app = app.clone();
    main.on_window_event(move |event| if let WindowEvent::Destroyed = event {
        for (label, window) in event_app.webview_windows() {
            if label.starts_with(LABEL_PREFIX) { let _ = window.close(); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_every_value_into_the_local_page_query() {
        let path = page("gmail:acct:thread&x=1", "thread#1", Some("acct/one"), "inbox", None).unwrap();
        assert_eq!(path, "index.html?window=message&conversation=gmail%3Aacct%3Athread%26x%3D1&thread=thread%231&mailbox=inbox&account=acct%2Fone");
        assert_eq!(page("demo:t1", "t1", None, "archive", None).unwrap(), "index.html?window=message&conversation=demo%3At1&thread=t1&mailbox=archive");
    }
    #[test]
    fn rejects_missing_oversized_or_control_character_values() {
        assert!(page("", "t1", None, "inbox", None).is_err());
        assert!(page("c1", "", None, "inbox", None).is_err());
        assert!(page("c1", "t1", None, "", None).is_err());
        assert!(page("c1", "t1", Some(""), "inbox", None).is_err());
        assert!(page(&"x".repeat(MAX_IDENTIFIER + 1), "t1", None, "inbox", None).is_err());
        assert!(page("c1\n", "t1", None, "inbox", None).is_err());
    }
    #[test]
    fn draft_windows_encode_the_checkpoint_and_require_drafts() {
        assert_eq!(page("draft:key&1", "key&1", Some("one"), "drafts", Some("key&1")).unwrap(),
            "index.html?window=draft&conversation=draft%3Akey%261&thread=key%261&mailbox=drafts&account=one&draftKey=key%261");
        assert!(page("draft:key", "key", Some("one"), "drafts", Some("")).is_err());
        assert!(page("draft:key", "key", Some("one"), "inbox", Some("key")).is_err());
    }
    #[test]
    fn titles_are_single_line_and_bounded() {
        assert_eq!(window_title("  Re: Berth\nconfirmation  "), "Re: Berth confirmation");
        assert_eq!(window_title(" \t "), "Message");
        assert_eq!(window_title(&"a".repeat(500)).chars().count(), MAX_TITLE);
    }
}
