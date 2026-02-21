# Change: extract-tsx-leaf-modules

## Goal
- 从前端主页面中抽离类型/常量/工具与页面壳层，降低单文件体积并提升内聚。

## Scope
- 创建并迁移到：`src/types.ts`、`src/constants.ts`、`src/utils.ts`。
- 页面壳层改造：`src/App.tsx` 作为入口转发，主页面编排迁移到入口委托文件（当前为 `src/AppRuntime.js`）。
- 样式壳层改造：`src/App.css` 作为入口导入，主样式迁移到 `src/App.styles.css`。

## Out of Scope
- 不改 Tauri 调用命令名。

## Target Boundaries
- `types.ts`: 业务接口与类型别名。
- `constants.ts`: 存储 key、固定配置项、静态映射。
- `utils.ts`: 纯函数（格式化、映射、计算、无副作用）。
- `App.tsx`: 入口转发层（薄文件）。
- `AppRuntime.js`: 页面编排与交互主逻辑（由 `App.tsx` 入口委托）。

## Success Criteria
- `npm run build` 通过。
- `App.tsx` 行数显著下降并成为薄入口。
- 入口委托文件承接原页面行为，`App.tsx` 仅保留薄入口职责。
- 运行行为无变化。
