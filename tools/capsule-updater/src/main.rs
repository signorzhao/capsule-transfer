use anyhow::{anyhow, Context, Result};
use clap::Parser;
use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PACKAGE_ROOT: &str = "Capsule LAN";
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    app_dir: PathBuf,
    #[arg(long)]
    package: PathBuf,
    #[arg(long)]
    exe: String,
    #[arg(long)]
    pid: u32,
    #[arg(long)]
    version: String,
    #[arg(long)]
    build: u64,
}

#[derive(Serialize)]
struct VersionFile<'a> {
    version: &'a str,
    build: u64,
    channel: &'a str,
}

fn main() {
    let args = Args::parse();
    if let Err(err) = run(args) {
        let _ = eprintln!("Capsule updater failed: {err:#}");
    }
}

fn run(args: Args) -> Result<()> {
    let log_path = args.app_dir.join("logs").join("update.log");
    fs::create_dir_all(log_path.parent().unwrap_or_else(|| Path::new("."))).ok();
    log(&log_path, "update started")?;

    let backup_dir =
        args.app_dir
            .join("backups")
            .join(format!("backup-v{}-{}", args.version, now_epoch()));

    let result = install(&args, &backup_dir, &log_path);
    match result {
        Ok(()) => {
            prune_backups(&args.app_dir.join("backups"), 1, &log_path).ok();
            relaunch(&args.app_dir, &args.exe, &log_path)?;
            log(&log_path, "update completed")?;
            Ok(())
        }
        Err(err) => {
            log(&log_path, &format!("update failed: {err:#}")).ok();
            if backup_dir.exists() {
                if let Err(rollback_err) = rollback(&args.app_dir, &backup_dir, &log_path) {
                    log(&log_path, &format!("rollback failed: {rollback_err:#}")).ok();
                }
            }
            let _ = relaunch(&args.app_dir, &args.exe, &log_path);
            Err(err)
        }
    }
}

fn install(args: &Args, backup_dir: &Path, log_path: &Path) -> Result<()> {
    wait_for_process_exit(args.pid, WAIT_TIMEOUT, log_path)?;
    kill_backend(log_path).ok();

    log(log_path, "creating backup")?;
    fs::create_dir_all(backup_dir).context("create backup directory")?;
    backup_app_dir(&args.app_dir, backup_dir).context("backup current app")?;

    log(log_path, "extracting package")?;
    let staging_dir = std::env::temp_dir()
        .join("CapsuleLAN")
        .join("staging")
        .join(format!("{}-{}", args.build, now_epoch()));
    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir).ok();
    }
    fs::create_dir_all(&staging_dir).context("create staging directory")?;
    unzip_package(&args.package, &staging_dir).context("extract update package")?;

    let package_root = staging_dir.join(PACKAGE_ROOT);
    if !package_root.is_dir() {
        return Err(anyhow!(
            "update package must contain top-level directory '{}'",
            PACKAGE_ROOT
        ));
    }

    log(log_path, "replacing application files")?;
    clear_replaceable_entries(&args.app_dir).context("clear old app files")?;
    copy_package_entries(&package_root, &args.app_dir).context("copy new app files")?;
    write_version(&args.app_dir, &args.version, args.build).context("write version.json")?;

    fs::remove_dir_all(&staging_dir).ok();
    Ok(())
}

fn protected_entries() -> HashSet<&'static str> {
    HashSet::from([
        "data",
        "logs",
        "backups",
        "config.json",
        "update-config.json",
        ".env",
    ])
}

fn is_protected(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| protected_entries().contains(name))
        .unwrap_or(false)
}

fn backup_app_dir(app_dir: &Path, backup_dir: &Path) -> Result<()> {
    for entry in fs::read_dir(app_dir).context("read app directory")? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == "data" || name_str == "backups" {
            continue;
        }
        copy_recursively(&path, &backup_dir.join(name))?;
    }
    Ok(())
}

fn clear_replaceable_entries(app_dir: &Path) -> Result<()> {
    for entry in fs::read_dir(app_dir).context("read app directory")? {
        let entry = entry?;
        let path = entry.path();
        if is_protected(&path) {
            continue;
        }
        remove_path(&path)?;
    }
    Ok(())
}

