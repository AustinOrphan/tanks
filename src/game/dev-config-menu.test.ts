import { describe, it, expect } from 'vitest';
import {
  devMenuView,
  resetSelection,
  toggleField,
  cycleSelect,
} from './dev-config-menu';
import {
  devControls,
  devSearchFrom,
  explainDevConfig,
  DEV_FLAG_GROUPS,
  DEV_PRESETS,
  type DevControl,
} from './dev-config';

const controlFor = (field: string): DevControl =>
  devControls().find((c) => c.field === field) as DevControl;

describe('devMenuView: the round trip that makes the preview honest', () => {
  it('previews the URL it would apply, read back through the parser the game boots with', () => {
    // THE LOAD-BEARING CASE. `explainDevConfig` routes `parseDeveloperMode`/`parseDevFlags`
    // -- the same two functions `createBrowserDeps` calls at boot -- so previewing THROUGH
    // the search string means the preview is the real computation run early, not a second
    // one. Deriving notes from the selection instead would let preview and reload disagree
    // with nothing in the suite to notice.
    const selection = { playtest: true, quality: 'low' };
    const view = devMenuView(selection);
    expect(view.search).toBe(devSearchFrom(selection));
    expect(view.state).toEqual(explainDevConfig(view.search));
    expect(view.state.developerMode, 'the gate is always emitted').toBe(true);
    expect(view.state.effective.quality).toBe('low');
  });

  it('carries a non-developer query through, so Apply does not drop a deep link', () => {
    const view = devMenuView({ quality: 'high' }, '?utm=x&level=9');
    expect(view.search).toContain('utm=x');
    // ...and the developer half still wins for a parameter it owns.
    expect(view.state.effective.quality).toBe('high');
  });

  it('shows every registered control exactly once, in an appropriate category', () => {
    // Acceptance criterion 1, derived rather than listed: the population is the registry's,
    // so a flag added tomorrow appears the day it is registered.
    const view = devMenuView({});
    const shown = view.groups.flatMap((g) => g.controls.map((c) => c.control.field));
    const expected = devControls().map((c) => c.field);
    expect(shown.length, 'a control appears twice or not at all').toBe(expected.length);
    expect([...shown].sort()).toEqual([...expected].sort());
    expect(shown.length, 'the registry sweep found nothing').toBeGreaterThan(20);
    // The bundle is a control too, and it is not a DevFlags field.
    expect(shown).toContain('playtest');
  });

  it('orders groups as the model does, and omits none that has controls', () => {
    const view = devMenuView({});
    const seen = view.groups.map((g) => g.group);
    expect(seen).toEqual(DEV_FLAG_GROUPS.filter((g) => seen.includes(g)));
    expect(seen.length).toBe(new Set(seen).size);
    for (const g of view.groups) expect(g.controls.length, `${g.group} is empty`).toBeGreaterThan(0);
  });

  it('attaches each note to the control it is about', () => {
    // `playtest` forces booleans on without the URL asking for them, which the model reports
    // as `bundle-forced` against each forced FIELD -- not against the bundle. A menu that
    // filed every note under the parameter that caused it would show them all in one place.
    const view = devMenuView({ playtest: true });
    const forced = view.groups
      .flatMap((g) => g.controls)
      .filter((c) => c.notes.some((n) => n.reason === 'bundle-forced'));
    expect(forced.length, 'the bundle forced nothing').toBeGreaterThan(0);
    for (const c of forced) {
      for (const n of c.notes) expect(n.field).toBe(c.control.field);
    }
  });

  it('surfaces a rejected value against its own control rather than silently defaulting', () => {
    // Acceptance criterion 7. `players` takes 1-4; the parser refuses anything else and the
    // flag's default stands, which is invisible without the note.
    const view = devMenuView({ players: '9' });
    const players = view.groups.flatMap((g) => g.controls).find((c) => c.control.field === 'players');
    expect(players?.notes.map((n) => n.reason)).toContain('rejected');
  });

  it('reports unknown parameters, which name no control at all', () => {
    const view = devMenuView({}, '?nosuchflag=1');
    expect(view.state.unknownParams).toContain('nosuchflag');
  });
});

