/**
 * `LICENSE` and `THIRD-PARTY-NOTICES.md` are read by nothing in the build, nothing in the
 * bundle and nothing in any other test. That is the `hud.css` class exactly: a file whose
 * every failure mode is silent. A notices file can go stale the moment a dependency is
 * bumped, and the failure is not a red build -- it is a legally wrong document that still
 * looks generated, which is worse than not having one.
 *
 * So this file does three separable jobs, and each case below says which:
 *
 *   1. REGENERATE AND COMPARE. The committed notices file must be byte-identical to what
 *      the generator produces from the tree that is installed right now. A dependency
 *      added, removed or bumped without `npm run notices` fails here.
 *   2. CHECK THE CONTENT, not just the round trip. (1) alone would pass on a generator
 *      that emitted an empty file against an empty committed file -- so the licence text
 *      is also asserted against `node_modules` directly, and the package set against
 *      `npm ls`, which is an authority this code does not share.
 *   3. NEGATIVE CONTROLS for the filters. The real tree has no `devOptional`, `link` or
 *      `extraneous` entry and no package missing a licence file, so those branches are
 *      exercised against synthetic lockfiles in a temp directory. Without them the filters
 *      would be untested code guarding a legal artifact.
 *
 * MUTATIONS RUN. Every one of the 16 cases here was proved to fail by at least one of
 * these, and each mutation was applied to an otherwise clean tree, measured with
 * `npx vitest run tools/notices`, and restored (`git status` empty, verified between
 * runs). Counts are failed TESTS out of 16.
 *
 *   1. `THIRD-PARTY-NOTICES.md`: `## three 0.169.0` -> `## three 0.170.0`  -> 2 failed
 *      (the round trip; the package-set check, which compares headings).
 *   2. `THIRD-PARTY-NOTICES.md`: three's whole section deleted  -> 3 failed (those two,
 *      plus the verbatim-licence-text check).
 *   3. `THIRD-PARTY-NOTICES.md`: a `## vite 8.1.5` heading appended by hand  -> 3 failed
 *      (the round trip, the package set, the build-time-dependency exclusion). Mutation 8
 *      below is why this one had to be written by hand.
 *   4. `THIRD-PARTY-NOTICES.md`: truncated to zero bytes  -> 5 failed, and the vacuity
 *      case is the FIRST of them, which is the whole reason it is there.
 *   5. `package.json`: the `notices` script deleted  -> 1 failed (the documented-command
 *      case; the banner would otherwise name a command that does not exist).
 *   6. `package.json`: `"license": "UNLICENSED"` -> `"MIT"`  -> 1 failed (agreement).
 *   7. `LICENSE`: replaced with three's MIT text  -> 2 failed (agreement, from the other
 *      side; and the copyright/disclaimer case, since `Copyright ©` is not `Copyright (c)`).
 *   8. `notices.mjs`: `if (meta.dev) continue;` deleted  -> 5 failed (round trip, npm
 *      cross-check, verbatim text, determinism, synthetic-lockfile control). Then the same
 *      mutation WITH a regeneration: still 5, and the notices file did not change at all,
 *      because the generator refused -- of the 191 non-root lockfile entries, 83 are not
 *      installed on this platform (optional native binaries for other OS/arch) and 5 more
 *      ship no licence file, so `buildNotices` returned 88 failures and wrote nothing.
 *      (Recounted directly, not read off the mutation's console output.) The guards
 *      compose: losing the
 *      scope filter cannot produce a plausible-looking wrong file, only a refusal.
 *   9. `notices.mjs`: `fenceFor` returns a literal '```'  -> 1 failed (the backtick case).
 *      Neither shipped licence contains a backtick, so nothing else moved -- which is why
 *      that case is written against a synthetic entry rather than against the real tree.
 *  10. `notices.mjs`: the `!licence` branch made a silent `continue`  -> 1 failed
 *      (the missing-licence control).
 *  11. `notices.mjs`: the `packages`-map guard replaced with `lock.packages ?? {}`
 *      -> 1 failed (the v1-lockfile control).
 *  12. `notices.mjs`: `'licence.md'` dropped from `LICENCE_FILENAMES`  -> 1 failed
 *      (the filename-lookup case). Note it does NOT move the real tree: howler ships
 *      `LICENSE.md`, which is still matched.
 *  13. `notices.mjs`: the not-installed guard disabled  -> 1 failed (that control).
 *  14. `notices.mjs`: the empty-file guard disabled  -> 1 failed (that control).
 *  15. `notices.mjs`: `renderNotices` stamps `new Date().toISOString()`  -> 2 failed
 *      (determinism, and the round trip).
 *  16. `backlog.md`: `162 MIT` -> `163 MIT`  -> 1 failed (the census case).
 *  17. `backlog.md`: `All 12 MPL-2.0 entries` -> `All 11 ...`  -> 1 failed (the MPL case).
 *
 * Population: 17 mutations, hand-picked -- at least one per case here, plus the two
 * composite ones (4 and 8). This is not a sweep of possible edits to these files.
 * Mutations 16 and 17 were measured after the census cases were added, so their
 * denominator is 18 tests; 1-15 were measured against 16.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs, deliberately dependency-free (it is also the CLI that
// writes the file it checks). `tools/` is typechecked by nothing, so this import carries
// no types either way.
import {
  productionEntries,
  readLicenceFile,
  renderNotices,
  buildNotices,
  collect,
  GENERATED_BANNER,
  NOTICES_PATH,
} from './notices.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const repo = (p: string): string => join(root, p);

const noticesText: string = readFileSync(repo(NOTICES_PATH), 'utf8');
const licenseText: string = readFileSync(repo('LICENSE'), 'utf8');
const pkg = JSON.parse(readFileSync(repo('package.json'), 'utf8')) as {
  license?: string;
  scripts: Record<string, string>;
};

interface Entry {
  name: string;
  version: string;
  licence: string;
  licenceFile: string;
  text: string;
}

/** `## name version` headings, which is the notices file's own index of what it covers. */
function headings(md: string): string[] {
  return [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
}

/** A throwaway repo root, so the filter branches the real tree never hits are testable. */
function scratch(lock: unknown, packages: Record<string, { pkg?: unknown; licence?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'tanks-notices-'));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  for (const [rel, spec] of Object.entries(packages)) {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), JSON.stringify(spec.pkg ?? {}));
    if (spec.licence !== undefined) writeFileSync(join(dir, rel, 'LICENSE'), spec.licence);
  }
  return dir;
}

