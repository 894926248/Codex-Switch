# Task 02: Create `src-tauri/src/models.rs`

## Action
- 将 `lib.rs` 中数据模型 (`struct` / `enum`) 提取到 `models.rs`。

## Rules
- 保持 `serde` 字段命名与序列化行为一致。
- 不改变字段含义和可见性策略（除非为编译所必需）。

## Done When
- 命令层仍能正常使用所有模型。
- 编译通过，接口 JSON 形状不变。
