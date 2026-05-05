#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::path::PathBuf;

struct BackendProcess(Mutex<Option<Child>>);

fn find_backend_exe(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("binaries").join("flask-backend.exe"),
            resource_dir.join("binaries").join("flask-backend"),
            resource_dir.join("flask-backend.exe"),
            resource_dir.join("flask-backend"),
        ];
        for p in &candidates {
            if p.exists() {
                return Some(p.clone());
            }
        }
    }
    None
}

fn start_backend(app: &tauri::App) -> Option<Child> {
    let exe_path = find_backend_exe(app)?;
    let work_dir = exe_path.parent()?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new(&exe_path)
            .current_dir(work_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .ok()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new(&exe_path)
            .current_dir(work_dir)
            .spawn()
            .ok()
    }
}

#[tauri::command]
fn notify_new_capsule(app: tauri::AppHandle, sender: String) {
    let _ = app
        .notification()
        .builder()
        .title("收到新胶囊")
        .body(format!("来自 {} 的用户发送了一个胶囊", sender))
        .show();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

#[tauri::command]
fn flash_taskbar(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![notify_new_capsule, flash_taskbar])
        .setup(|app| {
            let child = start_backend(app);
            if child.is_some() {
                eprintln!("[Sound Capsule] Flask backend started");
            } else {
                eprintln!("[Sound Capsule] No bundled backend, expecting manual Flask");
            }
            app.manage(BackendProcess(Mutex::new(child)));

            // 托盘右键菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .tooltip("Sound Capsule")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<BackendProcess>();
                let mut guard = state.0.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                *guard = None;
                drop(guard);
            }
        });
}
