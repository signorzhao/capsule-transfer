#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::ShellExt;
use std::sync::Mutex;
use std::fs;
use std::io::Write;

struct BackendChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn log_to_file(msg: &str) {
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("capsule-debug.log")
    {
        let _ = writeln!(f, "{}", msg);
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
    log_to_file("=== Sound Capsule starting ===");

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![notify_new_capsule, flash_taskbar])
        .setup(|app| {
            log_to_file("Setup starting...");

            // 尝试启动 Flask sidecar（失败不崩溃）
            let shell = app.shell();
            match shell.sidecar("flask-backend") {
                Ok(sidecar) => {
                    match sidecar.spawn() {
                        Ok((_rx, child)) => {
                            log_to_file("Flask sidecar started successfully");
                            app.manage(BackendChild(Mutex::new(Some(child))));
                        }
                        Err(e) => {
                            log_to_file(&format!("Failed to spawn sidecar: {}", e));
                            app.manage(BackendChild(Mutex::new(None)));
                        }
                    }
                }
                Err(e) => {
                    log_to_file(&format!("Failed to create sidecar command: {}", e));
                    app.manage(BackendChild(Mutex::new(None)));
                }
            }

            // 系统托盘
            let tray_result = TrayIconBuilder::new()
                .tooltip("Sound Capsule")
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
                .build(app);

            match tray_result {
                Ok(_) => log_to_file("Tray icon created"),
                Err(e) => log_to_file(&format!("Tray icon failed: {}", e)),
            }

            log_to_file("Setup complete");
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
                log_to_file("Application exiting, killing backend...");
                let state = app_handle.state::<BackendChild>();
                let mut guard = state.0.lock().unwrap();
                if let Some(child) = guard.take() {
                    let _ = child.kill();
                }
                drop(guard);
            }
        });
}
