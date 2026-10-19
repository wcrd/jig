//! Jig's windows: opening more of them, and finding the one under the
//! pointer while a tab is dragged between them.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Window labels, frontmost first: by when each last had focus, as Tauri
/// can't say how windows are stacked.
#[derive(Default)]
pub struct WindowOrder(Mutex<Vec<String>>);

impl WindowOrder {
    pub fn frontmost(&self) -> Option<String> {
        self.0.lock().unwrap().first().cloned()
    }
}

/// What each window being opened should show, until it asks.
#[derive(Default)]
pub struct WindowInits(Mutex<HashMap<String, serde_json::Value>>);

/// Keeps `WindowOrder` up to date.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let order = window.state::<WindowOrder>();
    let mut order = order.0.lock().unwrap();
    match event {
        WindowEvent::Focused(true) => {
            order.retain(|l| l != window.label());
            order.insert(0, window.label().to_string());
        }
        WindowEvent::Destroyed => order.retain(|l| l != window.label()),
        _ => {}
    }
}

#[derive(serde::Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// A torn-off tab's window opens with the pointer over its tab: this far
/// from the window's top left, past the title bar and into the tab strip.
const GRAB_OFFSET: (f64, f64) = (80.0, 48.0);
/// A new window steps down and right from the one it was opened from.
const CASCADE: f64 = 24.0;

/// Opens a window that will show `init`, from `take_window_init`. It goes
/// at `bounds` if given; else with the pointer over its first tab when
/// `at_cursor`, or cascaded from the window asking; at that window's size.
#[tauri::command]
pub async fn open_window(
    app: AppHandle,
    window: WebviewWindow,
    inits: State<'_, WindowInits>,
    label: String,
    init: serde_json::Value,
    at_cursor: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    let bounds = match bounds {
        Some(bounds) => bounds,
        None => {
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
            let cursor = if at_cursor { cursor(&app) } else { None };
            let (x, y) = match cursor {
                Some((x, y)) => (x - GRAB_OFFSET.0, y - GRAB_OFFSET.1),
                None => {
                    let p = window.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
                    (p.x + CASCADE, p.y + CASCADE)
                }
            };
            Bounds { x, y, width: size.width, height: size.height }
        }
    };
    inits.0.lock().unwrap().insert(label.clone(), init);
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Jig")
        .inner_size(bounds.width, bounds.height)
        .min_inner_size(700.0, 400.0)
        .position(bounds.x, bounds.y)
        .build();
    if let Err(e) = built {
        inits.0.lock().unwrap().remove(&label);
        return Err(e.to_string());
    }
    Ok(())
}

/// What `open_window` was asked to show in this window, once.
#[tauri::command]
pub fn take_window_init(window: WebviewWindow, inits: State<'_, WindowInits>) -> Option<serde_json::Value> {
    inits.0.lock().unwrap().remove(window.label())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPoint {
    label: String,
    /// From the left of the window's content, as `clientX` gives it.
    x: f64,
    /// Up from the bottom of the window. The page's top can sit below the
    /// content's top, under the title bar, but their bottoms line up.
    from_bottom: f64,
}

/// The pointer's position in logical pixels from the main display's top
/// left. The web view's `screenX` and `screenY` can't be relied on for this.
fn cursor(app: &AppHandle) -> Option<(f64, f64)> {
    // tao scales it by the main display's scale factor.
    let scale = app.primary_monitor().ok()??.scale_factor();
    let p = app.cursor_position().ok()?.to_logical::<f64>(scale);
    Some((p.x, p.y))
}

/// The frontmost window under the pointer.
#[tauri::command]
pub fn window_at(app: AppHandle, order: State<'_, WindowOrder>) -> Option<WindowPoint> {
    let (x, y) = cursor(&app)?;
    let windows = app.webview_windows();
    let order = order.0.lock().unwrap().clone();
    let unordered = windows.keys().filter(|l| !order.contains(l)).cloned();
    let labels: Vec<String> = order.iter().cloned().chain(unordered).collect();
    labels.into_iter().find_map(|label| {
        let window = windows.get(&label)?;
        if !window.is_visible().ok()? || window.is_minimized().ok()? {
            return None;
        }
        let scale = window.scale_factor().ok()?;
        let outer = window.outer_position().ok()?.to_logical::<f64>(scale);
        let outer_size = window.outer_size().ok()?.to_logical::<f64>(scale);
        let inner = window.inner_position().ok()?.to_logical::<f64>(scale);
        let inner_size = window.inner_size().ok()?.to_logical::<f64>(scale);
        let inside = x >= outer.x && y >= outer.y && x < outer.x + outer_size.width && y < outer.y + outer_size.height;
        inside.then_some(WindowPoint { label, x: x - inner.x, from_bottom: inner.y + inner_size.height - y })
    })
}
