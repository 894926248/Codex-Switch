# Spec: modular-architecture

## Objective
- 通过分层与边界约束，将项目从“上帝文件集中”演进为“高内聚、低耦合”的模块结构。

## Architectural Principles
- 单一职责：模块只负责一个业务域。
- 依赖单向：`commands -> domain -> models -> util`。
- 边界显式：跨模块交互通过稳定接口，不做隐式共享。

## Hotspot Targets
- `src-tauri/src/lib.rs`：从超大文件降为命令装配入口。
- `src/App.tsx`：从全栈 UI 逻辑降为页面编排入口。

## Expected End State
- 命令层与业务域分离。
- 前端 state/hook/view 解耦。
- 修改任一域时，影响面可控且可预测。
