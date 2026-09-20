//! Manual macOS acceptance: select Mark as Unread in the test window.
//! This exercises the native popup without starting mail or changing a message.
#[path = "../src/context_menu.rs"]
mod context_menu;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(context_menu::ContextMenuPending::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let open = tauri::menu::MenuItemBuilder::with_id("test-popup", "Open test popup").build(app)?;
            let submenu = tauri::menu::SubmenuBuilder::new(app, "Test").item(&open).build()?;
            app.set_menu(tauri::menu::MenuBuilder::new(app).item(&submenu).build()?)?;
            handle.on_menu_event(|app, event| {
                if event.id().as_ref() != "test-popup" {
                    context_menu::record_choice(app, event.id().as_ref());
                    return;
                }
                let handle = app.clone();
                let window = app.get_webview_window("menu-test").unwrap();
                tauri::async_runtime::spawn(async move {
                    let result = context_menu::popup_context_menu(handle.clone(), window, vec![
                        context_menu::ContextMenuItem::Command { id: "markUnread".into(), label: "Mark as Unread".into(), enabled: true },
                    ]).await;
                    println!("NATIVE_MENU_RESULT={result:?}");
                    std::fs::write(std::env::temp_dir().join("dispatch-native-menu-result.txt"), format!("{result:?}")).unwrap();
                    if result == Ok(Some("markUnread".into())) { handle.exit(0); }
                });
            });
            tauri::WebviewWindowBuilder::new(app, "menu-test", tauri::WebviewUrl::External("about:blank".parse().unwrap()))
                .title("Dispatch native menu test").inner_size(480.0, 240.0).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("native context-menu test");
}
