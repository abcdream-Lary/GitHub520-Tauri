// GitHub520 · Tauri 版主进程 —— 行为对齐 Electron 版 src/main/index.js
//
// Windows release 构建声明为 GUI 子系统：
// 不加这一行，exe 本身是控制台程序，双击启动时系统会分配一个黑色控制台窗口。
// （CREATE_NO_WINDOW 只能压住子进程的控制台，压不住 exe 自己的。）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hosts;
mod speed;
mod store;
mod sync;
mod system;

use std::path::PathBuf;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

struct AppState {
    store: Mutex<store::Store>,
    /// 自身写入后短时间内忽略 hosts 变更事件
    suppress_until: AtomicU64,
    drag: Mutex<Option<DragOrigin>>,
}

struct DragOrigin {
    wx: i32,
    wy: i32,
    sx: i32,
    sy: i32,
}

impl AppState {
    fn suppress(&self, ms: u64) {
        self.suppress_until.store(now_ms() + ms, Ordering::Relaxed);
    }
    fn suppressed(&self) -> bool {
        now_ms() < self.suppress_until.load(Ordering::Relaxed)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn state<'a>(app: &'a tauri::AppHandle) -> tauri::State<'a, AppState> {
    app.state::<AppState>()
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir unavailable")
}

/* ---------------- 命令 ---------------- */

