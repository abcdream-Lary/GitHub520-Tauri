// 极简 JSON 配置持久化 —— 移植自 src/main/store.js
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULTS_JSON: &str = r#"{
  "autostart": false,
  "startMinimized": false,
  "autoSync": true,
  "syncIntervalHours": 6,
  "syncUrl": "https://raw.hellogithub.com/hosts.json",
  "autoApplyOnSync": true,
  "lastSyncAt": null,
  "lastSyncResult": null,
  "theme": "light",
  "speedConcurrency": 8
}"#;

pub struct Store {
    path: PathBuf,
    cache: Map<String, Value>,
}

impl Store {
    pub fn init(dir: &Path) -> Self {
        let path = dir.join("config.json");
        let defaults: Value = serde_json::from_str(DEFAULTS_JSON).unwrap();
        let mut cache = match defaults {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(&text) {
                for (k, v) in saved {
                    cache.insert(k, v);
                }
            }
        }
        let s = Store { path, cache };
        s.save();
        s
    }

    fn save(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let value = Value::Object(self.cache.clone());
        let _ = fs::write(&self.path, serde_json::to_string_pretty(&value).unwrap_or_default());
    }

    pub fn all(&self) -> Value {
        Value::Object(self.cache.clone())
    }

    pub fn get(&self, key: &str) -> Value {
        self.cache.get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn get_bool(&self, key: &str) -> bool {
        self.get(key).as_bool().unwrap_or(false)
    }

    pub fn get_i64(&self, key: &str, fallback: i64) -> i64 {
        self.get(key).as_i64().unwrap_or(fallback)
    }

    pub fn get_str(&self, key: &str) -> Option<String> {
        self.get(key).as_str().map(|s| s.to_string())
    }

    pub fn patch(&mut self, obj: Value) -> Value {
        if let Value::Object(m) = obj {
            for (k, v) in m {
                self.cache.insert(k, v);
            }
        }
        self.save();
        self.all()
    }
}