fn copy_package_entries(package_root: &Path, app_dir: &Path) -> Result<()> {
    for entry in fs::read_dir(package_root).context("read package root")? {
        let entry = entry?;
        let path = entry.path();
        let dest = app_dir.join(entry.file_name());
        if is_protected(&dest) && dest.exists() {
            continue;
        }
        if dest.exists() && !is_protected(&dest) {
            remove_path(&dest)?;
        }
        copy_recursively(&path, &dest)?;
    }
    Ok(())
}

fn rollback(app_dir: &Path, backup_dir: &Path, log_path: &Path) -> Result<()> {
    log(log_path, "rolling back")?;
    clear_replaceable_entries(app_dir).context("clear failed update files")?;
    for entry in fs::read_dir(backup_dir).context("read backup directory")? {
        let entry = entry?;
        let dest = app_dir.join(entry.file_name());
        if dest.exists() && !is_protected(&dest) {
            remove_path(&dest)?;
        }
        copy_recursively(&entry.path(), &dest)?;
    }
    Ok(())
}

fn unzip_package(package: &Path, staging_dir: &Path) -> Result<()> {
    let file = fs::File::open(package).context("open zip package")?;
    let mut archive = zip::ZipArchive::new(file).context("read zip package")?;
    for i in 0..archive.len() {
        let mut member = archive.by_index(i)?;
        let enclosed = member
            .enclosed_name()
            .ok_or_else(|| anyhow!("zip entry has unsafe path: {}", member.name()))?;
        let out_path = staging_dir.join(enclosed);
        if member.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&out_path)?;
        io::copy(&mut member, &mut out)?;
    }
    Ok(())
}

fn copy_recursively(src: &Path, dest: &Path) -> Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursively(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest).with_context(|| {
            format!(
                "copy {} to {}",
                src.to_string_lossy(),
                dest.to_string_lossy()
            )
        })?;
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn write_version(app_dir: &Path, version: &str, build: u64) -> Result<()> {
    let body = serde_json::to_string_pretty(&VersionFile {
        version,
        build,
        channel: "stable",
    })?;
    fs::write(app_dir.join("version.json"), format!("{body}\n"))?;
    Ok(())
}

fn prune_backups(backups_dir: &Path, keep: usize, log_path: &Path) -> Result<()> {
    if !backups_dir.is_dir() {
        return Ok(());
    }
    let mut backups = Vec::new();
    for entry in fs::read_dir(backups_dir)? {
        let entry = entry?;
        if entry.path().is_dir() {
            let modified = entry.metadata()?.modified().unwrap_or(UNIX_EPOCH);
            backups.push((modified, entry.path()));
        }
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in backups.into_iter().skip(keep) {
        log(
            log_path,
            &format!("removing old backup {}", path.to_string_lossy()),
        )
        .ok();
        fs::remove_dir_all(path).ok();
    }
    Ok(())
}

fn relaunch(app_dir: &Path, exe: &str, log_path: &Path) -> Result<()> {
    let exe_path = app_dir.join(exe);
    log(
        log_path,
        &format!("relaunching {}", exe_path.to_string_lossy()),
    )?;
    let mut command = Command::new(exe_path);
    command.current_dir(app_dir);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().context("relaunch app")?;
    Ok(())
}

fn wait_for_process_exit(pid: u32, timeout: Duration, log_path: &Path) -> Result<()> {
    let started = SystemTime::now();
    while process_exists(pid) {
        if started.elapsed().unwrap_or_default() > timeout {
            return Err(anyhow!("process {pid} did not exit within {:?}", timeout));
        }
        thread::sleep(Duration::from_millis(500));
    }
    log(log_path, &format!("process {pid} exited"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn process_exists(pid: u32) -> bool {
    let mut command = Command::new("tasklist");
    command.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
    let output = match command.output() {
        Ok(output) => output,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&output.stdout);
    text.contains(&pid.to_string())
}

#[cfg(not(target_os = "windows"))]
fn process_exists(pid: u32) -> bool {
    let status = Command::new("kill").args(["-0", &pid.to_string()]).status();
    status.map(|s| s.success()).unwrap_or(false)
}

fn kill_backend(log_path: &Path) -> Result<()> {
    log(log_path, "stopping backend")?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("taskkill");
        command.args(["/F", "/IM", "flask-backend.exe"]);
        command.creation_flags(0x08000000);
        let _ = command.output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("pkill").args(["-f", "flask-backend"]).output();
    }
    Ok(())
}

fn log(path: &Path, message: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "[{}] {}", now_epoch(), message)?;
    Ok(())
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
