//! The menu bar: Tauri's default menus, plus Jig's commands. A command
//! goes to the frontmost window as a `menu` event naming it.
//!
//! Their shortcuts reach the page first, which handles them itself and
//! stops them; the menu items run them when clicked.
//!
//! On macOS the Dock icon's menu has New Window too.

use tauri::menu::{
    AboutMetadata, HELP_SUBMENU_ID, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::windows::WindowOrder;

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, shortcut: Option<&str>| MenuItem::with_id(app, id, text, true, shortcut);
    let separator = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("new-window", "New Window", Some("CmdOrCtrl+N"))?,
            &item("new-tab", "New Tab…", Some("CmdOrCtrl+T"))?,
            &separator()?,
            &item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?,
            &item("close-window", "Close Window", Some("CmdOrCtrl+Shift+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &separator()?,
            &item("find", "Find…", Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("reload", "Reload", Some("CmdOrCtrl+R"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &separator()?,
            &item("next-tab", "Show Next Tab", Some("CmdOrCtrl+Shift+]"))?,
            &item("previous-tab", "Show Previous Tab", Some("CmdOrCtrl+Shift+["))?,
        ],
    )?;
    // No shortcut shown for `?`: as a key equivalent it could catch typing.
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[&item("help", "Keyboard Shortcuts", None)?])?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// Sends a menu command to the frontmost window, or any window if none has had focus yet.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let label = app
        .state::<WindowOrder>()
        .frontmost()
        .or_else(|| app.webview_windows().into_keys().next());
    if let Some(label) = label {
        let _ = app.emit_to(label, "menu", event.id().0.clone());
    }
}

/// Gives the Dock icon's menu a New Window item, sent like the menu bar's.
/// Tauri has no API for it, so this adds `applicationDockMenu:` to tao's
/// app delegate. Call on the main thread once the app is built.
#[cfg(target_os = "macos")]
pub fn set_dock_menu() {
    use muda::ContextMenu;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{MainThreadMarker, sel};
    use objc2_app_kit::NSApplication;

    thread_local! {
        static DOCK_MENU: muda::Menu = {
            let menu = muda::Menu::new();
            let _ = menu.append(&muda::MenuItem::with_id("new-window", "New Window", true, None));
            menu
        };
    }

    extern "C-unwind" fn dock_menu(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> *mut AnyObject {
        DOCK_MENU.with(|menu| menu.ns_menu().cast())
    }

    let Some(mtm) = MainThreadMarker::new() else { return };
    let ns_app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns_app.delegate() else { return };
    // SAFETY: `dock_menu` has the selector's signature, as its types say.
    unsafe {
        let object: &AnyObject = delegate.as_ref();
        let class: *const AnyClass = object.class();
        let imp: Imp = std::mem::transmute(dock_menu as extern "C-unwind" fn(_, _, _) -> _);
        objc2::ffi::class_addMethod(class as *mut _, sel!(applicationDockMenu:), imp, c"@@:@".as_ptr());
    }
    // AppKit notes which delegate methods exist when the delegate is set.
    ns_app.setDelegate(Some(&delegate));
}
