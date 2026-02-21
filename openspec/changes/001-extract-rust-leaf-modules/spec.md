# Change: extract-rust-leaf-modules

## Goal
- 将 Rust 运行时从单体入口迁移为“薄入口 + 领域分片 include”的结构。
- 在不改变命令契约与运行行为的前提下，降低主文件职责密度。

## Scope
- 保留并使用叶子模块：`constants.rs`、`models.rs`、`paths.rs`。
- `src-tauri/src/lib.rs` 收敛为入口委托（调用 `domain::runtime_core::run()`）。
- 运行时逻辑按职责拆到 `src-tauri/src/domain/runtime_*.inc`。

## Out of Scope
- 不改 `#[tauri::command]` 名称与对外契约。
- 不改前端 `invoke()` 调用字符串。
- 不引入新第三方依赖。

## Target Boundaries
- `lib.rs`: 仅入口委托，不承载业务逻辑。
- `runtime_core.rs`: 作为运行时聚合入口，`include!` 组合分片。
- `runtime_*.inc`: 按功能域拆分（ops/mcp/autoswitch/auth/dashboard/editor 等）。

## Success Criteria
- `cargo check` 通过。
- `src-tauri/src/lib.rs` 显著下降并维持薄入口（当前目标：双位数行数）。
- 运行时主文件不再集中于单个超大实现文件。
- 无命令名变更、无对外接口变更。