describe('the third-party notices file', () => {
  it('loaded something at all', () => {
    // Without this, every assertion below is satisfied by an empty read -- which is not
    // hypothetical here: the generator's whole job is to write this file, so "" is exactly
    // what a broken generator produces, and `toContain` on "" fails while `not.toContain`
    // passes. Two of the cases below are negative. Guard them.
    expect(noticesText.length).toBeGreaterThan(1000);
    expect(licenseText.length).toBeGreaterThan(400);
    expect(noticesText).toContain(GENERATED_BANNER);
    expect(headings(noticesText).length).toBeGreaterThan(0);
  });

  it('regenerating from the installed tree reproduces the committed file, byte for byte', () => {
    // The staleness gate, and the reason this issue is worth closing with a test rather
    // than a file. A dependency bump changes `## three 0.169.0`; an added dependency adds a
    // section; a removed one drops it. All three are silent everywhere else in the gate.
    //
    // This needs node_modules to be installed, which `npm ci` guarantees in CI and which
    // the failure message names, because "the file is out of date" is a confusing thing to
    // read when the real problem is that nothing is installed.
    const { text, failures } = buildNotices(root) as { text: string | null; failures: string[] };
    expect(failures, 'the generator refused to build -- is node_modules installed?').toEqual([]);
    expect(text).not.toBeNull();
    expect(text).toBe(noticesText);
  });

  it('covers exactly the packages npm itself calls production, which this code never asks', () => {
    // The cross-check that makes the round trip mean something. `productionEntries` reads
    // the lockfile's `dev:` markers; `npm ls --omit=dev` applies npm's own classification
    // to the installed tree. If the two ever disagree -- a devOptional package, a peer
    // dependency promoted, a change in how npm marks entries -- this says so, where a
    // round trip against a file this same code generated could not.
    //
    // stdout is read even on a non-zero exit: `npm ls` exits 1 for an unrelated tree
    // problem (an `npm i --no-save` leaves an extraneous package, which CI's visual job
    // does) while still printing the JSON. The parse and the non-empty assertion are what
    // stop that leniency turning into a vacuous pass.
    let out = '';
    try {
      out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? '';
    }
    expect(out.length, '`npm ls` produced no output at all').toBeGreaterThan(2);
    const tree = JSON.parse(out) as {
      dependencies?: Record<string, { version: string; dependencies?: object }>;
    };
    const fromNpm = new Set<string>();
    (function walk(node: { dependencies?: Record<string, { version: string }> }) {
      for (const [name, meta] of Object.entries(node.dependencies ?? {})) {
        fromNpm.add(`${name} ${meta.version}`);
        walk(meta as { dependencies?: Record<string, { version: string }> });
      }
    })(tree);
    expect(fromNpm.size, '`npm ls --omit=dev` listed nothing').toBeGreaterThan(0);

    const lock = JSON.parse(readFileSync(repo('package-lock.json'), 'utf8'));
    const fromLock = new Set(
      (productionEntries(lock) as Entry[]).map((e) => `${e.name} ${e.version}`),
    );
    expect([...fromLock].sort()).toEqual([...fromNpm].sort());
    // And the file agrees with both. Population: every heading in the notices file, and
    // every package in npm's production closure -- 2 of 2 today, out of the 191 non-root
    // entries the lockfile carries.
    expect(headings(noticesText).sort()).toEqual([...fromNpm].sort());
  });

  it('reproduces each licence text verbatim from the package that ships it', () => {
    // Read straight from node_modules, not through the generator. This is what the MIT
    // obligation actually is -- "the above copyright notice and this permission notice
    // shall be included" -- so a renderer that emitted headings and dropped the bodies, or
    // that reflowed them, must fail here even though the round trip above would pass.
    const { entries, failures } = collect(root) as { entries: Entry[]; failures: string[] };
    expect(failures).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const onDisk = readFileSync(repo(e.licenceFile), 'utf8').replace(/\r\n/g, '\n').trim();
      expect(onDisk.length, `${e.licenceFile} is empty`).toBeGreaterThan(200);
      expect(noticesText, `${e.name}'s licence text is not reproduced`).toContain(onDisk);
      // A copyright LINE and a permission grant, separately: a file containing only the
      // warranty disclaimer would satisfy neither, and is the shape a truncated read gives.
      expect(onDisk, `${e.name}'s licence carries no copyright line`).toMatch(
        /copyright\s+(\(c\)|©)/i,
      );
      expect(onDisk, `${e.name}'s licence grants nothing`).toContain(
        'Permission is hereby granted',
      );
    }
  });

  it('lists no build-time dependency, which is what limits its scope to what ships', () => {
    // The scope claim, from the other direction. `vite` and `typescript` are named in the
    // file's own prose explaining why they are absent, so this matches HEADINGS rather than
    // the text -- a substring check would pass on a file that listed them and also
    // explained they were excluded.
    //
    // Population: the four direct devDependencies plus jsdom, checked against the headings.
    // NOT their transitive trees -- that is what the npm cross-check above covers, by set
    // equality rather than by naming names.
    const names = headings(noticesText).map((h) => h.replace(/ [^ ]+$/, ''));
    for (const dev of ['vite', 'vitest', 'typescript', 'jsdom', '@types/three']) {
      expect(names, `${dev} is a build-time dependency and does not ship`).not.toContain(dev);
    }
    expect(names.length).toBeGreaterThan(0);
  });

  it('is regenerable by a documented command', () => {
    // The banner tells a reader not to hand-edit; this pins that the command it names is
    // real. Deleting the script leaves the banner giving instructions that fail.
    expect(GENERATED_BANNER).toContain('npm run notices');
    expect(pkg.scripts.notices).toBe('node tools/notices/notices.mjs');
  });

  it('is deterministic, so a regeneration is a diff and not a timestamp', () => {
    // A generator that stamped the date would make `--check` permanently red and every
    // regeneration a noisy diff. Two builds, same bytes.
    const a = (buildNotices(root) as { text: string }).text;
    const b = (buildNotices(root) as { text: string }).text;
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('the generator filters what ships, proved against a synthetic tree', () => {
  // The real lockfile has 189 plain-dev and 2 plain-production entries and zero of
  // everything else, so every branch except those two is unreachable from the repo. These
  // build the missing states.
  const LOCK = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'root' },
      'node_modules/ships': { version: '1.0.0', license: 'MIT' },
      'node_modules/devonly': { version: '2.0.0', license: 'MIT', dev: true },
      'node_modules/devoptional': { version: '3.0.0', license: 'MIT', devOptional: true },
      'node_modules/gone': { version: '4.0.0', license: 'MIT', extraneous: true },
      'node_modules/linked': { version: '5.0.0', link: true, resolved: 'packages/linked' },
    },
  };
  const MIT = 'Copyright (c) 2026 Nobody\n\nPermission is hereby granted, free of charge...';

  it('keeps production and devOptional, drops dev, extraneous and links', () => {
    // Four filters, one assertion, and each one is a real npm state: `dev` is the whole
    // scope decision; `devOptional` is reachable from a shipping optional dependency and so
    // must be KEPT, which is the one that reads backwards; `extraneous` is an `npm i
    // --no-save` leftover that is not in anyone's dependency graph; `link` is a workspace
    // symlink, not third-party code.
    const kept = (productionEntries(LOCK) as Entry[]).map((e) => e.name);
    expect(kept).toEqual(['devoptional', 'ships']);
  });

  it('refuses a lockfile too old to say what ships', () => {
    // lockfileVersion 1 has no `packages` map and no dev markers. Reading it leniently
    // would yield zero entries, and zero entries rendered is a document asserting that no
    // third-party code ships -- the exact false statement this whole file exists to
    // prevent. It must throw, not shrug.
    expect(() => productionEntries({ lockfileVersion: 1, dependencies: {} })).toThrow(
      /lockfileVersion 2 or 3/,
    );
    expect(() => productionEntries(null)).toThrow();
  });

  it('fails rather than listing a package whose licence text it could not find', () => {
    const dir = scratch(
      {
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/bare': { version: '1.0.0', license: 'MIT' } },
      },
      { 'node_modules/bare': { pkg: { name: 'bare', license: 'MIT' } } },
    );
    try {
      const { entries, failures } = collect(dir) as { entries: Entry[]; failures: string[] };
      expect(entries).toEqual([]);
      expect(failures.join('\n')).toMatch(/bare@1\.0\.0 ships no licence file/);
      // And the composed generator refuses to write anything at all.
      const built = buildNotices(dir) as { text: string | null; failures: string[] };
      expect(built.text).toBeNull();
      expect(built.failures.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write an empty notices file when nothing resolves', () => {
    // "No third-party code ships" and "the tree was not readable" produce the same empty
    // document, and only one of them is true. An empty file reads as the first.
    const dir = scratch(
      {
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/devonly': { version: '1.0.0', dev: true } },
      },
      {},
    );
    try {
      const { text, failures } = buildNotices(dir) as { text: string | null; failures: string[] };
      expect(text).toBeNull();
      expect(failures.join('\n')).toMatch(/no shipped dependencies/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names a package the lockfile ships but nobody installed', () => {
    const dir = scratch(
      {
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/absent': { version: '9.9.9', license: 'MIT' } },
      },
      {},
    );
    try {
      const { failures } = buildNotices(dir) as { failures: string[] };
      expect(failures.join('\n')).toMatch(/absent@9\.9\.9.*not installed/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a licence under any of the names packages actually use', () => {
    // `three` ships LICENSE, `howler` ships LICENSE.md, and the case is not fixed by
    // anything -- so the lookup is case-insensitive over the real listing. An empty file is
    // treated as absent, because a zero-byte LICENSE reproduces nothing.
    const dir = mkdtempSync(join(tmpdir(), 'tanks-notices-'));
    try {
      mkdirSync(join(dir, 'a'));
      writeFileSync(join(dir, 'a', 'LiCeNcE.md'), MIT);
      expect((readLicenceFile(join(dir, 'a')) as { file: string }).file).toBe('LiCeNcE.md');
      mkdirSync(join(dir, 'b'));
      writeFileSync(join(dir, 'b', 'LICENSE'), '   \n');
      expect(readLicenceFile(join(dir, 'b'))).toBeNull();
      expect(readLicenceFile(join(dir, 'nonexistent'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fences a licence that contains a code block without truncating it', () => {
    // Apache-2.0's appendix carries an indented boilerplate block, and a licence quoting a
    // triple backtick would close a three-backtick fence early: the rest of that package's
    // terms would render as prose and the next heading as code. Neither shipped licence
    // contains a backtick, so nothing in the real tree exercises this -- which is the point
    // of writing it against a made-up one.
    const text = 'Copyright (c) 2026 X\n\n```\nsample\n```\n\nPermission is hereby granted';
    const md: string = renderNotices([
      { name: 'q', version: '1.0.0', licence: 'MIT', licenceFile: 'node_modules/q/LICENSE', text },
    ]);
    expect(md).toContain(text);
    expect(md).toContain('````');
    // The whole text survives to the end of the section, not just up to the inner fence.
    expect(md.slice(md.indexOf('## q 1.0.0'))).toContain('Permission is hereby granted');
  });
});

describe('the licence census the backlog spike argues from', () => {
  // CLAUDE.md: quote a measurement and you owe it a recomputing test. The spike's case for
  // "nothing forces a choice" rests on a census of the dependency tree, and a census is
  // exactly the kind of figure that is true when written and false a dependency later.
  //
  // Counted from the LOCKFILE, not from node_modules: the installed set varies by platform
  // (83 of the 191 entries are optional native binaries for other OS/arch and are absent
  // here), so a node_modules census would give a different answer on a Mac and the guard
  // would fail for the wrong reason.
  const lock = JSON.parse(readFileSync(repo('package-lock.json'), 'utf8')) as {
    packages: Record<string, { license?: string }>;
  };
  const backlog = readFileSync(repo('docs/superpowers/backlog.md'), 'utf8');

  it('states the same counts the lockfile gives, and finds no copyleft that binds', () => {
    expect(backlog.length, 'backlog.md did not load').toBeGreaterThan(2000);
    const counts = new Map<string, number>();
    let total = 0;
    for (const [path, meta] of Object.entries(lock.packages)) {
      if (path === '') continue;
      total += 1;
      const key = typeof meta.license === 'string' ? meta.license : '(undeclared)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(total).toBeGreaterThan(0);

    const flat = backlog.replace(/\s+/g, ' ');
    // The total, pulled out numerically rather than as a substring -- an unanchored needle
    // is one left-extended digit away from matching a different number (backlog.test.ts
    // found that exact hole with "147" matching "1147").
    const stated = /Across the \*\*(\d+)\*\* non-root `package-lock\.json` entries/.exec(flat);
    expect(stated, 'the census sentence must exist and keep its shape').not.toBeNull();
    expect(Number(stated![1])).toBe(total);

    // Every licence the tree declares must appear in the quoted breakdown with its real
    // count -- so adding a dependency under a new licence fails here rather than silently
    // widening a list the spike calls exhaustive.
    for (const [licence, n] of [...counts].sort()) {
      expect(flat, `the breakdown omits or miscounts ${licence}`).toContain(`${n} ${licence}`);
    }
    expect(counts.get('(undeclared)') ?? 0).toBe(0);

    // The claim the argument actually turns on. A GPL/LGPL/AGPL package anywhere in the
    // tree would make the outbound choice a constraint rather than a preference, and the
    // spike says there is none.
    const copyleft = [...counts.keys()].filter((l) => /GPL/i.test(l));
    expect(copyleft, 'a GPL-family licence entered the tree').toEqual([]);
  });

  it('names the right packages behind the one weak-copyleft licence', () => {
    // "12 MPL-2.0, all lightningcss, all dev" is three claims in one sentence; the middle
    // one is the one that would rot, because MPL is per-file copyleft and it mattering
    // depends entirely on WHICH package carries it.
    const mpl = Object.entries(lock.packages).filter(([, m]) => m.license === 'MPL-2.0');
    expect(mpl.length).toBeGreaterThan(0);
    for (const [path, meta] of mpl) {
      expect(path, 'an MPL-2.0 package that is not lightningcss').toMatch(/lightningcss/);
      expect(
        (meta as { dev?: boolean }).dev,
        `${path} is MPL-2.0 and is no longer dev-only -- it would then SHIP`,
      ).toBe(true);
    }
    expect(backlog).toContain(`All ${mpl.length} MPL-2.0 entries`);
  });
});

describe("the repo's own licence", () => {
  it('says who holds the copyright and disclaims warranty', () => {
    // A LICENSE with no copyright line names nobody, and one with no disclaimer is a
    // liability. Both are things a well-meaning edit removes.
    expect(licenseText).toMatch(/Copyright \(c\) \d{4}(-\d{4})? \S/);
    expect(licenseText).toContain('WITHOUT WARRANTY OF ANY KIND');
    expect(licenseText).toContain('THIRD-PARTY-NOTICES.md');
  });

  it('agrees with the `license` field in package.json', () => {
    // The one place these two can silently disagree, and the disagreement is the expensive
    // kind: a repo whose LICENSE grants MIT rights while package.json says UNLICENSED (or
    // the reverse) has published two different answers to "may I use this".
    //
    // The test is the grant itself, not the filename: MIT, BSD and Apache all open with a
    // permission grant, and this repo's licence deliberately does not. Swapping in any OSI
    // text without updating package.json fails here, and so does changing the field alone.
    const grantsPermission = /Permission is hereby granted, free of charge/.test(licenseText);
    if (grantsPermission) {
      expect(
        pkg.license,
        'LICENSE grants permission to use the software, so package.json must name that licence, not UNLICENSED',
      ).not.toBe('UNLICENSED');
      expect(pkg.license).toBeTruthy();
    } else {
      expect(
        pkg.license,
        'LICENSE grants no rights, so package.json must say UNLICENSED -- npm\'s spelling for "not open source"',
      ).toBe('UNLICENSED');
    }
  });
});
