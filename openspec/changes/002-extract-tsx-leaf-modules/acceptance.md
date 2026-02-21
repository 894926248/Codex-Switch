# Acceptance: 002-extract-tsx-leaf-modules

## Pre-Change Setup (run before touching any file)

```bash
# 1. Capture LOC baseline
wc -l src/App.tsx > .loc-baseline-002.txt
cat .loc-baseline-002.txt

# 2. Capture contract snapshot (invoke call sites)
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-ts-before-002.txt
```

Note: Change 002 does not touch Rust. No Rust contract snapshot needed.

---

## Acceptance Gates

All gates must pass. Any single failure blocks merge.

### Gate 1: Frontend build

```bash
npm run build
```

**Pass:** exit code 0, zero errors.
**Fail:** any error in output.

### Gate 2: TypeScript strict compile

```bash
npx tsc --noEmit
```

**Pass:** exit code 0, no type errors.
**Fail:** any error.

### Gate 3: LOC reduction in App.tsx shell

```bash
wc -l src/App.tsx
```

**Pass:** result is strictly less than the value captured in `.loc-baseline-002.txt`，且 `App.tsx` 为薄入口。
**Fail:** result equals or exceeds baseline.

### Gate 4: Extracted files exist

```bash
ls src/types.ts
ls src/constants.ts
ls src/utils.ts
ls src/AppRuntime.js
ls src/App.styles.css
```

**Pass:** all three files exist and Gate 1 passes.
**Fail:** any file missing or build fails.

### Gate 5: No circular TS imports introduced

```bash
npx madge --circular src/
```

**Pass:** output is empty (no cycles found).
**Fail:** any cycle listed.

### Gate 6: Contract snapshot unchanged (no invoke renames or deletions)

```bash
grep -rn "invoke(" src/ | grep -oP "(?<=invoke\(['\"])\w+" | sort > .contract-ts-after-002.txt
diff .contract-ts-before-002.txt .contract-ts-after-002.txt
```

**Pass:** diff produces no output.
**Fail:** any diff line present.

### Gate 7: App.tsx 委托主编排入口

```bash
grep -n "AppRuntime" src/App.tsx
grep -n "from.*types" src/AppRuntime.js
grep -n "from.*constants" src/AppRuntime.js
grep -n "from.*utils" src/AppRuntime.js
```

**Pass:** `App.tsx` 作为入口壳层，主编排在入口委托文件中并使用抽离模块。
**Fail:** `App.tsx` 仍承载主逻辑，或抽离符号仍大量内联在壳层文件。

---

## Rollback Checklist

Run this sequence to fully roll back Change 002 without affecting Change 001 or any Rust files.

```bash
# Step 1: Identify commits for this change
git log --oneline src/types.ts src/constants.ts src/utils.ts src/App.tsx

# Step 2: Revert (use actual commit hash from step 1)
git revert <commit-hash> --no-edit

# Step 3: Verify only this change's files were touched (no Rust files)
git diff HEAD~1 --name-only
# Expected: only src/App.tsx, src/types.ts, src/constants.ts, src/utils.ts

# Step 4: Build gate must pass after rollback
npm run build

# Step 5: Confirm App.tsx LOC returned to baseline
wc -l src/App.tsx
cat .loc-baseline-002.txt
# Values should match (within ±5 for whitespace differences)

# Step 6: Confirm Rust side is untouched
cd src-tauri && cargo check
```

**Rollback pass:** both compile gates pass, no Rust files appear in `git diff --name-only`.
