// 系统级能力：提权写入、系统信息、打开路径 —— 移植自 src/main/system.js
use std::fs;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW：GUI 程序拉起 cmd/powershell 这类控制台子进程时，
/// 系统会顺手开一个控制台窗口闪一下 —— 带上这个标志就不会创建控制台。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

const HELPER_NAME: &str = "elevate-copy.ps1";

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn ensure_helper(dir: &Path) -> Option<std::path::PathBuf> {
    let p = dir.join(HELPER_NAME);
    let script = [
        "param([string]$src, [string]$dst)",
        "$ErrorActionPreference = 'Stop'",
        "Copy-Item -LiteralPath $src -Destination $dst -Force",
        "if (-not (Test-Path -LiteralPath $dst)) { exit 2 }",
        "exit 0",
    ]
    .join("\n");
    fs::create_dir_all(dir).ok()?;
    fs::write(&p, script).ok()?;
    Some(p)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ElevatedResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 以管理员权限把 content 覆盖到 dst（UAC → PowerShell 提权复制）
pub fn write_elevated(content: &str, dst: &str, tmp_dir: &Path) -> ElevatedResult {
    if let Err(e) = fs::create_dir_all(tmp_dir) {
        return ElevatedResult { ok: false, cancelled: None, message: Some(e.to_string()) };
    }
    let tmp = tmp_dir.join(format!("hosts.tmp.{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)));
    if let Err(e) = fs::write(&tmp, content) {
        return ElevatedResult { ok: false, cancelled: None, message: Some(e.to_string()) };
    }
    let res = elevated_copy(&tmp.to_string_lossy(), dst, tmp_dir);
    let _ = fs::remove_file(&tmp);
    res
}

pub fn elevated_copy(src: &str, dst: &str, tmp_dir: &Path) -> ElevatedResult {
    let helper = match ensure_helper(tmp_dir) {
        Some(p) => p,
        None => {
            return ElevatedResult {
                ok: false,
                cancelled: None,
                message: Some("无法创建提权辅助脚本".to_string()),
            }
        }
    };
    let ps = format!(
        "$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile,-ExecutionPolicy,Bypass,-File,{helper},-src,{src},-dst,{dst}' -Verb RunAs -WindowStyle Hidden -Wait",
        helper = ps_quote(&helper.to_string_lossy()),
        src = ps_quote(src),
        dst = ps_quote(dst),
    );
    let out = quiet(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps]),
    )
    .output();
    match out {
        Ok(o) if o.status.success() => ElevatedResult { ok: true, cancelled: None, message: None },
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).to_string();
            // 用户在 UAC 上点了「否」
            let cancelled = msg.contains("cancel") || msg.contains("denied") || msg.contains("拒绝") || msg.contains("用户");
            ElevatedResult {
                ok: false,
                cancelled: Some(cancelled),
                message: Some(if cancelled { "已取消管理员授权".to_string() } else { msg }),
            }
        }
        Err(e) => ElevatedResult { ok: false, cancelled: None, message: Some(e.to_string()) },
    }
}

pub fn open_path(p: &str) {
    let _ = quiet(Command::new("explorer").arg(p)).spawn();
}

/// WebView2 Runtime 版本：读注册表（Evergreen 与 Fixed Version 都写这里）。
/// 不用 tauri::webview_version()——在 invoke 命令线程上会阻塞 app_info。
#[cfg(windows)]
fn webview2_version() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hk = RegKey::predef(HKEY_LOCAL_MACHINE);
    for path in [
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ] {
        if let Ok(k) = hk.open_subkey(path) {
            if let Ok(v) = k.get_value::<String, _>("pv") {
                if !v.is_empty() {
                    return v;
                }
            }
        }
    }
    String::new()
}

#[cfg(not(windows))]
fn webview2_version() -> String {
    String::new()
}

/// Windows 版本号（对齐原 `cmd /c ver` 的输出格式 10.0.xxxx.xxxx），
/// 直接读注册表，不再拉子进程。
#[cfg(windows)]
fn windows_version() -> String {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hk = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(k) = hk.open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") {
        let major: u32 = k.get_value("CurrentMajorVersionNumber").unwrap_or(10);
        let minor: u32 = k.get_value("CurrentMinorVersionNumber").unwrap_or(0);
        let build: String = k.get_value("CurrentBuildNumber").unwrap_or_default();
        let ubr: u32 = k.get_value("UBR").unwrap_or(0);
        if !build.is_empty() {
            return format!("{}.{}.{}.{}", major, minor, build, ubr);
        }
    }
    String::new()
}

#[cfg(not(windows))]
fn windows_version() -> String {
    String::new()
}

pub fn system_info(app_version: &str) -> serde_json::Value {
    let mut release = windows_version();
    if release.is_empty() {
        release = "-".to_string();
    }
    serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "release": release,
        "appVersion": app_version,
        "webview": webview2_version(),
        "node": "-",
        "packaged": true,
    })
}
