#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::path::PathBuf;

struct BackendProcess(Mutex<Option<Child>>);

fn find_backend_exe(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("flask-backend.exe"),
                exe_dir.join("flask-backend"),
            ];
            for p in &candidates {
                if p.exists() {
                    return Some(p.clone());
                }
            }
        }
    }

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

fn kill_backend(state: &BackendProcess) {
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut child) = *guard {
        let _ = child.kill();
        let _ = child.wait();
    }
    *guard = None;
    drop(guard);

    // 额外保障：杀掉所有 flask-backend 进程
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "flask-backend.exe"])
            .creation_flags(0x08000000)
            .output();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("pkill")
            .args(["-f", "flask-backend"])
            .output();
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
                eprintln!("[Capsule LAN] Flask backend started");
            } else {
                eprintln!("[Capsule LAN] No bundled backend, expecting manual Flask");
            }
            app.manage(BackendProcess(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    let state = app_handle.state::<BackendProcess>();
                    kill_backend(&state);
                }
                _ => {}
            }
        });
}
