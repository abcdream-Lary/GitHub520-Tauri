// 前端桥接：把 Electron 版的 window.api 面 1:1 映射到 Tauri 的 invoke / listen
// 渲染层（app.js / styles.css）因此零改动复用。打包成 IIFE 输出 frontend/tauri-api.js
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const api = {
  /* 应用 */
  info: () => invoke('app_info'),
  quit: () => invoke('app_quit'),

  /* hosts */
  hosts: {
    read: () => invoke('hosts_read'),
    write: (rows) => invoke('hosts_write', { rows }),
    writeAdmin: (rows) => invoke('hosts_write_admin', { rows }),
    backup: () => invoke('hosts_backup'),
  },

  /* 配置 / 自启动 */
  config: {
    patch: (obj) => invoke('config_patch', { obj }),
  },
  autostart: {
    set: (enabled) => invoke('autostart_set', { enabled }),
  },

  /* 同步 */
  sync: {
    run: (opts) => invoke('sync_run', { opts }),
    apply: (rows) => invoke('sync_apply', { rows }),
  },

  /* 测速 */
  speed: {
    run: (items, opts) => invoke('speed_run', { items, opts }),
    one: (target, opts) => invoke('speed_one', { target, opts }),
  },

  /* 系统 */
  shell: {
    open: (p) => invoke('shell_open', { p }),
  },
  dialog: {
    confirm: (options) => invoke('dialog_confirm', { opts: options }),
  },

  /* 窗口：拖拽沿用 Electron 版「屏幕绝对坐标 + 主进程设位置」的方案，
     行为与 devtools 的 1:1 拖动回归断言一致 */
  win: {
    minimize: () => invoke('win_minimize'),
    toggleMax: () => invoke('win_toggle_max'),
    close: () => invoke('win_close'),
    show: () => invoke('win_show'),
    state: () => invoke('win_state'),
    dragStart: (sx, sy) => invoke('win_drag_start', { sx, sy }),
    dragMove: (sx, sy) => invoke('win_drag_move', { sx, sy }),
    dragEnd: () => invoke('win_drag_end'),
  },

  /* 事件订阅 */
  on: async (channel, cb) => listen(channel, (e) => cb(e.payload)),
};

window.api = api;

// 启动探针：确认渲染层已加载且 IPC 通道可用（结果写入自检报告文件）
try {
  invoke('selftest_log', {
    msg: 'BOOT_OK internals=' + typeof window.__TAURI_INTERNALS__ + ' api=' + typeof window.api,
  }).catch(() => {});
} catch (_) {}
