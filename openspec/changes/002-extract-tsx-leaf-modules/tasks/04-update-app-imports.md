# Task 04: Update `src/App.tsx` imports

## Action
- 将 `src/App.tsx` 调整为入口壳层，统一转发到入口委托文件（当前为 `src/AppRuntime.js`）。
- 在入口委托文件中统一保持类型、常量、工具函数导入路径稳定。

## Rules
- 不改 JSX 输出。
- 不改 hooks 调用顺序。

## Done When
- `App.tsx` 只保留入口转发。
- 入口委托文件承载状态与编排逻辑。
- 构建通过。
