#!/usr/bin/env node
/**
 * Repository-hosted Vitest reachability worker.
 *
 * The mutation CLI starts this file once per invocation, not once per mutated source
 * file. One Vitest context therefore owns one warmed Vite module graph while Vitest's
 * public `getRelevantTestSpecifications` API answers the still-separate related-test
 * query for every source. The per-source distinction is load-bearing: asking the CLI
 * for the union related to several sources cannot prove which declared test reaches
 * which mutation target.
 *
 * The worker writes its machine-readable result only after every query succeeds. Its
 * parent keeps the existing timeout/signal boundary around this whole process and
 * treats a missing report as a failed probe rather than as an empty related-test set.
 */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';

/**
 * @typedef {{
 *   version: 1,
 *   sourceCount: number,
 *   testSpecificationCount: number,
 *   durationMs: number,
 *   relatedByFile: Record<string, string[]>,
 * }} ReachabilityReport
 */

/** @param {string} path @returns {string} */
function slash(path) {
  return path.split('\\').join('/');
}

/**
 * Query Vitest for every source while retaining one context and module graph.
 * `createContext` is injectable only so the lifecycle and result-shape contract can
 * be tested without initializing another real Vite server in every unit case.
 *
 * @param {string[]} files
 * @param {string} root
 * @param {{
 *   createContext?: typeof createVitest,
 *   onProgress?: (message: string) => void,
 * }} [options]
 * @returns {Promise<ReachabilityReport>}
 */
export async function collectReachability(files, root, options = {}) {
  const createContext = options.createContext ?? createVitest;
  const onProgress = options.onProgress ?? (() => {});
  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0) {
    throw new Error('reachability collection requires at least one source file');
  }
  const started = performance.now();
  const vitest = await createContext('test', {
    root,
    watch: false,
    run: true,
    reporters: [],
  });

  try {
    const allSpecifications = await vitest.globTestSpecifications();
    onProgress(`discovered ${allSpecifications.length} test specification(s)`);

    /** @type {Record<string, string[]>} */
    const relatedByFile = Object.create(null);
    for (let i = 0; i < uniqueFiles.length; i++) {
      const file = uniqueFiles[i];
      // Vitest's resolved related paths are absolute. Updating this option between
      // public API queries preserves its own force-rerun, project and import-graph
      // semantics while the context's Vite transform cache stays warm.
      vitest.config.related = [resolve(root, file)];
      const specifications = await vitest.getRelevantTestSpecifications();
      relatedByFile[file] = [...new Set(
        specifications.map((specification) => slash(relative(root, specification.moduleId))),
      )].sort();
      onProgress(`mapped ${i + 1}/${uniqueFiles.length}: ${file}`);
    }

    return {
      version: 1,
      sourceCount: uniqueFiles.length,
      testSpecificationCount: allSpecifications.length,
      durationMs: Math.round(performance.now() - started),
      relatedByFile,
    };
  } finally {
    await vitest.close();
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ root: string | null, output: string | null, files: string[] }} */
  const args = { root: null, output: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i] ?? null;
    else if (argv[i] === '--output') args.output = argv[++i] ?? null;
    else if (argv[i] === '--') {
      args.files = argv.slice(i + 1);
      break;
    } else {
      throw new Error(`unknown reachability-worker argument: ${argv[i]}`);
    }
  }
  if (!args.root) throw new Error('reachability worker requires --root');
  if (!args.output) throw new Error('reachability worker requires --output');
  if (args.files.length === 0) throw new Error('reachability worker requires at least one source file after --');
  return /** @type {{ root: string, output: string, files: string[] }} */ (args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[reachability] building one Vitest graph for ${args.files.length} source file(s)`);
  const report = await collectReachability(args.files, args.root, {
    onProgress: (message) => console.log(`[reachability] ${message}`),
  });
  writeFileSync(args.output, JSON.stringify(report));
  console.log(
    `[reachability] complete: ${report.sourceCount} source file(s), ` +
    `${report.testSpecificationCount} test specification(s), ${(report.durationMs / 1000).toFixed(1)}s`,
  );
}

const entryArg = process.argv[1];
if (entryArg && existsSync(entryArg) && fileURLToPath(import.meta.url) === realpathSync(entryArg)) {
  main().catch((/** @type {any} */ error) => {
    console.error('[reachability] ERROR:', error?.message ?? error);
    process.exitCode = 1;
  });
}
