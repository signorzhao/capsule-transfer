#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::ShellExt;
use std::sync::Mutex;

struct BackendChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

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
            // 启动 Flask sidecar
            let shell = app.shell();
            let sidecar = shell.sidecar("flask-backend").expect("failed to create sidecar");
            let (mut _rx, child) = sidecar.spawn().expect("failed to spawn sidecar");
            app.manage(BackendChild(Mutex::new(Some(child))));

            // 系统托盘
            let _tray = TrayIconBuilder::new()
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
                .build(app)?;

            Ok(())
        })
        .on_window_event(|app, _window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 点 X 隐藏到托盘，不退出
                api.prevent_close();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // 退出时杀掉 Flask 后端
                let state = app_handle.state::<BackendChild>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
