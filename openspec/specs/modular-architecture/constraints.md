# Constraints: modular-architecture

## LOC Caps (Two-Tier)

Final architecture caps apply **only after Phase 3+ is complete**. Do not use these as per-change gates in Phase 1 or 2.

| Scope | Final Cap | Interim Gate (Phase 1-2) |
|-------|-----------|--------------------------|
| Rust source file | <= 800 LOC | File LOC must decrease vs pre-change baseline |
| TSX source file | <= 500 LOC | File LOC must decrease vs pre-change baseline |
| CSS file | <= 600 LOC | No interim requirement |
| Rust function | <= 80 LOC | No interim requirement |
| TS/TSX function | <= 60 LOC | No interim requirement |
| `useState` per component | <= 12 | No interim requirement |

**Enforcement command (interim gate):**
```bash
# Before change
wc -l src-tauri/src/lib.rs > .loc-baseline-rust.txt
wc -l src/App.tsx > .loc-baseline-tsx.txt

# After change - verify decrease
wc -l src-tauri/src/lib.rs  # must be < value in .loc-baseline-rust.txt
wc -l src/App.tsx            # must be < value in .loc-baseline-tsx.txt
```

**Enforcement command (final gate, Phase 3+ only):**
```bash
find src-tauri/src -name "*.rs" -exec wc -l {} + | awk '$1 > 800 {print "FAIL:", $0}'
find src -name "*.tsx" -exec wc -l {} + | awk '$1 > 500 {print "FAIL:", $0}'
find src -name "*.css" -exec wc -l {} + | awk '$1 > 600 {print "FAIL:", $0}'
```
Empty output = pass.

---

## Dependency Direction

Allowed import chain: `commands -> domain -> models -> util`

Rules:
- `util` modules import nothing from this project.
- `models` modules import only `util`.
- `domain` modules import `models` and `util`.
- `commands` modules import `domain`, `models`, and `util`.
- `commands` is never imported by `domain`, `models`, or `util`.

**Rust compile/cycle enforcement:** `cargo check` fails on circular dependencies (`cycle detected`).

**TS compile/cycle enforcement:** `tsc --noEmit` catches type-level import errors. For circular detection, use:
```bash
npx madge --circular src/
```
Pass: output is empty.

**Hard direction enforcement (mandatory, not optional):**
```bash
# Rust: forbidden reverse edges (skip when folder is absent)
if [ -d src-tauri/src/domain ]; then ! grep -R "use crate::commands" src-tauri/src/domain; else true; fi
if [ -d src-tauri/src/models ]; then ! grep -R "use crate::\(commands\|domain\)" src-tauri/src/models; else true; fi
if [ -d src-tauri/src/util ]; then ! grep -R "use crate::\(commands\|domain\|models\)" src-tauri/src/util; else true; fi

# TS: forbidden reverse edges (skip when folder is absent)
if [ -d src/domain ]; then ! grep -R "from ['\"]\./\./commands\|from ['\"]@/commands" src/domain; else true; fi
if [ -d src/models ]; then ! grep -R "from ['\"]\./\./\(commands\|domain\)\|from ['\"]@/\(commands\|domain\)" src/models; else true; fi
if [ -d src/util ]; then ! grep -R "from ['\"]\./\./\(commands\|domain\|models\)\|from ['\"]@/\(commands\|domain\|models\)" src/util; else true; fi
```

Pass: all checks return exit code 0 and print no forbidden import lines.
Fail: any check returns non-zero or prints forbidden edges.

---

## Contract Rules

Frontend `invoke()` call strings must match backend `#[tauri::command]` function names exactly.

**Snapshot generation (run before every change):**
```bash
grep -n "#\[tauri::command\]" src-tauri/src/*.rs | grep -oP "(?<=fn )\w+" | sort > .contract-rust.txt
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-ts.txt
```

**Diff gate (run after every change):**
```bash
grep -n "#\[tauri::command\]" src-tauri/src/*.rs | grep -oP "(?<=fn )\w+" | sort > .contract-rust-after.txt
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-ts-after.txt
diff .contract-rust.txt .contract-rust-after.txt
diff .contract-ts.txt .contract-ts-after.txt
```

**Pass:** both diffs produce no output.
**Fail:** any diff output present. Block merge until contracts are re-aligned.

---

## Compile Gates (per change, non-negotiable)

| Gate | Command | Pass Criterion |
|------|---------|----------------|
| Rust compile | `cd src-tauri && cargo check` | Exit code 0, zero errors |
| TS/frontend compile | `npm run build` | Exit code 0, zero errors |

These gates apply to **every change** regardless of phase.

---

## Rollback Constraint

Each change must be independently rollbackable without affecting any other change's files.

**Verification (run after reverting a change):**
```bash
# 1. Revert only this change's commits
git revert <change-commit-hash> --no-edit

# 2. Confirm no sibling files touched
git diff HEAD~1 --name-only

# 3. Re-run compile gates
cd src-tauri && cargo check
npm run build
```

Pass: both compile gates pass and `git diff --name-only` shows only this change's files.
