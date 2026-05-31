#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

struct BackendProcess(Mutex<Option<Child>>);

const UPDATE_CONFIG_FILE: &str = "update-config.json";
const VERSION_FILE: &str = "version.json";
const UPDATE_PLATFORM: &str = "windows-x64-portable";

#[derive(Debug, Deserialize)]
struct UpdateConfig {
    #[serde(default)]
    latest_path: String,
    #[serde(default)]
    allowed_source_prefixes: Vec<String>,
    #[serde(default = "default_channel")]
    channel: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct LocalVersion {
    version: String,
    build: u64,
    #[serde(default = "default_channel")]
    channel: String,
}

#[derive(Debug, Deserialize)]
struct LatestManifest {
    #[serde(default)]
    channel: String,
    version: String,
    build: u64,
    #[serde(default)]
    notes: Vec<String>,
    platforms: HashMap<String, PackageManifest>,
}

#[derive(Debug, Deserialize, Clone)]
struct PackageManifest {
    url: String,
    sha256: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Serialize)]
struct UpdateCheckResult {
    enabled: bool,
    update_available: bool,
    current_version: String,
    current_build: u64,
    latest_version: Option<String>,
    latest_build: Option<u64>,
    channel: String,
    notes: Vec<String>,
    package_url: Option<String>,
    sha256: Option<String>,
    size: Option<u64>,
    latest_path: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
struct DownloadedPackage {
    package_path: String,
    version: String,
    build: u64,
    sha256: String,
    size: u64,
}

fn default_channel() -> String {
    "stable".to_string()
}

fn app_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法读取当前程序路径：{e}"))?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位程序目录".to_string())
}

fn load_update_config(dir: &Path) -> Result<UpdateConfig, String> {
    let path = dir.join(UPDATE_CONFIG_FILE);
    if !path.exists() {
        return Ok(UpdateConfig {
            latest_path: String::new(),
            allowed_source_prefixes: Vec::new(),
            channel: default_channel(),
        });
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("读取 update-config.json 失败：{e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 update-config.json 失败：{e}"))
}

fn parse_build_from_version(version: &str) -> u64 {
    let parts: Vec<u64> = version
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let major = *parts.get(0).unwrap_or(&0);
    let minor = *parts.get(1).unwrap_or(&0);
    let patch = *parts.get(2).unwrap_or(&0);
    major * 10_000 + minor * 100 + patch
}

fn load_local_version(dir: &Path) -> LocalVersion {
    let path = dir.join(VERSION_FILE);
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(version) = serde_json::from_str::<LocalVersion>(&raw) {
            return version;
        }
    }

    let version = env!("CARGO_PKG_VERSION").to_string();
    LocalVersion {
        build: parse_build_from_version(&version),
        version,
        channel: default_channel(),
    }
}

fn resolve_update_path(latest_path: &Path, package_url: &str) -> PathBuf {
    let raw = package_url.trim();
    if raw.starts_with("\\\\") || raw.as_bytes().get(1) == Some(&b':') {
        return PathBuf::from(raw);
    }
    let package_path = PathBuf::from(raw);
    if package_path.is_absolute() {
        return package_path;
    }
    latest_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(package_path)
}

fn normalized_source(value: &Path) -> String {
    let text = value.to_string_lossy().replace('/', "\\");
    #[cfg(target_os = "windows")]
    {
        text.to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        text
    }
}

fn source_allowed(latest_path: &Path, package_path: &Path, prefixes: &[String]) -> bool {
    let package = normalized_source(package_path);
    if !prefixes.is_empty() {
        return prefixes.iter().any(|prefix| {
            let prefix = prefix.replace('/', "\\");
            #[cfg(target_os = "windows")]
            let prefix = prefix.to_lowercase();
            package.starts_with(&prefix)
        });
    }

    latest_path
        .parent()
        .map(|parent| package.starts_with(&normalized_source(parent)))
        .unwrap_or(false)
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 128];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_manifest(latest_path: &Path) -> Result<LatestManifest, String> {
    let raw = fs::read_to_string(latest_path).map_err(|e| format!("读取 latest.json 失败：{e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 latest.json 失败：{e}"))
}

fn select_package(manifest: &LatestManifest) -> Result<PackageManifest, String> {
    manifest
        .platforms
        .get(UPDATE_PLATFORM)
        .cloned()
        .or_else(|| manifest.platforms.values().next().cloned())
        .ok_or_else(|| "latest.json 没有可用的更新包".to_string())
}

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
        Command::new(&exe_path).current_dir(work_dir).spawn().ok()
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
        let _ = Command::new("pkill").args(["-f", "flask-backend"]).output();
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

