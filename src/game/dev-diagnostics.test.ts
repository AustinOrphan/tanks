import { describe, it, expect } from 'vitest';
import {
  readBuildIdentity,
  canonicalUrl,
  pinnedSeedUrl,
  diagnosticsReport,
  formatDiagnostics,
  type DiagnosticsInput,
  type SessionDiagnostics,
} from './dev-diagnostics';
import { parseDevFlags } from './devflags';

const SESSION: SessionDiagnostics = {
  seed: 918273645,
  arenaId: 'arena-04',
  mode: 'campaign',
  humanPlayers: 1,
  bots: 0,
  quality: 'high',
};

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    path: '/tanks/',
    search: '?dev=1',
    hash: '',
    build: { commit: '', known: false },
    session: SESSION,
    ...overrides,
  };
}

describe('readBuildIdentity says unknown rather than inventing a version', () => {
  it('reports a supplied commit as known', () => {
    expect(readBuildIdentity({ VITE_BUILD_SHA: 'abc1234' })).toEqual({ commit: 'abc1234', known: true });
  });

  it('reports an absent variable as unknown, not as an empty commit', () => {
    // `known: false` is the answer a local build, a dev server and any tree that never went
    // through the deploy workflow genuinely has. The acceptance criterion is that copied
    // diagnostics "identify local/unknown builds honestly", so the flag is what a reader
    // branches on rather than the emptiness of a string.
    expect(readBuildIdentity({})).toEqual({ commit: '', known: false });
  });

  it('treats an empty or whitespace value as absent', () => {
    // An unset variable in a shell substitution arrives as `''`, and a CI step that
    // interpolated a missing SHA would produce whitespace. Either way the build does not
    // know its commit, and a report printing "Build: " would be claiming that it did.
    for (const raw of ['', '   ', '\n']) {
      expect(readBuildIdentity({ VITE_BUILD_SHA: raw }), JSON.stringify(raw)).toEqual({
        commit: '',
        known: false,
      });
    }
  });
});

describe('canonicalUrl', () => {
  it('normalizes the developer parameters and keeps path and hash', () => {
    // Through `canonicalDevSearch`, so the URL in a report is the one the model produces for
    // those flags rather than the order they were typed -- which is what makes a pasted
    // report and a menu-built URL the same string for the same session.
    const url = canonicalUrl('/tanks/', '?seed=7&dev=1', '#top');
    expect(url).toBe('/tanks/?dev=1&seed=7#top');
  });

  it('carries a parameter the model does not own, in place', () => {
    // A deep link or a router's own query must survive being copied: this model has no
    // authority over parameters it does not know, and a report that silently dropped one
    // would not reproduce the session it claims to describe.
    expect(canonicalUrl('/tanks/', '?utm=x&dev=1', '')).toBe('/tanks/?dev=1&utm=x');
  });
});

describe('pinnedSeedUrl recreates the seed without touching anything', () => {
  it('adds the live seed to a URL that asked for none, and the result parses back to it', () => {
    // THE ISSUE'S FIRST CRITERION, end to end: "an unseeded observed world can produce a URL
    // that recreates the same seed". Asserted by PARSING the result with the same
    // `parseDevFlags` the game boots with, not by string-matching the URL -- a URL that
    // merely contains the digits would pass a `toContain` and still not reproduce anything.
    const url = pinnedSeedUrl(input({ search: '?dev=1' }));
    expect(url).toBe('/tanks/?dev=1&seed=918273645');
    expect(parseDevFlags(url!.slice(url!.indexOf('?'))).seed).toBe(SESSION.seed);
  });

  it('REPLACES a seed the URL already carried rather than appending a second', () => {
    // `devflags.ts` reads the FIRST value of a duplicated parameter, so appending would
    // leave the old seed in force and the pinned one silently ignored -- by the very reload
    // the pin exists to configure. The parse is the assertion for exactly that reason.
    const url = pinnedSeedUrl(input({ search: '?dev=1&seed=1' }));
    expect(parseDevFlags(url!.slice(url!.indexOf('?'))).seed).toBe(SESSION.seed);
    expect(url).not.toContain('seed=1&');
  });

  it('returns null with no session, because there is no seed to pin', () => {
    expect(pinnedSeedUrl(input({ session: null }))).toBeNull();
  });

  it('does not mutate the session snapshot it was handed', () => {
    // "Seed pinning does not change the current world before the user applies/reloads" is
    // the criterion most at risk here. This function cannot reach a world at all -- it takes
    // strings and a frozen-shaped record -- and this pins that: the snapshot it was given is
    // byte-identical afterwards, so a future version that started writing back fails here
    // rather than in a playtest.
    const session = { ...SESSION };
    const before = JSON.stringify(session);
    pinnedSeedUrl(input({ session }));
    expect(JSON.stringify(session)).toBe(before);
  });
});

