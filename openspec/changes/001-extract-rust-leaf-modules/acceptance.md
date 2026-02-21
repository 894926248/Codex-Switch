# Acceptance: 001-extract-rust-leaf-modules

## Pre-Change Setup (run before touching any file)

```bash
# 1. Capture LOC baseline
wc -l src-tauri/src/lib.rs > .loc-baseline-001.txt
cat .loc-baseline-001.txt

# 2. Capture contract snapshot
grep -rn "#\[tauri::command\]" src-tauri/src/*.rs | grep -oP "(?<=fn )\w+" | sort > .contract-rust-before-001.txt
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-ts-before-001.txt
```

---

## Acceptance Gates

All gates must pass. Any single failure blocks merge.

### Gate 1: Rust compile

```bash
cd src-tauri && cargo check
```

**Pass:** exit code 0, zero errors, zero warnings that indicate structural issues.
**Fail:** any error in output.

### Gate 2: LOC reduction in lib.rs

```bash
wc -l src-tauri/src/lib.rs
```

**Pass:** result is strictly less than the value captured in `.loc-baseline-001.txt`.
**Fail:** result equals or exceeds baseline.

### Gate 3: Extracted files exist and compile

```bash
# Base extracted files must exist
ls src-tauri/src/constants.rs
ls src-tauri/src/models.rs
ls src-tauri/src/paths.rs

# Runtime aggregator and split files must exist
ls src-tauri/src/domain/runtime_core.rs
ls src-tauri/src/domain/runtime_core.inc
ls src-tauri/src/domain/runtime_ops.inc
ls src-tauri/src/domain/runtime_mcp.inc
ls src-tauri/src/domain/runtime_autoswitch.inc
```

**Pass:** all three files exist and `cargo check` (Gate 1) passes.
**Fail:** any file missing or compile fails.

### Gate 4: Contract snapshot unchanged (no command renames or deletions)

```bash
grep -rn "#\[tauri::command\]" src-tauri/src/**/*.rs | grep -oP "(?<=fn )\w+" | sort > .contract-rust-after-001.txt
diff .contract-rust-before-001.txt .contract-rust-after-001.txt

grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-ts-after-001.txt
diff .contract-ts-before-001.txt .contract-ts-after-001.txt
```

**Pass:** both diffs produce no output.
**Fail:** any diff line present (added, removed, or changed command name).

### Gate 5: lib.rs delegates to runtime orchestrator

```bash
grep -n "domain::runtime_core::run" src-tauri/src/lib.rs
```

**Pass:** `lib.rs` 仅保留入口委托，不再承载业务实现。
**Fail:** `lib.rs` 仍包含大段业务逻辑或委托缺失。

---

## Rollback Checklist

Run this sequence to fully roll back Change 001 without affecting any other change.

```bash
# Step 1: Identify commits for this change
git log --oneline src-tauri/src/constants.rs src-tauri/src/models.rs src-tauri/src/paths.rs

# Step 2: Revert (use actual commit hash from step 1)
git revert <commit-hash> --no-edit

# Step 3: Verify only this change's files were touched
git diff HEAD~1 --name-only
# Expected: only this change touched rust runtime split files

# Step 4: Compile gate must pass after rollback
cd src-tauri && cargo check

# Step 5: Confirm lib.rs LOC returned to baseline
wc -l src-tauri/src/lib.rs
cat .loc-baseline-001.txt
# Values should match (within ±5 for whitespace differences)
```

**Rollback pass:** compile succeeds, no sibling change files appear in `git diff --name-only`.
