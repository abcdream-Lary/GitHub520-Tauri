# GitHub520 桌面客户端

[GitHub520](https://github.com/521xueweihan/GitHub520) 的 Windows 桌面版：一键把最新 GitHub IP 写入系统 hosts，解决访问问题。

基于 Tauri 2 + Rust + WebView2，绿色单文件约 5 MB，常驻内存约 30 MB。

## 功能

- **一键同步**：拉取上游最新 IP 写入 hosts，需要时自动弹出 UAC 提权
- **自动同步**：默认每 6 小时检查，配置无变化不写盘、不产生多余备份
- **hosts 管理**：条目增删改与启用/禁用，托管区块自动维护，手写内容不受影响
- **延迟测速**：TCP 并发测速，并发数可调
- **托盘常驻**：关闭窗口最小化到托盘，支持开机自启，单实例运行
- **自动备份**：每次写入前备份，保留最近 20 份

## 下载

从 [Releases](../../releases) 下载对应版本，双击即用，无需安装：

| 文件 | 适用系统 |
| --- | --- |
| `github520-1.0.0.exe` | 64 位（Windows 10/11 绝大多数设备） |
| `github520-1.0.0-x86.exe` | 32 位（老旧设备 / 32 位 Windows） |

系统要求：Windows 10 1809 及以上（需 WebView2 Runtime，Win11 自带；Win10 缺失时系统会提示安装）。

## 构建

依赖 Node.js 18+ 与 Rust 1.77+（MSVC 工具链）。

```bash
npm install
npm run build
# 产物：src-tauri/target/release/github520-tauri.exe
```

自检（真窗口 19 项断言）：

```bash
github520-tauri.exe --selftest
# 结果写入 %TEMP%\github520-selftest-report.txt，退出码非 0 表示有失败项
```

## 项目结构

```
frontend/      渲染层（无框架 HTML/CSS/JS）
tools/         window.api 桥接层源码（esbuild 打包为 frontend/tauri-api.js）
src-tauri/     Rust 主进程（hosts / sync / speed / store / system）
```

## 许可

[MIT](LICENSE)。IP 数据来自上游 [521xueweihan/GitHub520](https://github.com/521xueweihan/GitHub520)，仅供学习交流。
