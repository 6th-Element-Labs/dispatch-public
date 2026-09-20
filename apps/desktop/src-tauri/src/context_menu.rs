//! Native context-menu popup. The shell draws a web-owned item list and
//! returns the chosen command id. It does not choose labels or call mail.

use std::sync::{mpsc, Mutex};

use serde::Deserialize;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextMenuItem {
    Separator,
    Command {
        id: String,
        label: String,
        enabled: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextMenuEntry {
    Separator,
    Command {
        id: String,
        label: String,
        enabled: bool,
    },
}

pub fn parse_context_menu_items(
    items: Vec<ContextMenuItem>,
) -> Result<Vec<ContextMenuEntry>, String> {
    if items.is_empty() {
        return Err("Context menu item list is empty".into());
    }
    let mut parsed = Vec::with_capacity(items.len());
    let mut commands = 0usize;
    for item in items {
        match item {
            ContextMenuItem::Separator => parsed.push(ContextMenuEntry::Separator),
            ContextMenuItem::Command { id, label, enabled } => {
                if id.trim().is_empty() {
                    return Err("Context menu command is missing an id".into());
                }
                if label.trim().is_empty() {
                    return Err("Context menu command is missing a label".into());
                }
                commands += 1;
                parsed.push(ContextMenuEntry::Command { id, label, enabled });
            }
        }
    }
    if commands == 0 {
        return Err("Context menu list is only separators".into());
    }
    Ok(parsed)
}

#[derive(Default)]
pub struct ContextMenuPending(pub Mutex<Option<mpsc::Sender<String>>>);

pub fn record_pending_choice(pending: &ContextMenuPending, id: &str) {
    if let Ok(guard) = pending.0.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(id.to_string());
        }
    }
}

pub fn record_choice<R: Runtime>(app: &AppHandle<R>, id: &str) {
    record_pending_choice(&app.state::<ContextMenuPending>(), id);
}

fn build_context_menu<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[ContextMenuEntry],
) -> tauri::Result<Menu<R>> {
    let mut builder = MenuBuilder::new(app);
    for entry in entries {
        builder = match entry {
            ContextMenuEntry::Separator => builder.separator(),
            ContextMenuEntry::Command { id, label, enabled } => {
                let item = MenuItemBuilder::with_id(id, label)
                    .enabled(*enabled)
                    .build(app)?;
                builder.item(&item)
            }
        };
    }
    builder.build()
}

#[tauri::command]
pub fn popup_context_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<ContextMenuItem>,
) -> Result<Option<String>, String> {
    let parsed = parse_context_menu_items(items)?;
    let menu = build_context_menu(&app, &parsed).map_err(|error| error.to_string())?;
    let (tx, rx) = mpsc::channel();
    {
        let pending = app.state::<ContextMenuPending>();
        *pending.0.lock().map_err(|error| error.to_string())? = Some(tx);
    }
    window.popup_menu(&menu).map_err(|error| error.to_string())?;
    {
        let pending = app.state::<ContextMenuPending>();
        *pending.0.lock().map_err(|error| error.to_string())? = None;
    }
    Ok(rx.try_recv().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: &str, label: &str, enabled: bool) -> ContextMenuItem {
        ContextMenuItem::Command {
            id: id.to_string(),
            label: label.to_string(),
            enabled,
        }
    }

    #[test]
    fn keeps_order_labels_and_enabled_flags() {
        let parsed = parse_context_menu_items(vec![
            command("reply", "Reply", true),
            ContextMenuItem::Separator,
            command("trash", "Move to Trash", false),
        ])
        .expect("valid list");
        assert_eq!(
            parsed,
            vec![
                ContextMenuEntry::Command {
                    id: "reply".into(),
                    label: "Reply".into(),
                    enabled: true,
                },
                ContextMenuEntry::Separator,
                ContextMenuEntry::Command {
                    id: "trash".into(),
                    label: "Move to Trash".into(),
                    enabled: false,
                },
            ]
        );
    }

    #[test]
    fn rejects_an_empty_list() {
        let error = parse_context_menu_items(vec![]).expect_err("empty");
        assert!(error.contains("empty"));
    }

    #[test]
    fn rejects_a_separators_only_list() {
        let error = parse_context_menu_items(vec![
            ContextMenuItem::Separator,
            ContextMenuItem::Separator,
        ])
        .expect_err("separators");
        assert!(error.contains("separator"));
    }

    #[test]
    fn rejects_a_command_without_an_id_or_label() {
        assert!(parse_context_menu_items(vec![command("", "Reply", true)]).is_err());
        assert!(parse_context_menu_items(vec![command("reply", "", true)]).is_err());
        assert!(parse_context_menu_items(vec![command("  ", "Reply", true)]).is_err());
    }

    #[test]
    fn records_a_choice_only_when_a_popup_is_pending() {
        let pending = ContextMenuPending::default();
        record_pending_choice(&pending, "reply");
        let (tx, rx) = std::sync::mpsc::channel();
        *pending.0.lock().expect("pending") = Some(tx);
        record_pending_choice(&pending, "trash");
        assert_eq!(rx.try_recv().expect("chosen"), "trash");
    }

    #[test]
    fn deserializes_the_web_item_contract() {
        let items: Vec<ContextMenuItem> = serde_json::from_str(
            r#"[{"kind":"command","id":"ask","label":"Ask Codex","enabled":true},{"kind":"separator"}]"#,
        )
        .expect("json");
        assert_eq!(
            items,
            vec![
                command("ask", "Ask Codex", true),
                ContextMenuItem::Separator
            ]
        );
    }
}