describe('the namespace, shown before anything acts on saved state', () => {
  it('is developer for every previewed URL, because the gate is always emitted', () => {
    // `selectStorageNamespace` keys off the gate, and `devSearchFrom` always emits it -- so
    // any URL this menu can build boots into `tanks.dev.`. Stated here because the
    // consequence outlives the reload and is invisible in the flags: a developer page cannot
    // see a production save, which reads as progress having vanished.
    expect(devMenuView({}).namespace).toBe('developer');
    expect(devMenuView({ playtest: true }).namespace).toBe('developer');
    expect(devMenuView(resetSelection()).namespace).toBe('developer');
  });
});

describe('resetSelection', () => {
  it('keeps the gate, so Reset clears the options and does not leave developer mode', () => {
    // Acceptance criterion 5, and the trap `dev-config.ts` names: Reset is `devSearchFrom({})`
    // and NOT `developerExitSearch`, whose job is to remove the gate too. Getting it wrong
    // moves the page to the production namespace on the next load -- a different and much
    // larger action than clearing options.
    const view = devMenuView(resetSelection());
    expect(view.state.developerMode).toBe(true);
    expect(view.namespace).toBe('developer');
    // ...and nothing else is asked for.
    expect(view.state.notes.filter((n) => n.reason !== 'inverted-default')).toEqual([]);
  });
});

describe('toggleField', () => {
  it('turns a toggle on and back off, and never mutates the selection it was given', () => {
    const before = { quality: 'low' } as const;
    const on = toggleField(before, 'aimRay');
    expect(on).toEqual({ quality: 'low', aimRay: true });
    expect(before, 'the input was mutated').toEqual({ quality: 'low' });
    expect(toggleField(on, 'aimRay')).toEqual({ quality: 'low' });
  });

  it('an off toggle is ABSENT, not false, which is what keeps the URL minimal', () => {
    expect(Object.keys(toggleField({ aimRay: true }, 'aimRay'))).toEqual([]);
    expect(devMenuView(toggleField({ aimRay: true }, 'aimRay')).search).not.toContain('aimRay');
  });
});

describe('cycleSelect', () => {
  it('walks a select through its own values and back to unset', () => {
    // Unset must be a stop or the control could never be put back: every one of these flags
    // defaults to absent, so a cycle over `values` alone traps the menu on whichever value it
    // first landed on.
    const quality = controlFor('quality');
    const values = quality.values as readonly string[];
    let sel = {};
    for (const v of values) {
      sel = cycleSelect(sel, quality);
      expect(sel).toEqual({ quality: v });
    }
    sel = cycleSelect(sel, quality);
    expect(sel, 'the cycle must return to unset').toEqual({});
  });

  it('steps backwards too, from unset to the LAST value', () => {
    const quality = controlFor('quality');
    const values = quality.values as readonly string[];
    expect(cycleSelect({}, quality, -1)).toEqual({ quality: values[values.length - 1] });
  });

  it('a forward press on a fresh control selects the first value, not the second', () => {
    // Unset is the first stop rather than the last, which is what makes this true -- the
    // reading a player expects from an untouched control.
    const mode = controlFor('mode');
    expect(cycleSelect({}, mode)).toEqual({ mode: (mode.values as readonly string[])[0] });
  });
});

describe('the six presets', () => {
  it('previews each one through the same parser, with no hidden state', () => {
    // Acceptance criterion 3. Every preset is previewed by the identical round trip an
    // ordinary selection uses, so a preset cannot introduce a value the menu could not have
    // reached itself.
    expect(DEV_PRESETS).toHaveLength(6);
    for (const preset of DEV_PRESETS) {
      const view = devMenuView(preset.selection);
      expect(view.search, `${preset.id} built no URL`).toBe(devSearchFrom(preset.selection));
      expect(view.state, `${preset.id} previewed something other than its URL`).toEqual(
        explainDevConfig(view.search),
      );
      expect(view.state.developerMode, `${preset.id} lost the gate`).toBe(true);
      expect(
        view.state.notes.filter((n) => n.reason === 'rejected'),
        `${preset.id} names a value the parser refuses`,
      ).toEqual([]);
    }
  });

  it('is exposed in the model order the issue lists', () => {
    expect(devMenuView({}).presets.map((p) => p.id)).toEqual(DEV_PRESETS.map((p) => p.id));
  });
});
