# Codex Switch

`Codex Switch` 是一个基于 **Tauri + React + TypeScript + Rust** 的桌面工具，用于切换 VS Code / Codex 使用的 OpenAI 账号快照，并查看每个工作空间的额度状态。

## 已实现功能

- 网页登录添加账号（`codex login` 流程）
- 手动输入工作空间名（添加时必填），并支持后续改名
- 账号卡片视图（类似 CC Switch 风格）
- 一键切换到选中账号
- 显示 5 小时 / 1 周剩余额度与重置时间
- 显示账号状态（正常 / 已失效 / 当前生效）
- 刷新选中或全部额度
- 手动保活（全账号刷新 token）
- 自动保活（默认 48h，带错峰随机抖动）
- 一键触发 `Developer: Reload Window`

## 本地运行

```bash
cd codex-switch
npm install
npm run tauri dev
```

## 构建

```bash
cd codex-switch
npm run build
```

Rust 侧也可以单独检查：

```bash
cd codex-switch/src-tauri
cargo check
```

## 数据目录

- 读取当前 Codex 登录：`~/.codex`
- 管理账号快照：`~/.codex_account_switcher`

不会改动你的项目数据目录，核心是切换 `auth.json`/`cap_sid` 等账号登录态相关内容。
