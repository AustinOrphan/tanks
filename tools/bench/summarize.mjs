#!/usr/bin/env node
/**
 * Compares benchmark reports taken on one device in one sitting (issue #737).
 *
 *   npm run bench:summarize -- <baseline report.json> [more reports.json ...]
 *
 * The first report named is the baseline arm's. The logic, and what is refused, is in
 * tools/bench/summary.mjs; the procedure that produces the reports is
 * docs/superpowers/plans/2026-09-14-device-benchmark-procedure.md.
 *
 * Needs vite-node (not plain node) for the reason tools/devflags/generate.mjs gives: the schema
 * version is read from src/game/bench.ts, whose own imports are extensionless.
 */
import { readFileSync } from 'node:fs';
import { runSummarize } from './summary.mjs';

process.exitCode = runSummarize(process.argv.slice(2), console, (path) => readFileSync(path, 'utf8'));
