//! Native macOS menu: the standard app, Edit, View, and Window menus plus two
//! service controls. Edit items are required for text editing in WebKit.
//! View → Appearance is built by `appearance`.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

use crate::appearance;

pub const RESTART_SERVICES: &str = "restart-services";
pub const RETURN_TO_MAIL: &str = "return-to-mail";
pub const WEB_BACK: &str = "web-back";
pub const WEB_FORWARD: &str = "web-forward";
pub const WEB_RELOAD: &str = "web-reload";
pub const OPEN_LOGS: &str = "open-logs";
pub const CHECK_FOR_UPDATES: &str = "check-for-updates";

pub fn application_item_ids() -> Vec<&'static str> {
    vec![RESTART_SERVICES, OPEN_LOGS, CHECK_FOR_UPDATES]
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let restart = MenuItemBuilder::with_id(RESTART_SERVICES, "Restart Services").build(app)?;
    let logs = MenuItemBuilder::with_id(OPEN_LOGS, "Open Service Logs").build(app)?;
    let updates = MenuItemBuilder::with_id(CHECK_FOR_UPDATES, "Check for Updates…").build(app)?;
    let application = SubmenuBuilder::new(app, "Dispatch")
        .about(None)
        .separator()
        .item(&restart)
        .item(&logs)
        .item(&updates)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").item(&appearance::submenu(app)?).build()?;
    let back = MenuItemBuilder::with_id(WEB_BACK, "Back").accelerator("CmdOrCtrl+[").build(app)?;
    let forward = MenuItemBuilder::with_id(WEB_FORWARD, "Forward").accelerator("CmdOrCtrl+]").build(app)?;
    let reload = MenuItemBuilder::with_id(WEB_RELOAD, "Reload Web Page").accelerator("CmdOrCtrl+R").build(app)?;
    let mail = MenuItemBuilder::with_id(RETURN_TO_MAIL, "Return to Mail").accelerator("CmdOrCtrl+Shift+M").build(app)?;
    let navigation = SubmenuBuilder::new(app, "Navigate").item(&back).item(&forward).item(&reload).separator().item(&mail).build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;
    MenuBuilder::new(app).items(&[&application, &edit, &view, &navigation, &window]).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_menu_includes_update_check() {
        assert!(application_item_ids().contains(&CHECK_FOR_UPDATES));
    }
}
