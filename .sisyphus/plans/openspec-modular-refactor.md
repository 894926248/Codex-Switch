# OpenSpec Modular Refactor Plan

## Context

- Repository: `codex-switch`
- Hotspots (baseline LOC as of plan date):
  - `src-tauri/src/lib.rs`: ~13,700 LOC (mixed constants, models, paths, commands, IPC handlers)
  - `src/App.tsx`: ~4,798 LOC (mixed types, constants, utils, UI, state, integration)

## Goals

1. Reduce per-file LOC incrementally across phases toward final architecture caps.
2. Improve cohesion by grouping logic by domain.
3. Enforce unidirectional dependency via compile/lint gates.
4. Maintain zero behavioral change per change (verified by contract snapshot diff).

---

## LOC Target Model

**Two-tier system. Interim targets apply per change. Final caps apply only after all phases complete.**

| Tier | Applies When | Rust File | TSX File | CSS File |
|------|-------------|-----------|----------|----------|
| Interim (per-change gate) | After each change merges | Baseline minus extracted module LOC (verified by diff) | Baseline minus extracted module LOC | No change |
| Final (architecture cap) | After Phase 3+ completes | <= 800 LOC | <= 500 LOC | <= 600 LOC |

**Pass/fail for interim gate:** `lib.rs` LOC after change < `lib.rs` LOC before change. No absolute number required.

---

## Phase Outline

### Phase 1: Extract Rust leaf modules (Change 001)

Extract into separate files:
- `src-tauri/src/constants.rs` (all `const`/`static` declarations)
- `src-tauri/src/models.rs` (all `struct`/`enum` type definitions)
- `src-tauri/src/paths.rs` (all path-resolution helper functions)

Gate: `cargo check` passes; `lib.rs` LOC decreases; contract snapshot unchanged.

### Phase 2: Extract TSX leaf modules (Change 002)

Extract into separate files:
- `src/types.ts` (all TypeScript interfaces/types)
- `src/constants.ts` (all non-component `const` declarations)
- `src/utils.ts` (all pure utility functions)

Gate: `npm run build` passes; `App.tsx` LOC decreases; contract snapshot unchanged.

### Phase 3+: Domain split (future changes)

Split remaining command handlers and React components into domain modules. Final architecture caps enforced after this phase.

---

## Dependency Direction Rule

```
commands -> domain -> models -> util
```

- `commands` may import `domain`, `models`, `util`.
- `domain` may import `models`, `util`.
- `models` may import `util` only.
- `util` imports nothing from this project.
- Violations caught by: `cargo check` (Rust) + `tsc --noEmit` (TS) + hard layer-direction gate below.

### Hard Layer-Direction Gate (mandatory)

`cargo check`/`tsc` only ensure compilability; they do not guarantee layer direction. Run this gate and fail on any forbidden edge.

```bash
# Rust layer-direction checks (skip when folder is absent)
if [ -d src-tauri/src/domain ]; then ! grep -R "use crate::commands" src-tauri/src/domain; else true; fi
if [ -d src-tauri/src/models ]; then ! grep -R "use crate::\(commands\|domain\)" src-tauri/src/models; else true; fi
if [ -d src-tauri/src/util ]; then ! grep -R "use crate::\(commands\|domain\|models\)" src-tauri/src/util; else true; fi

# TS layer-direction checks (skip when folder is absent)
if [ -d src/domain ]; then ! grep -R "from ['\"]\./\./commands\|from ['\"]@/commands" src/domain; else true; fi
if [ -d src/models ]; then ! grep -R "from ['\"]\./\./\(commands\|domain\)\|from ['\"]@/\(commands\|domain\)" src/models; else true; fi
if [ -d src/util ]; then ! grep -R "from ['\"]\./\./\(commands\|domain\|models\)\|from ['\"]@/\(commands\|domain\|models\)" src/util; else true; fi
```

Pass: all commands return exit code 0 and no forbidden import lines are printed.
Fail: any command returns non-zero or prints a forbidden import.

---

## Contract Snapshot Protocol

Before any change starts, generate a contract snapshot:

```bash
# Rust: list all #[tauri::command] function names (stable set)
grep -rn "#\[tauri::command\]" src-tauri/src/*.rs | grep -oP "(?<=fn )\w+" | sort > .contract-snapshot-rust.txt

# TS: list all invoke() command names (stable set)
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-snapshot-ts.txt
```

After the change, run the same commands and diff:

```bash
grep -rn "#\[tauri::command\]" src-tauri/src/*.rs | grep -oP "(?<=fn )\w+" | sort > .contract-snapshot-rust-after.txt
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-snapshot-ts-after.txt
diff .contract-snapshot-rust.txt .contract-snapshot-rust-after.txt
diff .contract-snapshot-ts.txt .contract-snapshot-ts-after.txt
```

**Pass:** diff is empty (no additions, no deletions, no renames).
**Fail:** any diff line present. Block merge until resolved.

---

## Acceptance Gates (all must pass per change)

| Gate | Command | Pass Criterion |
|------|---------|---------------|
| Rust compile | `cd src-tauri && cargo check` | Exit code 0 |
| TS compile | `npm run build` (or `tsc --noEmit`) | Exit code 0 |
| LOC reduction (Change 001) | `wc -l src-tauri/src/lib.rs` | Lower than pre-change baseline |
| LOC reduction (Change 002) | `wc -l src/App.tsx` | Lower than pre-change baseline |
| Contract stability | diff of snapshots (see above) | Empty diff |
| Dep direction | `cargo check` produces no cycle errors | No `cycle detected` in output |
| Hard dep direction | Layer-direction grep checks | No forbidden import edges |
| Independent rollback | Revert commits for this change only, re-run compile gates | Both compile gates pass |

---

## Rollback Protocol (per change)

1. Identify the commit range for the change: `git log --oneline`.
2. Revert: `git revert <commit-hash> --no-edit` (or `git checkout <pre-change-sha> -- <files>`).
3. Verify: `cd src-tauri && cargo check` and `npm run build`.
4. Confirm: no other change's files were modified by the revert (`git diff HEAD~1 --name-only`).

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Contract drift (frontend invoke string vs backend handler name) | Contract snapshot diff gate blocks merge on any change |
| Import cycles introduced during extraction | `cargo check` catches Rust cycles; `tsc --noEmit` catches TS cycles |
| LOC gate impossible to meet in early phases | Two-tier LOC model: interim = relative decrease, final = absolute cap |
| Rollback breaks sibling change | Changes designed as independent leaf extractions; verified by rollback gate |
