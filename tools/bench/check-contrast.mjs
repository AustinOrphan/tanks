#!/usr/bin/env node
/**
 * Checks that the `low` quality preset still costs clearly less than `high` (issue #738).
 *
 *   npm run bench:contrast -- <directory of tools/bench/runs.mjs reports>
 *
 * The rule, its threshold and where the threshold came from are in tools/bench/contrast.mjs. Needs
 * vite-node, as tools/devflags/generate.mjs does, because the schema version is read from
 * src/game/bench.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { runContrast } from './contrast.mjs';

process.exitCode = runContrast(process.argv.slice(2), console, {
  readdir: (dir) => readdirSync(dir),
  read: (path) => readFileSync(path, 'utf8'),
});
