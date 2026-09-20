//! View → Appearance: System, Light, Dark.
//!
//! The web client owns the preference (it persists it and paints the page).
//! The shell mirrors that preference in the menu check marks and in the
//! native window theme, so sheets, menus and scrollbars match the page.
//! A menu click is forwarded to the web client as an event; the web client
//! reports its current preference back through `set_appearance`.

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, Theme};

pub const SYSTEM: &str = "appearance-system";
pub const LIGHT: &str = "appearance-light";
pub const DARK: &str = "appearance-dark";
pub const EVENT: &str = "dispatch://appearance";

pub struct AppearanceMenu<R: Runtime> {
    items: Mutex<Vec<(&'static str, CheckMenuItem<R>)>>,
}

impl<R: Runtime> Default for AppearanceMenu<R> {
    fn default() -> Self {
        Self { items: Mutex::new(Vec::new()) }
    }
}

pub fn submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let system = CheckMenuItemBuilder::with_id(SYSTEM, "System").checked(true).build(app)?;
    let light = CheckMenuItemBuilder::with_id(LIGHT, "Light").checked(false).build(app)?;
    let dark = CheckMenuItemBuilder::with_id(DARK, "Dark").checked(false).build(app)?;
    let submenu = SubmenuBuilder::new(app, "Appearance").item(&system).item(&light).item(&dark).build()?;
    if let Some(state) = app.try_state::<AppearanceMenu<R>>() {
        if let Ok(mut items) = state.items.lock() {
            *items = vec![("system", system), ("light", light), ("dark", dark)];
        }
    }
    Ok(submenu)
}

/// Menu id → preference name the web client understands.
pub fn preference_for(id: &str) -> Option<&'static str> {
    match id {
        SYSTEM => Some("system"),
        LIGHT => Some("light"),
        DARK => Some("dark"),
        _ => None,
    }
}

fn theme_for(preference: &str) -> Result<Option<Theme>, String> {
    match preference {
        "system" => Ok(None),
        "light" => Ok(Some(Theme::Light)),
        "dark" => Ok(Some(Theme::Dark)),
        other => Err(format!("Unknown appearance {other:?}; expected system, light or dark")),
    }
}

/// Mirror a preference in the menu and the native window theme.
pub fn apply<R: Runtime>(app: &AppHandle<R>, preference: &str) -> Result<(), String> {
    let theme = theme_for(preference)?;
    if let Some(state) = app.try_state::<AppearanceMenu<R>>() {
        let items = state.items.lock().map_err(|error| error.to_string())?;
        for (name, item) in items.iter() {
            item.set_checked(*name == preference).map_err(|error| error.to_string())?;
        }
    }
    app.set_theme(theme);
    Ok(())
}

/// A menu click: mirror it here and hand the choice to the web client, which persists it.
pub fn choose<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let preference = preference_for(id).ok_or_else(|| format!("Unknown appearance menu id {id:?}"))?;
    apply(app, preference)?;
    app.emit(EVENT, preference).map_err(|error| error.to_string())
}

/// The web client reports its current preference (on load and after any change).
#[tauri::command]
pub fn set_appearance<R: Runtime>(app: AppHandle<R>, preference: String) -> Result<(), String> {
    apply(&app, &preference)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_menu_ids_to_preferences() {
        assert_eq!(preference_for(SYSTEM), Some("system"));
        assert_eq!(preference_for(LIGHT), Some("light"));
        assert_eq!(preference_for(DARK), Some("dark"));
        assert_eq!(preference_for("reply"), None);
    }

    #[test]
    fn rejects_unknown_preferences() {
        assert!(theme_for("system").unwrap().is_none());
        assert!(matches!(theme_for("dark"), Ok(Some(Theme::Dark))));
        assert!(matches!(theme_for("light"), Ok(Some(Theme::Light))));
        assert!(theme_for("sepia").is_err());
    }
}
