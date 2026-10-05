// 远端 hosts 配置同步 —— 移植自 src/main/sync.js
use crate::hosts::{is_hostname, is_ip};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const FALLBACK_SOURCES: [&str; 3] = [
    "https://raw.hellogithub.com/hosts.json",
    "https://cdn.jsdelivr.net/gh/521xueweihan/GitHub520@main/hosts.json",
    "https://raw.githubusercontent.com/521xueweihan/GitHub520/main/hosts.json",
];

fn fetch_pairs(url: &str) -> Result<Vec<(String, String)>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let data: Vec<Vec<String>> = resp.json().map_err(|_| "返回内容不是数组".to_string())?;
    let pairs: Vec<(String, String)> = data
        .into_iter()
        .filter(|it| it.len() >= 2 && is_ip(&it[0]) && is_hostname(&it[1]))
        .map(|it| (it[0].trim().to_string(), it[1].trim().to_string()))
        .collect();
    if pairs.is_empty() {
        return Err("未解析到有效条目".to_string());
    }
    Ok(pairs)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub ok: bool,
    pub at: i64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    pub changed: i64,
    pub applied: bool,
    pub message: String,
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need_admin: Option<bool>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn host_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

/// 执行一次同步；返回 (结果, 待落盘的 rows)
pub fn run_sync(
    primary_opt: Option<String>,
    apply: bool,
    auto_apply_default: bool,
) -> (SyncResult, Option<Vec<crate::hosts::Row>>) {
    let primary = primary_opt.unwrap_or_else(|| FALLBACK_SOURCES[0].to_string());
    let mut sources: Vec<String> = vec![primary.clone()];
    for s in FALLBACK_SOURCES {
        if s != primary {
            sources.push(s.to_string());
        }
    }

    let mut errors: Vec<String> = vec![];
    let mut pairs: Option<Vec<(String, String)>> = None;
    let mut used_source: Option<String> = None;

    for url in &sources {
        match fetch_pairs(url) {
            Ok(p) => {
                pairs = Some(p);
                used_source = Some(url.clone());
                break;
            }
            Err(e) => errors.push(format!("{}: {}", host_of(url), e)),
        }
    }

    let pairs = match pairs {
        Some(p) => p,
        None => {
            let result = SyncResult {
                ok: false,
                at: now_ms(),
                source: primary,
                count: None,
                changed: 0,
                applied: false,
                message: format!("全部同步源失败 — {}", errors.join(" | ")),
                errors,
                need_admin: None,
            };
            return (result, None);
        }
    };

    let mut result = SyncResult {
        ok: true,
        at: now_ms(),
        source: used_source.unwrap_or(primary),
        count: Some(pairs.len()),
        changed: 0,
        applied: false,
        message: format!("获取到 {} 条记录", pairs.len()),
        errors,
        need_admin: None,
    };

    let prev = crate::hosts::read();
    let rows = crate::hosts::apply_managed(&prev.rows, &pairs);

    if apply || auto_apply_default {
        let before = serde_json::to_string(
            &prev
                .rows
                .iter()
                .filter_map(|r| match r {
                    crate::hosts::Row::Entry { ip, hosts, managed: Some(true), .. } => {
                        Some(vec![ip.clone(), hosts.join(" ")])
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default();
        let after = serde_json::to_string(
            &rows
                .iter()
                .filter_map(|r| match r {
                    crate::hosts::Row::Entry { ip, hosts, managed: Some(true), .. } => {
                        Some(vec![ip.clone(), hosts.join(" ")])
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
        )
        .unwrap_or_default();
        result.changed = if before == after { 0 } else { pairs.len() as i64 };
        result.applied = true;
    } else {
        result.changed = pairs.len() as i64;
    }

    (result, Some(rows))
}
