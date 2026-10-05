# GitHub520 桌面客户端（Tauri 版）

[GitHub520](https://github.com/521xueweihan/GitHub520) 项目的 Windows 桌面客户端，使用 Tauri 2 + Rust + WebView2 重写，单文件约 5 MB、常驻内存约 30 MB。

> 修复 GitHub 访问的原理与数据完全来自上游 [521xueweihan/GitHub520](https://github.com/521xueweihan/GitHub520)，本项目只做桌面化的使用体验。

## 功能

- **hosts 管理**：读取/编辑/启用禁用系统 hosts 条目，自动识别 GitHub520 托管区块
- **一键同步**：从上游拉取最新 IP 并写入 hosts，无需管理员运行时自动走 UAC 提权
- **自动同步**：默认每 6 小时检查一次，启动时补同步；无变化不写盘、不产生垃圾备份
- **延迟测速**：对 GitHub 常用域名 TCP 测速，可设置并发数
- **备份**：每次写入前自动备份，保留最近 20 份
- **托盘常驻**：关闭窗口最小化到托盘，支持开机自启
- **单实例**：重复启动自动唤起已有窗口

## 下载

从 [Releases](../../releases) 下载 `github520-<版本号>.exe`，双击即用。

- 系统要求：Windows 10 1809 及以上（需 WebView2 Runtime，Win11 自带；Win10 缺失时程序会引导安装）

## 自行构建

依赖：Node.js 18+、Rust 1.77+（MSVC 工具链）、WebView2 Runtime。

```bash
npm install
npm run build
# 产物：src-tauri/target/release/github520-tauri.exe
```

可选参数：`npm run shim` 仅重新生成前端桥接层（frontend/tauri-api.js）。

## 自检

```bash
github520-tauri.exe --selftest
```

真窗口跑 15 项断言（桥接、hosts 读写、页面切换、列表渲染、开关、搜索、关于页、窗口状态），报告写入 `%TEMP%\github520-selftest-report.txt`，退出码非 0 表示有失败项。

## 项目结构

```
frontend/           渲染层（HTML/CSS/JS，无框架）
  selftest.js         自检断言（--selftest 时由 app_info 标记触发）
tools/
  shim-entry.js       window.api 桥接层源码（esbuild 打包为 frontend/tauri-api.js）
src-tauri/
  src/main.rs         主进程：窗口、托盘、单实例、定时同步、命令注册
  src/hosts.rs        hosts 解析/序列化/备份/写入（含提权）
  src/sync.rs         拉取与合并逻辑
  src/speed.rs        TCP 并发测速
  src/store.rs        配置持久化
  src/system.rs       提权复制、系统信息、打开路径
```

## 许可

[MIT](LICENSE) © 2026 abcdream-Lary

数据与上游项目版权归 [521xueweihan/GitHub520](https://github.com/521xueweihan/GitHub520) 所有。仅供学习交流，请遵守当地法律法规。
