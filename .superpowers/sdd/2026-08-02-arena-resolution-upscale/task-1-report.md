# Task 1 Report: Capture the baseline

## Test Results

**Full test suite:**
```
 Test Files  [1m[32m68 passed[39m[22m[2m | [22m[33m1 skipped[39m[90m (69)[39m
      Tests [1m[32m1218 passed[39m[22m[2m | [22m[33m1 skipped[39m[90m (1219)[39m
```

**Pacifist suite:**
```
      Tests [1m[32m4 passed[39m[22m[90m (4)[39m
```

## Baseline Trace Fingerprint

**Complete 64-character hash:**
```
178963a527144a4da1a9faa7b7058d758720010ca82be8d94470bee2f338ad5b
```

## Per-Arena Geometry

| id | cols | rows | cellSize | claims |
|----|------|------|----------|--------|
| arena-01 | 11 | 9 | 2 | 1 |
| arena-02 | 11 | 9 | 2 | 4 |
| arena-03 | 11 | 9 | 2 | 8 |
| arena-04 | 15 | 11 | 2 | 14 |

## Cover-Ratio: Derived from Arena Validation Expected Values

**Source:** The EXPECTED table in `src/sim/arena-validation.test.ts` (lines 207-212), which defines the baseline unseen/open cell counts for each arena. The cover-ratio for each arena is computed as unseen ÷ open (divisions computed by hand):

```
arena-01: 35/86 = 0.406977
arena-02: 41/83 = 0.493976
arena-03: 30/88 = 0.340909
arena-04: 35/151 = 0.231788
```

## Probe File Location and Commit

**File path:** `tools/baseline/trace.test.ts`

**Commit SHA:** `717846a`

---

## Fix Report (addressing review finding)

**Change made:** Relabeled "Cover-Ratio Output" to "Cover-Ratio: Derived from Arena Validation Expected Values" and added explicit documentation that these ratios are computed by hand from the hardcoded EXPECTED table in the test file, not extracted from command output.

**Verification command:**
```bash
grep -A 6 "const EXPECTED:" src/sim/arena-validation.test.ts
```

**Verification output:**
```
  const EXPECTED: Record<string, { unseen: number; open: number }> = {
    'arena-01': { unseen: 35, open: 86 },
    'arena-02': { unseen: 41, open: 83 },
    'arena-03': { unseen: 30, open: 88 },
    'arena-04': { unseen: 35, open: 151 },
  };
```

These EXPECTED values confirm the source data is still in place; the ratios derive from dividing unseen by open for each arena.
