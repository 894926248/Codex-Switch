# Windows 打包（对齐 cc-switch）

当前流程与 `cc-switch` 的 Windows 产物策略一致：

- 安装版：`MSI`
- 便携版：`Portable zip`（包含 `codex-switch.exe` + `portable.ini`）
- 产物输出目录：`release-assets`

## 本地打包

```powershell
npm run pack:win
```

## 一键发布产物整理

### 使用当前 `package.json` 版本号

```powershell
npm run release:win
```

### 指定版本标签（支持 `v0.2.0` 或 `0.2.0`）

```powershell
npm run release:win -- -VersionTag v0.2.0
```

## 产物命名

执行 `release:win` 后，会在 `release-assets/` 下生成：

- `Codex-Switch-v<version>-Windows.msi`
- `Codex-Switch-v<version>-Windows-Portable.zip`
- `Codex-Switch-v<version>-Windows.msi.sig`（如果构建时生成了签名）

## 说明

- MSI 安装器使用 `src-tauri/wix/per-user-main.wxs`（与 cc-switch 同款 per-user WiX 模板）。
- 便携版 zip 内会写入 `portable.ini`：
  - `portable=true`
- 当前默认未启用 updater 签名流程（未配置 `plugins.updater` 与签名私钥）；因此 `.sig` 仅在你后续接入签名后才会出现。
