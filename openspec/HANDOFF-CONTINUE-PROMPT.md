# Handoff Prompt (OpenSpec + Sisyphus)

## Goal

完成 OpenSpec + Sisyphus 流程下的最终收口：保持高内聚低耦合、单文件 LOC 受控、契约稳定、门禁可复验、看板可持续更新。

## Instructions

- 严格遵守 OpenSpec 规范与 Sisyphus 多模型协作/自审流程。
- 不中断执行；仅在确实无法安全决策时再提一个澄清问题。
- 以文件看板作为唯一长期状态面板，所有进展必须落盘。
- 优先保持最小改动，不做无关重构。

## Discoveries

- 当前技术门禁已通过：`cargo check`、`npx tsc --noEmit`、`npm run build`。
- 契约证据闭环已完成：Rust command 与 TS invoke before/after diff 均为空。
- LOC 阈值证据已完成：最大文件 Rust=493、TSX=329、CSS=434。
- 看板已新增“终审与收口记录”，状态为可交接/可封板。

## Accomplished

- 已完成：
  - 证据补齐（contract before/after/diff + loc-threshold-report）。
  - 最终门禁复验与看板同步。
  - 终审与收口记录追加。
- 进行中：
  - 无。
- 剩余：
  - 可选执行提交封板（仅在用户明确要求 commit 时执行）。
  - 如有新增需求，按 Change/Gate 模式增量推进。

## Relevant files / directories

- `openspec/PROGRESS-TASKBOARD.md`
- `openspec/HANDOFF-CONTINUE-PROMPT.md`
- `openspec/evidence/capture_contracts.py`
- `openspec/evidence/contract-rust-before-final.txt`
- `openspec/evidence/contract-rust-after-final.txt`
- `openspec/evidence/contract-rust-diff.txt`
- `openspec/evidence/contract-ts-before-final.txt`
- `openspec/evidence/contract-ts-after-final.txt`
- `openspec/evidence/contract-ts-diff.txt`
- `openspec/evidence/loc-threshold-report.json`

## Next agent startup command (copy-and-run intent)

请先阅读 `openspec/PROGRESS-TASKBOARD.md` 与 `openspec/HANDOFF-CONTINUE-PROMPT.md`，然后：

1. 若用户要求“继续执行”：只做增量任务并同步看板。
2. 若用户要求“交付封板”：先汇总变更，再按用户明确指令执行 git commit。
3. 若用户提出新重构：先生成 OpenSpec change + gate，再实施。
