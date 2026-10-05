// 延迟测速：TCP 443 建连耗时 —— 移植自 src/main/speedtest.js
use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
pub struct SpeedItem {
    pub id: Option<String>,
    pub target: String,
    #[serde(default)]
    pub ip: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeedRow {
    pub id: Option<String>,
    pub host: String,
    pub ip: String,
    pub resolved: Option<String>,
    pub ok: bool,
    pub latency: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub loss: f64,
    pub error: Option<String>,
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn tcp_ping(target: &str, port: u16, timeout: Duration) -> Result<f64, String> {
    let addrs: Vec<_> = (target, port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .collect();
    let addr = addrs.into_iter().next().ok_or_else(|| "无法解析地址".to_string())?;
    let start = Instant::now();
    TcpStream::connect_timeout(&addr, timeout)
        .map(|_| start.elapsed().as_secs_f64() * 1000.0)
        .map_err(|e| e.kind().to_string())
}

/// 把主机名解析为当前生效的 IP（走系统 hosts + DNS）
pub fn resolve_host(host: &str) -> Option<String> {
    (host, 443)
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next())
        .map(|a| a.ip().to_string())
}

#[derive(Debug, Clone)]
pub struct MeasureOut {
    pub ok: bool,
    pub latency: Option<f64>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub loss: f64,
    pub error: Option<String>,
}

pub fn measure(target: &str, samples: usize, port: u16, timeout_ms: u64) -> MeasureOut {
    let timeout = Duration::from_millis(timeout_ms);
    let mut oks: Vec<f64> = vec![];
    let mut first_err: Option<String> = None;
    let mut fails = 0usize;
    for _ in 0..samples.max(1) {
        match tcp_ping(target, port, timeout) {
            Ok(ms) => oks.push(ms),
            Err(e) => {
                fails += 1;
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    let total = samples.max(1) as f64;
    if oks.is_empty() {
        return MeasureOut {
            ok: false,
            latency: None,
            min: None,
            max: None,
            loss: 1.0,
            error: first_err.or(Some("不可达".to_string())),
        };
    }
    oks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    MeasureOut {
        ok: true,
        latency: Some(round2(oks[oks.len() / 2])),
        min: Some(round2(oks[0])),
        max: Some(round2(oks[oks.len() - 1])),
        loss: fails as f64 / total,
        error: None,
    }
}

/// 并发跑批，逐个回调 on_progress(row, finished, total)
pub fn run_batch<F>(
    items: Vec<SpeedItem>,
    samples: usize,
    port: u16,
    timeout_ms: u64,
    concurrency: usize,
    on_progress: F,
) -> Vec<SpeedRow>
where
    F: Fn(SpeedRow, usize, usize) + Send + Sync,
{
    let total = items.len();
    if total == 0 {
        return vec![];
    }
    let n = concurrency.clamp(1, total).max(1);
    let index = std::sync::atomic::AtomicUsize::new(0);
    let finished = std::sync::atomic::AtomicUsize::new(0);
    let results = Arc::new(Mutex::new(Vec::<SpeedRow>::new()));
    let cb = Arc::new(Mutex::new(on_progress));
    let items = Arc::new(items);

    std::thread::scope(|s| {
        for _ in 0..n {
            s.spawn(|| {
                loop {
                    let i = index.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let it = &items[i];
                    let m = measure(&it.target, samples, port, timeout_ms);
                    let resolved = it.host.as_deref().and_then(resolve_host);
                    let row = SpeedRow {
                        id: it.id.clone(),
                        host: it.host.clone().unwrap_or_else(|| it.target.clone()),
                        ip: it.ip.clone().unwrap_or_else(|| resolved.clone().unwrap_or_else(|| it.target.clone())),
                        resolved,
                        ok: m.ok,
                        latency: m.latency,
                        min: m.min,
                        max: m.max,
                        loss: m.loss,
                        error: m.error,
                    };
                    let done = finished.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    results.lock().unwrap().push(row.clone());
                    if let Ok(f) = cb.lock() {
                        f(row, done, total);
                    }
                }
            });
        }
    });

    let mut out = results.lock().unwrap().clone();
    out.sort_by(|a, b| {
        if a.ok != b.ok {
            return if a.ok { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.latency.unwrap_or(1e9).partial_cmp(&b.latency.unwrap_or(1e9)).unwrap()
    });
    out
}
