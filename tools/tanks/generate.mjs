#!/usr/bin/env node
/**
 * Regenerates the marked enemy-roster block in README.md from the validated
 * tank definitions and AI profiles.
 *
 *   npm run tanks:doc
 *
 * Run through vite-node so the generator shares the same TypeScript module
 * resolution as the game and tools/tanks/doc.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { replaceEnemyRoster } from './render';

const README = fileURLToPath(new URL('../../README.md', import.meta.url));
const before = readFileSync(README, 'utf8');
const next = replaceEnemyRoster(before);

if (before !== next) {
  writeFileSync(README, next, 'utf8');
}

const after = readFileSync(README, 'utf8');
if (after !== next) {
  console.error('wrote README.md but the read-back does not match the generated roster');
  process.exit(1);
}

console.log(
  before === next
    ? `README.md enemy roster already up to date (${next.length} bytes)`
    : `updated README.md enemy roster (${next.length} bytes, was ${before.length} bytes)`,
);