#[tauri::command]
fn check_update() -> Result<UpdateCheckResult, String> {
    let dir = app_dir()?;
    let config = load_update_config(&dir)?;
    let current = load_local_version(&dir);
    if config.latest_path.trim().is_empty() {
        return Ok(UpdateCheckResult {
            enabled: false,
            update_available: false,
            current_version: current.version,
            current_build: current.build,
            latest_version: None,
            latest_build: None,
            channel: config.channel,
            notes: Vec::new(),
            package_url: None,
            sha256: None,
            size: None,
            latest_path: None,
            message: "未配置更新源，请在 update-config.json 中设置 latest_path。".to_string(),
        });
    }

    let latest_path = PathBuf::from(config.latest_path.trim());
    let manifest = read_manifest(&latest_path)?;
    let manifest_channel = if manifest.channel.trim().is_empty() {
        config.channel.clone()
    } else {
        manifest.channel.clone()
    };
    if manifest_channel != config.channel {
        let message = format!(
            "更新通道不匹配：当前 {}, 远程 {}",
            config.channel, manifest_channel
        );
        return Ok(UpdateCheckResult {
            enabled: true,
            update_available: false,
            current_version: current.version,
            current_build: current.build,
            latest_version: Some(manifest.version),
            latest_build: Some(manifest.build),
            channel: config.channel,
            notes: manifest.notes,
            package_url: None,
            sha256: None,
            size: None,
            latest_path: Some(latest_path.to_string_lossy().to_string()),
            message,
        });
    }

    let package = select_package(&manifest)?;
    let package_path = resolve_update_path(&latest_path, &package.url);
    if !source_allowed(&latest_path, &package_path, &config.allowed_source_prefixes) {
        return Err("更新包路径不在允许的更新源范围内".to_string());
    }

    let update_available = manifest.build > current.build;
    Ok(UpdateCheckResult {
        enabled: true,
        update_available,
        current_version: current.version,
        current_build: current.build,
        latest_version: Some(manifest.version),
        latest_build: Some(manifest.build),
        channel: config.channel,
        notes: manifest.notes,
        package_url: Some(package_path.to_string_lossy().to_string()),
        sha256: Some(package.sha256),
        size: Some(package.size),
        latest_path: Some(latest_path.to_string_lossy().to_string()),
        message: if update_available {
            "发现新版本。".to_string()
        } else {
            "当前已是最新版本。".to_string()
        },
    })
}

#[tauri::command]
fn download_update(
    package_url: String,
    sha256: String,
    version: String,
    build: u64,
) -> Result<DownloadedPackage, String> {
    let dir = app_dir()?;
    let config = load_update_config(&dir)?;
    let latest_path = PathBuf::from(config.latest_path.trim());
    let package_path = PathBuf::from(package_url.trim());
    if !source_allowed(&latest_path, &package_path, &config.allowed_source_prefixes) {
        return Err("更新包路径不在允许的更新源范围内".to_string());
    }
    if !package_path.exists() {
        return Err(format!("更新包不存在：{}", package_path.to_string_lossy()));
    }

    let updates_dir = std::env::temp_dir().join("CapsuleLAN").join("updates");
    fs::create_dir_all(&updates_dir).map_err(|e| format!("创建临时更新目录失败：{e}"))?;
    let filename = package_path
        .file_name()
        .ok_or_else(|| "更新包路径缺少文件名".to_string())?;
    let dest = updates_dir.join(filename);
    fs::copy(&package_path, &dest).map_err(|e| format!("复制更新包失败：{e}"))?;

    let actual_sha = sha256_file(&dest).map_err(|e| format!("计算 SHA256 失败：{e}"))?;
    if !actual_sha.eq_ignore_ascii_case(sha256.trim()) {
        let _ = fs::remove_file(&dest);
        return Err("更新包 SHA256 校验失败。".to_string());
    }
    let size = fs::metadata(&dest)
        .map_err(|e| format!("读取更新包大小失败：{e}"))?
        .len();

    Ok(DownloadedPackage {
        package_path: dest.to_string_lossy().to_string(),
        version,
        build,
        sha256: actual_sha,
        size,
    })
}

#[tauri::command]
fn install_update(
    app: tauri::AppHandle,
    package_path: String,
    version: String,
    build: u64,
) -> Result<(), String> {
    let current_exe = std::env::current_exe().map_err(|e| format!("无法读取当前程序路径：{e}"))?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| "无法定位程序目录".to_string())?
        .to_path_buf();
    let exe_name = current_exe
        .file_name()
        .ok_or_else(|| "无法读取主程序文件名".to_string())?
        .to_string_lossy()
        .to_string();

    #[cfg(target_os = "windows")]
    let updater_name = "capsule-updater.exe";
    #[cfg(not(target_os = "windows"))]
    let updater_name = "capsule-updater";

    let updater = dir.join(updater_name);
    if !updater.exists() {
        return Err(format!("未找到更新器：{}", updater.to_string_lossy()));
    }

    let run_dir = std::env::temp_dir().join("CapsuleLAN").join("updater-run");
    fs::create_dir_all(&run_dir).map_err(|e| format!("创建更新器临时目录失败：{e}"))?;
    let run_updater = run_dir.join(format!("{}-{}", std::process::id(), updater_name));
    fs::copy(&updater, &run_updater).map_err(|e| format!("复制更新器失败：{e}"))?;

    let app_dir_arg = dir.to_string_lossy().to_string();
    let package_arg = package_path;
    let pid_arg = std::process::id().to_string();
    let build_arg = build.to_string();

    let mut command = Command::new(&run_updater);
    command.args([
        "--app-dir",
        app_dir_arg.as_str(),
        "--package",
        package_arg.as_str(),
        "--exe",
        exe_name.as_str(),
        "--pid",
        pid_arg.as_str(),
        "--version",
        version.as_str(),
        "--build",
        build_arg.as_str(),
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(|e| format!("启动更新器失败：{e}"))?;
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            notify_new_capsule,
            flash_taskbar,
            check_update,
            download_update,
            install_update
        ])
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
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                let state = app_handle.state::<BackendProcess>();
                kill_backend(&state);
            }
            _ => {}
        });
}
