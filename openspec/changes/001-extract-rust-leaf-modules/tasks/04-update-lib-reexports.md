# Task 04: Update `lib.rs` as orchestrator

## Action
- 将 `lib.rs` 收敛为薄入口：委托到 `domain::runtime_core::run()`。
- 运行时主体通过 `domain/runtime_core.rs` + `runtime_*.inc` 进行装配。

## Rules
- 不改 `#[tauri::command]` 列表。
- 不改 `run()` 装配行为。

## Done When
- `lib.rs` 保持可编译并成为薄入口（不再承载业务实现）。
- 功能行为无变化。
