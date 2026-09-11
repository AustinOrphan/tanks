import { describe, it, expect } from 'vitest';
import { dirname, join, resolve, sep } from 'node:path';
import { DEFAULT_OUT, REPORT_BASENAME, screenCapturePaths } from './paths.mjs';

// ---------------------------------------------------------------------------
// Issue #637. `run.mjs` defaulted both `--out` and `--report` to bare basenames and
// handed them to `resolve()`, which resolves against the working directory -- the
// repository root for every `npm run` script. A hand-run that omitted either flag left
// `screen.png` or `producer.json` in the root, where `.gitignore` does not cover them
// (its scratch entries are root-anchored at `/tmp/` and `/scratchpad/`), so the next
// `git add -A` committed a build artifact. That happened twice before this.
//
// These run against the pure resolver rather than the CLI because `run.mjs` launches
// Playwright on import; the defaulting is the part of it a test can reach, and it is
// where the whole defect lived.
// ---------------------------------------------------------------------------

const repoRoot = resolve(process.cwd());
const inRepoRoot = (p: string): boolean => dirname(p) === repoRoot;

describe('screen capture output paths (issue #637)', () => {
  it('never defaults either artifact into the repository root', () => {
    // THE REGRESSION GUARD, and it is written about the root rather than about the
    // literal 'tmp/screen.png' on purpose: the defect is "lands somewhere a git add -A
    // sweeps up", not "lands at a particular path". A future move to another ignored
    // directory should keep this passing; a move back to the root must not.
    const { out, report } = screenCapturePaths();
    expect(inRepoRoot(out), `default --out resolved to the repo root: ${out}`).toBe(false);
    expect(inRepoRoot(report), `default --report resolved to the repo root: ${report}`).toBe(false);
  });

  it('defaults the frame under the root-ignored scratch directory', () => {
    // Paired with the assertion above rather than replacing it: this one pins WHERE, so a
    // change of destination is a deliberate edit here, and that one pins the INVARIANT
    // that makes any destination acceptable.
    expect(DEFAULT_OUT).toBe('tmp/screen.png');
    expect(screenCapturePaths().out).toBe(resolve(repoRoot, 'tmp', 'screen.png'));
  });

  it('puts an omitted report beside the frame, not in the working directory', () => {
    // The actual reported bug: `--out` was given, `--report` was not, and the report went
    // to the root instead of following the frame it describes.
    const { out, report } = screenCapturePaths({ out: 'artifacts/capture/records.png' });
    expect(report).toBe(join(dirname(out), REPORT_BASENAME));
    expect(report).toBe(resolve(repoRoot, 'artifacts', 'capture', REPORT_BASENAME));
  });

  it('honours an explicit report path, which is how the capture framework calls it', () => {
    // `tools/capture/screen-adapter.mjs` passes `--report <outputRelative>/producer.json`
    // explicitly, so the framework never relied on the broken default. The negative
    // control for the case above: a fix that ALWAYS derived the report would silently
    // relocate every framework capture's report.
    const { report } = screenCapturePaths({
      out: 'artifacts/capture/frame.png',
      report: 'artifacts/capture/elsewhere/producer.json',
    });
    expect(report).toBe(resolve(repoRoot, 'artifacts', 'capture', 'elsewhere', 'producer.json'));
  });

  it('resolves an absolute --out without prefixing the working directory', () => {
    // Scratch directories outside the repository are how this tool is driven by hand --
    // the session scratchpad is one -- so an absolute path must survive untouched, and its
    // report must follow it out rather than being stranded back inside the repo.
    const absolute = resolve(sep, 'var', 'tmp', 'shots', 'frame.png');
    const { out, report } = screenCapturePaths({ out: absolute });
    expect(out).toBe(absolute);
    expect(report).toBe(join(dirname(absolute), REPORT_BASENAME));
  });
});