/// 自检期诊断日志：只在 --selftest 模式写报告文件，正式版零开销
fn diag(msg: &str) {
    if std::env::args().any(|a| a == "--selftest") {
        append_report(msg);
    }
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Value {
    diag("AI: enter");
    let s = state(&app);
    diag("AI: locking store");
    let cfg = s.store.lock().unwrap().all();
    diag("AI: store ok");
    let autostart = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(false);
    diag("AI: autostart ok");
    let sys = system::system_info(&app.package_info().version.to_string());
    diag("AI: sysinfo ok");
    let cw = hosts::can_write();
    diag("AI: canwrite ok");
    let info = json!({
        "system": sys,
        "hostsPath": hosts::hosts_path().to_string_lossy(),
        "canWrite": cw,
        "autostart": autostart,
        "config": cfg,
        "userData": data_dir(&app).to_string_lossy(),
        "selftest": std::env::args().any(|a| a == "--selftest"),
    });
    diag("AI: done");
    info
}

#[tauri::command]
fn hosts_read() -> Value {
    serde_json::to_value(hosts::read()).unwrap_or(json!({ "rows": [] }))
}

#[tauri::command]
fn hosts_write(app: tauri::AppHandle, rows: Vec<hosts::Row>) -> Value {
    let content = hosts::serialize(&rows);
    let dir = data_dir(&app).join("backups");
    let res = hosts::write(&content, Some(&dir));
    state(&app).suppress(1500);
    if res.ok {
        json!({ "ok": true })
    } else if res.need_admin.unwrap_or(false) {
        json!({ "ok": false, "needAdmin": true, "message": res.message })
    } else {
        json!({ "ok": false, "message": res.message })
    }
}

#[tauri::command]
fn hosts_write_admin(app: tauri::AppHandle, rows: Vec<hosts::Row>) -> Value {
    let content = hosts::serialize(&rows);
    let tmp_dir = data_dir(&app).join("tmp");
    let res = system::write_elevated(&content, &hosts::hosts_path().to_string_lossy(), &tmp_dir);
    state(&app).suppress(1500);
    if !res.ok {
        return json!({ "ok": false, "cancelled": res.cancelled, "message": res.message });
    }
    let after = hosts::read();
    json!({ "ok": true, "rows": after.rows })
}

#[tauri::command]
fn hosts_backup(app: tauri::AppHandle) -> Value {
    let dir = data_dir(&app).join("backups");
    match hosts::backup(&dir) {
        Ok(p) => json!({ "ok": true, "path": p.to_string_lossy() }),
        Err(e) => json!({ "ok": false, "message": e.to_string() }),
    }
}

#[tauri::command]
fn config_patch(app: tauri::AppHandle, obj: Value) -> Value {
    let need_reschedule = obj
        .get("syncIntervalHours")
        .or_else(|| obj.get("autoSync"))
        .is_some();
    let cfg = state(&app).store.lock().unwrap().patch(obj);
    if need_reschedule {
        schedule_sync(app);
    }
    cfg
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Value {
    let res = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    if let Err(e) = res {
        return json!({ "ok": false, "message": e.to_string() });
    }
    state(&app)
        .store
        .lock()
        .unwrap()
        .patch(json!({ "autostart": enabled }));
    let real = app
        .autolaunch()
        .is_enabled()
        .unwrap_or(false);
    json!({ "ok": real == enabled, "enabled": real, "message": if real == enabled { "" } else { "系统未接受该设置，可能需要手动在「任务管理器 → 启动」中确认" } })
}

#[derive(Debug, Deserialize)]
struct SyncOpts {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    apply: Option<bool>,
}

/// 同步主逻辑（阻塞版，供命令与定时线程共用）
fn do_sync(app: &tauri::AppHandle, opts: Option<SyncOpts>) -> sync::SyncResult {
    let s = state(app);
    let (cfg_url, auto_apply) = {
        let st = s.store.lock().unwrap();
        (st.get_str("syncUrl"), st.get_bool("autoApplyOnSync"))
    };
    let apply = opts.as_ref().and_then(|o| o.apply).unwrap_or(auto_apply);
    let (mut result, rows_opt) = sync::run_sync(
        opts.as_ref().and_then(|o| o.url.clone()).or(cfg_url),
        apply,
        apply,
    );

    if result.ok {
        if let Some(rows) = rows_opt {
            if result.changed == 0 {
                // 托管区块与文件现状一致：不落盘、不产生无意义备份
                result.applied = true;
                result.message = "配置无变化".to_string();
            } else {
                let content = hosts::serialize(&rows);
                let dir = data_dir(app).join("backups");
                let w = hosts::write(&content, Some(&dir));
                s.suppress(1500);
                if !w.ok && w.need_admin.unwrap_or(false) {
                    result.applied = false;
                    result.need_admin = Some(true);
                    result.message = "已获取最新配置，但写入 hosts 需要管理员权限".to_string();
                } else if !w.ok {
                    result.applied = false;
                    result.message = format!("已获取最新配置，但写入失败：{}", w.message.unwrap_or_default());
                }
            }
        }
        let persisted = serde_json::to_value(&result).unwrap_or(json!(null));
        s.store
            .lock()
            .unwrap()
            .patch(json!({ "lastSyncAt": result.at, "lastSyncResult": persisted }));
    }

    let _ = app.emit("sync:result", serde_json::to_value(&result).unwrap_or(json!(null)));
    result
}

#[tauri::command]
async fn sync_run(app: tauri::AppHandle, opts: Option<SyncOpts>) -> Result<Value, String> {
    let res = tauri::async_runtime::spawn_blocking(move || do_sync(&app, opts))
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(res).unwrap_or(json!(null)))
}

#[tauri::command]
fn sync_apply(app: tauri::AppHandle, rows: Vec<hosts::Row>) -> Value {
    let content = hosts::serialize(&rows);
    let dir = data_dir(&app).join("backups");
    let res = hosts::write(&content, Some(&dir));
    state(&app).suppress(1500);
    serde_json::to_value(res).unwrap_or(json!({ "ok": false }))
}

#[derive(Debug, Deserialize)]
struct SpeedOpts {
    #[serde(default)]
    samples: Option<usize>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    timeout: Option<u64>,
}

#[tauri::command]
async fn speed_run(
    app: tauri::AppHandle,
    items: Vec<speed::SpeedItem>,
    opts: Option<SpeedOpts>,
) -> Result<Value, String> {
    let samples = opts.as_ref().and_then(|o| o.samples).unwrap_or(3);
    let port = opts.as_ref().and_then(|o| o.port).unwrap_or(443);
    let timeout = opts.as_ref().and_then(|o| o.timeout).unwrap_or(2000);
    let concurrency = {
        let st = app.state::<AppState>();
        let n = st.store.lock().unwrap().get_i64("speedConcurrency", 8);
        n as usize
    };
    let handle = app.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        speed::run_batch(items, samples, port, timeout, concurrency, move |row, finished, total| {
            let _ = handle.emit(
                "speed:progress",
                json!({ "row": row, "prog": { "finished": finished, "total": total } }),
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(rows).unwrap_or(json!([])))
}

#[derive(Debug, Serialize)]
struct SpeedOne {
    target: String,
    resolved: Option<String>,
    ok: bool,
    latency: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
    loss: f64,
    error: Option<String>,
}

#[tauri::command]
async fn speed_one(target: String, opts: Option<SpeedOpts>) -> Result<Value, String> {
    let samples = opts.as_ref().and_then(|o| o.samples).unwrap_or(3);
    let port = opts.as_ref().and_then(|o| o.port).unwrap_or(443);
    let timeout = opts.as_ref().and_then(|o| o.timeout).unwrap_or(2000);
    let t = target.clone();
    let (m, resolved) = tauri::async_runtime::spawn_blocking(move || {
        let m = speed::measure(&t, samples, port, timeout);
        let r = speed::resolve_host(&t);
        (m, r)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "target": target, "resolved": resolved, "ok": m.ok,
        "latency": m.latency, "min": m.min, "max": m.max, "loss": m.loss, "error": m.error,
    }))
}

#[tauri::command]
fn shell_open(p: String) {
    system::open_path(&p);
}

#[derive(Debug, Deserialize)]
struct ConfirmOpts {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

#[tauri::command]
async fn dialog_confirm(opts: Option<ConfirmOpts>) -> Result<bool, String> {
    let title = opts.as_ref().and_then(|o| o.title.clone()).unwrap_or_else(|| "确认".into());
    let message = opts.as_ref().and_then(|o| o.message.clone()).unwrap_or_default();
    let detail = opts.as_ref().and_then(|o| o.detail.clone()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let mut body = message;
        if !detail.is_empty() {
            body = format!("{}\n{}", body, detail);
        }
        rfd::MessageDialog::new()
            .set_title(&title)
            .set_description(&body)
            .set_buttons(rfd::MessageButtons::OkCancelCustom("确定".to_string(), "取消".to_string()))
            .show()
            == rfd::MessageDialogResult::Custom("确定".to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

/* ---------------- 窗口控制 ---------------- */

#[tauri::command]
fn win_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_max(window: tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn win_close(window: tauri::WebviewWindow) {
    let _ = window.hide();
    // 与系统关闭路径（CloseRequested）同语义：前端靠这个事件收起下拉/模态/悬停残留
    let _ = window.emit("win:hidden", ());
}

/// 唤起窗口（与托盘菜单/单实例唤起同语义；自检用它模拟"从后台开启窗口"）
#[tauri::command]
fn win_show(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn win_state(window: tauri::WebviewWindow) -> Value {
    json!({
        "maximized": window.is_maximized().unwrap_or(false),
        "focused": window.is_focused().unwrap_or(false),
    })
}

#[tauri::command]
fn win_drag_start(window: tauri::WebviewWindow, sx: i32, sy: i32) {
    let st = window.state::<AppState>();
    let mut guard = st.drag.lock().unwrap();
    *guard = if window.is_maximized().unwrap_or(false) {
        None
    } else {
        match window.outer_position() {
            Ok(p) => Some(DragOrigin { wx: p.x, wy: p.y, sx, sy }),
            Err(_) => None,
        }
    };
}

#[tauri::command]
fn win_drag_move(window: tauri::WebviewWindow, sx: i32, sy: i32) {
    let st = window.state::<AppState>();
    let target = {
        let guard = st.drag.lock().unwrap();
        match guard.as_ref() {
            Some(o) => Some((o.wx + (sx - o.sx), o.wy + (sy - o.sy))),
            None => None,
        }
    };
    if let Some((x, y)) = target {
        let cur = window.outer_position().ok();
        if cur.map(|p| p.x != x || p.y != y).unwrap_or(true) {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

#[tauri::command]
fn win_drag_end(window: tauri::WebviewWindow) {
    let st = window.state::<AppState>();
    let mut guard = st.drag.lock().unwrap();
    *guard = None;
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/* ---------------- 定时同步 ---------------- */

fn schedule_sync(app: tauri::AppHandle) {
    let s = state(&app);
    let (auto, hours, last) = {
        let st = s.store.lock().unwrap();
        (
            st.get_bool("autoSync"),
            st.get_i64("syncIntervalHours", 6).max(1) as u64,
            st.get("lastSyncAt").as_i64().unwrap_or(0) as u64,
        )
    };
    if !auto {
        return;
    }
    let interval = hours * 3600 * 1000;
    // 启动时：超过一个周期就补一次
    if now_ms().saturating_sub(last) >= interval {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let _ = do_sync(&handle, None);
        });
    }
    // 每 15 分钟检查一次是否到期（复用同一个后台线程，避免重复调度）
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15 * 60));
        let s = state(&handle);
        let (auto, hours, last) = {
            let st = s.store.lock().unwrap();
            (
                st.get_bool("autoSync"),
                st.get_i64("syncIntervalHours", 6).max(1) as u64,
                st.get("lastSyncAt").as_i64().unwrap_or(0) as u64,
            )
        };
        if !auto {
            break;
        }
        if now_ms().saturating_sub(last) >= hours * 3600 * 1000 - 60_000 {
            let _ = do_sync(&handle, None);
        }
    });
}

/* ---------------- 自检（--selftest） ---------------- */

/// 注入到 WebView 执行的断言脚本：验证桥接层 + 渲染层是否照常工作
const SELFTEST_JS: &str = r#"
(async () => {
  const raw = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const log = (m) => { try { raw('selftest_log', { msg: String(m) }); } catch (e) {} };
  window.onerror = (m) => log('JS_ERROR: ' + m);
  const out = [];
  const ok = (name, cond, extra) => out.push({ name, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  log('EVAL_OK api=' + (typeof window.api));
  try {
    log('step: app_info');
    const info = await window.api.info();
    ok('桥接可用：app_info 返回配置', !!(info && info.config), JSON.stringify(info).slice(0, 70));
    ok('hosts 路径已返回', !!(info && info.hostsPath), info && info.hostsPath);
    log('step: hosts_read');
    const h = await window.api.hosts.read();
    ok('hosts 读取成功且有内容', !!(h && h.rows && h.rows.length), (h.rows || []).length + ' 行');
    ok('页面骨架完整（4 个导航项）', $$('.nav-item').length === 4, $$('.nav-item').length + ' 个');
    ok('hosts 列表已渲染', $$('.erow').length > 0, $$('.erow').length + ' 行');
    for (const p of ['sync', 'speed', 'settings', 'hosts']) {
      log('step: page ' + p);
      $(`.nav-item[data-page="${p}"]`).click();
      await sleep(320);
      const act = $('.nav-item.active');
      ok('可切换到「' + p + '」页', !!act && act.dataset.page === p, act && act.dataset.page);
    }
    const rows = $$('.erow').length;
    const sw = $$('.erow .switch')[0];
    if (sw) {
      const before = sw.classList.contains('on');
      sw.click();
      await sleep(250);
      const nowOn = $$('.erow .switch')[0].classList.contains('on');
      ok('启用开关可切换', before !== nowOn, before + ' → ' + nowOn);
      $$('.erow .switch')[0].click();
      await sleep(200);
    } else {
      ok('存在启用开关', false, '未找到 .erow .switch');
    }
    ok('切换后列表行数稳定', $$('.erow').length === rows, $$('.erow').length + '/' + rows + ' 行');
  } catch (e) {
    log('EXCEPTION ' + ((e && e.message) || String(e)));
    ok('自检脚本执行异常', false, (e && e.message) || String(e));
  }
  log('step: report');
  try {
    await raw('selftest_report', { results: out });
  } catch (e) {
    log('REPORT_FAILED ' + ((e && e.message) || String(e)));
  }
})();
"#;

/// 追加一行到报告文件（真正的 append 打开，避免与其它线程读-改-写互相覆盖）
fn append_report(msg: &str) {
    let p = std::env::temp_dir().join("github520-selftest-report.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", msg);
    }
    println!("{}", msg);
}

#[tauri::command]
fn selftest_log(msg: String) {
    append_report(&msg);
}

#[derive(Debug, Deserialize)]
struct SelftestItem {
    name: String,
    pass: bool,
    #[serde(default)]
    extra: String,
}

#[tauri::command]
fn selftest_report(app: tauri::AppHandle, results: Vec<SelftestItem>) {
    let mut fail = 0usize;
    let mut text = String::new();
    for r in &results {
        let line = format!(
            "  {} {}{}",
            if r.pass { "✓" } else { "✗" },
            r.name,
            if r.pass {
                String::new()
            } else {
                format!(" → {}", r.extra)
            }
        );
        println!("{}", line);
        text.push_str(&line);
        text.push('\n');
        if !r.pass {
            fail += 1;
        }
    }
    let summary = format!("\n自检结果：{} 项通过，{} 项失败", results.len() - fail, fail);
    println!("{}", summary);
    text.push_str(&summary);
    // 只追加不覆盖：否则会抹掉前面追加的过程日志（多线程竞争）
    append_report(&text);
    app.exit(fail as i32);
}

/* ---------------- 入口 ---------------- */

fn file_mtime(p: &std::path::Path) -> Option<u128> {
    std::fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(min) = w.is_minimized() {
                    if min {
                        let _ = w.unminimize();
                    }
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            // 自检模式绝不能碰用户真实的系统 hosts：改到临时副本并补最小夹具
            if std::env::args().any(|a| a == "--selftest") && std::env::var("GITHUB520_HOSTS_PATH").is_err() {
                let tmp = std::env::temp_dir().join("github520-tauri-selftest-hosts");
                if !tmp.exists() {
                    let _ = std::fs::write(
                        &tmp,
                        [
                            "# GitHub520 自检夹具（临时文件，不是系统 hosts）",
                            "127.0.0.1 localhost",
                            "140.82.113.4 github.com",
                            "# [off] 1.2.3.4 example.com  # 演示：已禁用条目",
                            "",
                            "# >>> GitHub520 managed start",
                            "# <<< GitHub520 managed end",
                            "",
                        ]
                        .join("\n"),
                    );
                }
                std::env::set_var("GITHUB520_HOSTS_PATH", &tmp);
            }

            let dir = app.path().app_data_dir().expect("app data dir");
            let store = store::Store::init(&dir);
            // 同步本机记录的开机启动状态与配置
            let real = app
                .autolaunch()
                .is_enabled()
                .unwrap_or(false);
            if store.get_bool("autostart") != real {
                store_force_autostart(&dir, real);
            }
            app.manage(AppState {
                store: Mutex::new(store),
                suppress_until: AtomicU64::new(0),
                drag: Mutex::new(None),
            });

            let window = app.get_webview_window("main").expect("main window");
            let wh = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // 关闭时隐藏到托盘，避免后台同步被打断（退出走托盘菜单）
                    api.prevent_close();
                    let _ = wh.hide();
                    let _ = wh.emit("win:hidden", ());
                }
                tauri::WindowEvent::Focused(focused) => {
                    let _ = wh.emit("win:focus", json!({ "focused": focused }));
                }
                tauri::WindowEvent::Resized(_) => {
                    let maximized = wh.is_maximized().unwrap_or(false);
                    let _ = wh.emit("win:state", json!({ "maximized": maximized }));
                }
                _ => {}
            });

            // hosts 文件外部变更监听（轮询 mtime，避免额外依赖）
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let path = hosts::hosts_path();
                let mut last = file_mtime(&path);
                loop {
                    std::thread::sleep(Duration::from_millis(1500));
                    let cur = file_mtime(&path);
                    if cur != last {
                        last = cur;
                        if !state(&handle).suppressed() {
                            let _ = handle.emit("hosts:external-change", ());
                        }
                    }
                }
            });

            build_tray(app)?;

            let selftest = std::env::args().any(|a| a == "--selftest");
            let start_minimized = state(&app.handle()).store.lock().unwrap().get_bool("startMinimized");
            let w = app.get_webview_window("main").expect("main window");
            if !start_minimized || selftest {
                let _ = w.show();
                let _ = w.set_focus();
            }
            if selftest {
                // 断言由前端 selftest.js 执行（app_info 下发 selftest 标记触发）。
                // Tauri 的 eval 注入在本机 WebView2 上静默失效，故不走注入路线。
                append_report("SETUP_OK");
                // 诊断：Rust→JS 事件通道心跳（与 invoke 响应走同一 webview 回传路径）
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    for i in 0..30 {
                        std::thread::sleep(Duration::from_secs(3));
                        let _ = h.emit("diag:tick", json!({ "n": i, "at": now_ms() }));
                    }
                });
            }

            schedule_sync(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            hosts_read,
            hosts_write,
            hosts_write_admin,
            hosts_backup,
            config_patch,
            autostart_set,
            sync_run,
            sync_apply,
            speed_run,
            speed_one,
            shell_open,
            dialog_confirm,
            win_minimize,
            win_toggle_max,
            win_close,
            win_show,
            win_state,
            win_drag_start,
            win_drag_move,
            win_drag_end,
            app_quit,
            selftest_report,
            selftest_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitHub520");
}

fn store_force_autostart(dir: &std::path::Path, value: bool) {
    let p = dir.join("config.json");
    if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(mut v) = serde_json::from_str::<Value>(&text) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("autostart".into(), Value::Bool(value));
                let _ = std::fs::write(&p, serde_json::to_string_pretty(&v).unwrap_or_default());
            }
        }
    }
}

fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = tauri::menu::MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let sync_now = tauri::menu::MenuItem::with_id(app, "sync", "立即同步", true, None::<&str>)?;
    let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = tauri::menu::MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&sync_now)
        .separator()
        .item(&quit)
        .build()?;

    tauri::tray::TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("window icon"))
        .tooltip("GitHub520 · Hosts 管家")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "sync" => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let r = do_sync(&handle, None);
                    let msg = if r.ok {
                        format!("{}{}", r.message, if r.applied { "，已应用" } else { "" })
                    } else {
                        r.message
                    };
                    let _ = handle
                        .notification()
                        .builder()
                        .title("GitHub520 同步")
                        .body(msg)
                        .show();
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 仅左键单击唤起窗口；右键交给托盘菜单弹出
            // （此前未区分键位，右键也会走 show()，把弹出的菜单焦点抢掉）
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.set_focus();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}
