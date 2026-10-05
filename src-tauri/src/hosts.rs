// hosts 文件解析 / 序列化 / 读写 —— 移植自 GitHub520-Desktop 的 src/main/hosts.js，逻辑 1:1 对齐
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MANAGED_START: &str = "# >>> GitHub520 managed start";
pub const MANAGED_END: &str = "# <<< GitHub520 managed end";
pub const MANAGED_TAG: &str = "GitHub520";
const OFF_PREFIX: &str = "[off]";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Row {
    #[serde(rename = "raw")]
    Raw { id: String, text: String },
    #[serde(rename = "entry")]
    Entry {
        id: String,
        ip: String,
        hosts: Vec<String>,
        #[serde(default)]
        comment: Option<String>,
        enabled: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        managed: Option<bool>,
    },
}

impl Row {
    pub fn id(&self) -> &str {
        match self {
            Row::Raw { id, .. } => id,
            Row::Entry { id, .. } => id,
        }
    }
}

static mut ID_SEQ: u64 = 0;

pub fn new_id() -> String {
    let n = unsafe {
        ID_SEQ += 1;
        ID_SEQ
    };
    format!(
        "r{:x}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
        n
    )
}

pub fn hosts_path() -> PathBuf {
    if let Ok(p) = std::env::var("GITHUB520_HOSTS_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| "C:\\Windows".into());
    Path::new(&root).join("System32\\drivers\\etc\\hosts")
}

pub fn is_ip(v: &str) -> bool {
    if v.is_empty() {
        return false;
    }
    if v.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    // IPv6（含 ::1、fe80::1 等）
    v.contains(':') && v.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
}

pub fn is_hostname(v: &str) -> bool {
    if v.is_empty() || v.len() > 253 {
        return false;
    }
    for seg in v.split('.') {
        if seg.is_empty() {
            return false;
        }
        for (i, c) in seg.chars().enumerate() {
            let ok = c.is_ascii_alphanumeric() || c == '_' || (c == '-' && i > 0 && i < seg.len() - 1);
            if !ok {
                return false;
            }
        }
        let bytes = seg.as_bytes();
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        if !(first.is_ascii_alphanumeric() || first == '_') || !(last.is_ascii_alphanumeric() || last == '_') {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone)]
struct EntryBody {
    ip: String,
    hosts: Vec<String>,
    comment: String,
}

/// 解析 "IP host1 host2  # comment" 形式的正文
fn parse_entry_body(s: &str) -> Option<EntryBody> {
    let (mut core, comment) = match s.find('#') {
        Some(i) => (&s[..i], s[i + 1..].trim().to_string()),
        None => (s, String::new()),
    };
    core = core.trim();
    let parts: Vec<&str> = core.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    if !is_ip(parts[0]) {
        return None;
    }
    let hosts: Vec<String> = parts[1..].iter().map(|h| h.to_string()).collect();
    if !hosts.iter().all(|h| is_hostname(h)) {
        return None;
    }
    Some(EntryBody {
        ip: parts[0].to_string(),
        hosts,
        comment,
    })
}

fn parse_line(raw: &str) -> Row {
    let trimmed = raw.trim_start();
    if let Some(rest) = trimmed.strip_prefix('#') {
        let inner = rest.trim();
        if let Some(body) = inner.strip_prefix(OFF_PREFIX) {
            let body = body.trim();
            if let Some(e) = parse_entry_body(body) {
                return Row::Entry {
                    id: new_id(),
                    ip: e.ip,
                    hosts: e.hosts,
                    comment: if e.comment.is_empty() { None } else { Some(e.comment) },
                    enabled: false,
                    managed: None,
                };
            }
        }
        // 普通注释：原样保留，不做任何推断
        return Row::Raw {
            id: new_id(),
            text: raw.to_string(),
        };
    }
    if let Some(e) = parse_entry_body(raw) {
        return Row::Entry {
            id: new_id(),
            ip: e.ip,
            hosts: e.hosts,
            comment: if e.comment.is_empty() { None } else { Some(e.comment) },
            enabled: true,
            managed: None,
        };
    }
    Row::Raw {
        id: new_id(),
        text: raw.to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total: usize,
    pub enabled: usize,
    pub managed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostsFile {
    pub path: String,
    pub rows: Vec<Row>,
    pub stats: Stats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn read() -> HostsFile {
    let file = hosts_path();
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) => {
            return HostsFile {
                path: file.to_string_lossy().to_string(),
                rows: vec![],
                stats: Stats { total: 0, enabled: 0, managed: 0 },
                error: Some(format!("读取失败: {}", e)),
            }
        }
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    if let Some(last) = lines.last() {
        if last.is_empty() {
            lines.pop();
        }
    }
    let mut rows: Vec<Row> = lines.iter().map(|l| parse_line(l)).collect();

    // 标记 GitHub520 托管区块
    let mut in_block = false;
    for r in rows.iter_mut() {
        match r {
            Row::Raw { text, .. } => {
                let t = text.trim();
                if t.starts_with("# >>> GitHub520") {
                    in_block = true;
                } else if t.starts_with("# <<< GitHub520") {
                    in_block = false;
                }
            }
            Row::Entry { managed, .. } => {
                if in_block {
                    *managed = Some(true);
                }
            }
        }
    }

    let total = rows.iter().filter(|r| matches!(r, Row::Entry { .. })).count();
    let enabled = rows
        .iter()
        .filter(|r| matches!(r, Row::Entry { enabled: true, .. }))
        .count();
    let managed = rows
        .iter()
        .filter(|r| matches!(r, Row::Entry { managed: Some(true), .. }))
        .count();

    HostsFile {
        path: file.to_string_lossy().to_string(),
        rows,
        stats: Stats { total, enabled, managed },
        error: None,
    }
}

/// rows -> 文件文本
pub fn serialize(rows: &[Row]) -> String {
    let out: Vec<String> = rows
        .iter()
        .map(|r| match r {
            Row::Raw { text, .. } => text.clone(),
            Row::Entry { ip, hosts, comment, enabled, .. } => {
                let pad = " ".repeat(std::cmp::max(2, 20usize.saturating_sub(ip.len())));
                let head = format!("{}{}{}", ip, pad, hosts.join(" "));
                let prefix = if *enabled { "" } else { "# [off] " };
                match comment {
                    Some(c) if !c.is_empty() => format!("{}{}  # {}", prefix, head, c),
                    _ => format!("{}{}", prefix, head),
                }
            }
        })
        .collect();
    let mut text = out.join("\n");
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.replace('\n', "\r\n")
}

/// 生成备份，返回备份文件路径
pub fn backup(backup_dir: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(backup_dir)?;
    let now = chrono_like_now();
    let name = format!(
        "hosts.{}{}{}-{}{}{}.bak",
        now.0, now.1, now.2, now.3, now.4, now.5
    );
    let dest = backup_dir.join(name);
    fs::copy(hosts_path(), &dest)?;
    // 仅保留最近 20 份
    if let Ok(mut files) = fs::read_dir(backup_dir) {
        let mut names: Vec<String> = files
            .try_fold(Vec::new(), |mut acc, e| -> std::io::Result<Vec<String>> {
                let e = e?;
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("hosts.") && n.ends_with(".bak") {
                    acc.push(n);
                }
                Ok(acc)
            })
            .unwrap_or_default();
        names.sort();
        while names.len() > 20 {
            let first = names.remove(0);
            let _ = fs::remove_file(backup_dir.join(first));
        }
        let _ = &mut files;
    }
    Ok(dest)
}

/// 避免引入 chrono：取本地时间的 (年,月,日,时,分,秒)
fn chrono_like_now() -> (String, String, String, String, String, String) {
    #[cfg(windows)]
    {
        unsafe {
            use std::mem::zeroed;
            #[repr(C)]
            struct SysTime {
                year: u16,
                month: u16,
                day_of_week: u16,
                day: u16,
                hour: u16,
                minute: u16,
                second: u16,
                milliseconds: u16,
            }
            extern "system" {
                fn GetLocalTime(lp: *mut SysTime);
            }
            let mut st: SysTime = zeroed();
            GetLocalTime(&mut st);
            let p = |n: u16| format!("{:02}", n);
            (
                format!("{}", st.year),
                p(st.month),
                p(st.day),
                p(st.hour),
                p(st.minute),
                p(st.second),
            )
        }
    }
    #[cfg(not(windows))]
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let days = secs / 86400;
        let time = secs % 86400;
        let p = |n: u64| format!("{:02}", n);
        (
            format!("{}", 1970 + days / 365),
            p(1),
            p(1),
            p(time / 3600),
            p(time % 3600 / 60),
            p(time % 60),
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need_admin: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 写入 hosts 文件（失败时返回 needAdmin 提示）
pub fn write(content: &str, backup_dir: Option<&Path>) -> WriteResult {
    if let Some(dir) = backup_dir {
        let _ = backup(dir);
    }
    match fs::write(hosts_path(), content) {
        Ok(_) => WriteResult { ok: true, need_admin: None, message: None },
        Err(e) => {
            let code = e.raw_os_error();
            // ERROR_ACCESS_DENIED 5 / ERROR_SHARING_VIOLATION 32 / 只读 19
            let need_admin = matches!(code, Some(5) | Some(19) | Some(32) | Some(33));
            WriteResult {
                ok: false,
                need_admin: if need_admin { Some(true) } else { None },
                message: Some(if need_admin {
                    "写入 hosts 需要管理员权限".to_string()
                } else {
                    e.to_string()
                }),
            }
        }
    }
}

/// 是否有写入权限：直接以读写模式真实探测（access 语义在 Windows 上不可靠）
pub fn can_write() -> bool {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(hosts_path())
        .map(|_| true)
        .unwrap_or(false)
}

/// 应用同步结果：重建 GitHub520 托管区块，保留用户对每个域名的启用/禁用选择
pub fn apply_managed(rows: &[Row], pairs: &[(String, String)]) -> Vec<Row> {
    let synced: std::collections::HashSet<&str> = pairs.iter().map(|p| p.1.as_str()).collect();

    // 1) 记录用户对这些域名的启用/禁用意图（托管区块内的状态优先）
    let mut prev: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    for r in rows {
        if let Row::Entry { hosts, enabled, managed, .. } = r {
            if managed.unwrap_or(false) {
                continue;
            }
            for h in hosts {
                if synced.contains(h.as_str()) {
                    prev.entry(h.clone()).or_insert(*enabled);
                }
            }
        }
    }
    for r in rows {
        if let Row::Entry { hosts, enabled, managed, .. } = r {
            if !managed.unwrap_or(false) {
                continue;
            }
            for h in hosts {
                if synced.contains(h.as_str()) {
                    prev.insert(h.clone(), *enabled);
                }
            }
        }
    }

    // 2) 定位并移除旧区块（含标记行）
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    for (i, r) in rows.iter().enumerate() {
        if let Row::Raw { text, .. } = r {
            let t = text.trim();
            if start.is_none() && t.starts_with("# >>> GitHub520") {
                start = Some(i);
            } else if start.is_some() && t.starts_with("# <<< GitHub520") {
                end = Some(i);
                break;
            }
        }
    }
    let mut next: Vec<Row> = rows.to_vec();
    if let (Some(s), Some(e)) = (start, end) {
        if e > s {
            next.drain(s..=e);
        }
    }

    // 3) 清理未标记的重复条目：远端对这批域名是权威来源
    let mut next: Vec<Row> = next
        .into_iter()
        .filter_map(|r| match r {
            Row::Entry { id, ip, hosts, comment, enabled, managed } => {
                let keep: Vec<String> = hosts.into_iter().filter(|h| !synced.contains(h.as_str())).collect();
                if keep.len() == 0 {
                    None
                } else {
                    Some(Row::Entry { id, ip, hosts: keep, comment, enabled, managed })
                }
            }
            other => Some(other),
        })
        .collect();

    // 4) 构建新区块插到文件开头
    let mut block: Vec<Row> = vec![Row::Raw { id: new_id(), text: MANAGED_START.to_string() }];
    for (ip, host) in pairs {
        block.push(Row::Entry {
            id: new_id(),
            ip: ip.clone(),
            hosts: vec![host.clone()],
            comment: Some(MANAGED_TAG.to_string()),
            enabled: prev.get(host).copied().unwrap_or(true),
            managed: Some(true),
        });
    }
    block.push(Row::Raw { id: new_id(), text: MANAGED_END.to_string() });
    block.append(&mut next);
    block
}