describe('formatDiagnostics', () => {
  it('states the URL, the build, the seed and the setup', () => {
    const text = formatDiagnostics(input({ build: { commit: 'deadbee', known: true } }));
    expect(text).toContain('- URL: /tanks/?dev=1');
    expect(text).toContain('- Build: deadbee');
    expect(text).toContain('- Seed: 918273645');
    expect(text).toContain('- Arena: arena-04');
    expect(text).toContain('- Mode: campaign');
    expect(text).toContain('- Players: 1 human, 0 bots');
    expect(text).toContain('- Quality: high');
  });

  it('says a local build is unknown, in words', () => {
    // The honest-build criterion at the text layer. A reader pasting this into an issue must
    // be able to tell "built from nothing we can name" from "we forgot to print it".
    expect(formatDiagnostics(input())).toContain('- Build: unknown (not a deployed build)');
  });

  it('says there is no session rather than printing a seed of zero', () => {
    const text = formatDiagnostics(input({ session: null }));
    expect(text).toContain('- Session: none simulating (no seed to report)');
    expect(text).not.toContain('- Seed:');
  });

  it('counts one bot in the singular', () => {
    expect(formatDiagnostics(input({ session: { ...SESSION, bots: 1 } }))).toContain('1 bot\n');
  });

  it('separates requested from effective, with the model’s own reason', () => {
    // "Requested and effective flags cannot be confused in the output" -- so the parameters
    // that did not take effect get their OWN section rather than being folded into one map
    // where a reader cannot tell which number was asked for. The reason comes from
    // `explainDevConfig`, the same model the configuration menu renders, so the copied text
    // cannot disagree with the pane beside it.
    //
    // `?seed=7` with no `dev=1` is the sharpest case: the gate is closed, so the flag reads
    // as its default and no per-flag comparison against defaults could tell that the URL had
    // asked for anything at all.
    const text = formatDiagnostics(input({ search: '?seed=7' }));
    expect(text).toContain('### Requested, but not in effect');
    expect(text).toContain('`seed`: requested `7`');
    expect(text).toContain('gate-closed');
    expect(text).toContain('- Developer mode: off');
    // ...and the section stops at the parameters that were actually asked for.
    expect(text.split('### In effect without being requested')[0]).not.toContain('`disarmed`');
  });

  it('files an unrequested default under its OWN heading, not under "requested"', () => {
    // The split the model forced. `sandboxDisarmed` defaults ON, so `explainDevConfig`
    // emits an `inverted-default` note on EVERY developer session -- with no `requested`
    // value, because the URL never asked. An earlier draft had one "Requested, but not in
    // effect" section and put it there, which meant every report this pane can produce
    // claimed a request that was never made.
    const text = formatDiagnostics(input({ search: '?dev=1&seed=918273645' }));
    expect(text).toContain('### In effect without being requested');
    expect(text).toContain('`disarmed`: requested (absent)');
    expect(text).not.toContain('### Requested, but not in effect');
    expect(text).not.toContain('### Parameters this build does not know');
  });

  it('keeps the two apart when both are present at once', () => {
    // The case that proves the split is a partition rather than an ordering, and the fixture
    // had to be chosen for it: a CLOSED gate (`?seed=7` alone) short-circuits
    // `explainDevConfig` before the inverted default is reached, so only one heading appears
    // and the case would be measuring an ordering it never saw. `?dev=1&seed=abc` opens the
    // gate and asks for something unparseable, so a `rejected` note (requested) and the
    // standing `inverted-default` one (not requested) arrive together.
    const text = formatDiagnostics(input({ search: '?dev=1&seed=abc' }));
    // BOTH HEADINGS PRESENT is asserted first, and it is the half that makes the rest able
    // to fail: a formatter that merged the sections emits only the first heading, `indexOf`
    // of the second returns -1, and a slice to -1 would quietly exclude the very line the
    // assertion below is looking for. Measured -- the merged version survived this case
    // until this line was added.
    const at = (h: string): number => text.indexOf(h);
    expect(at('### Requested, but not in effect')).toBeGreaterThan(-1);
    expect(at('### In effect without being requested')).toBeGreaterThan(at('### Requested, but not in effect'));
    const requestedSection = text.slice(
      at('### Requested, but not in effect'),
      at('### In effect without being requested'),
    );
    expect(requestedSection).toContain('`seed`');
    expect(requestedSection).not.toContain('`disarmed`');
  });

  it('names a parameter this build does not know, instead of dropping it silently', () => {
    // An unknown parameter is the signal that a report came from a DIFFERENT build than the
    // reader's -- a flag that has since been renamed or removed. Dropping it would erase the
    // one clue that the two trees disagree.
    const text = formatDiagnostics(input({ search: '?dev=1&notAFlag=2' }));
    expect(text).toContain('### Parameters this build does not know');
    expect(text).toContain('`notAFlag`');
  });

  it('carries no store, settings or browser data beyond the fields it names', () => {
    // Secrets and unrelated personal data are absent BY CONSTRUCTION here -- this module can
    // reach no store and no cookie -- and this is the assertion that says the text stayed
    // that way. The population is every line the formatter can emit; each must start with a
    // heading, a blank, or one of the named field prefixes.
    const text = formatDiagnostics(input({ search: '?dev=1&notAFlag=2&seed=7' }));
    const allowed =
      /^(##|###|$|- (URL|Build|Developer mode|Seed|Arena|Mode|Players|Quality|Session):|- `)/;
    const strays = text.split('\n').filter((l) => !allowed.test(l));
    expect(strays).toEqual([]);
  });
});

describe('diagnosticsReport is the structured source the text is rendered from', () => {
  it('carries the same facts as the text, for issue #241 to export without parsing prose', () => {
    // The record exists so the file export owned by #241 consumes a structure rather than
    // re-parsing Markdown. It is asserted against the TEXT rather than on its own, because a
    // record that drifted from what the pane copies would be worse than no record at all.
    const report = diagnosticsReport(input({ search: '?dev=1&notAFlag=2' }));
    const text = formatDiagnostics(input({ search: '?dev=1&notAFlag=2' }));
    expect(report.canonicalUrl).toBe('/tanks/?dev=1&notAFlag=2');
    expect(text).toContain(report.canonicalUrl);
    expect(report.developerMode).toBe(true);
    expect(report.unknownParams).toEqual(['notAFlag']);
    expect(report.session).toBe(SESSION);
  });
});
