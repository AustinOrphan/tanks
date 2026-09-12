import { describe, it, expect } from 'vitest';
import {
  devMenuView,
  resetSelection,
  toggleField,
  cycleSelect,
  stepNumeric,
  setLiteral,
  stepMultiset,
  multisetCounts,
  isMultiset,
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

describe('stepNumeric: the parser owns the bounds, not this module', () => {
  it('walks `players` up to its ceiling and refuses to pass it', () => {
    // The registry states "an integer 1-4" as PROSE. Writing 4 down here would duplicate
    // what `parseDevFlags` already enforces and put the menu one edit away from offering a
    // value the game refuses. Instead the step is proposed and the model asked, so this
    // passes for whatever the parser's real ceiling is.
    const players = controlFor('players');
    let sel = {};
    const seen: (string | null)[] = [];
    for (let i = 0; i < 8; i++) {
      sel = stepNumeric(sel, players, 1);
      seen.push((sel as Record<string, string>).players ?? null);
    }
    expect(seen[0]).toBe('1');
    const top = seen[seen.length - 1];
    expect(Number(top), 'never left the accepted range').toBeGreaterThanOrEqual(1);
    // It stopped rather than running away: the last few samples are all the same value.
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]);
    // ...and that value is genuinely accepted.
    expect(
      devMenuView(sel).state.notes.filter((n) => n.field === 'players' && n.reason === 'rejected'),
    ).toEqual([]);
  });

  it('negative control: the ceiling is the PARSER’s, shown by a flag with a different one', () => {
    // If the bound were hardcoded here, `bots` and `players` would stop at the same number.
    // They do not -- bots accepts 0, players does not -- so this measures that the answer
    // comes from the model.
    const bots = controlFor('bots');
    const players = controlFor('players');
    const botsFromUnset = stepNumeric({}, bots, 1, 0);
    const playersFromUnset = stepNumeric({}, players, 1, 1);
    expect((botsFromUnset as Record<string, string>).bots).toBe('0');
    expect((playersFromUnset as Record<string, string>).players).toBe('1');
    expect(devMenuView(botsFromUnset).state.effective.bots).toBe(0);
  });

  it('clears the control when stepped below its first value, so unset stays reachable', () => {
    const players = controlFor('players');
    const one = stepNumeric({}, players, 1);
    expect(one).toEqual({ players: '1' });
    expect(stepNumeric(one, players, -1), 'must return to unset').toEqual({});
  });

  it('never mutates the selection it was given, on any path', () => {
    const players = controlFor('players');
    for (const before of [{}, { players: '1' }, { players: '4' }]) {
      const copy = { ...before };
      stepNumeric(before, players, 1);
      stepNumeric(before, players, -1);
      expect(before).toEqual(copy);
    }
  });
});

describe('setLiteral', () => {
  it('sets the literal a parser takes beside a number, and clears it again', () => {
    // `sandbox` is not a bigger level and `random:8` is not more walls than 8, so these are
    // their own control rather than stops a stepper walks through.
    const level = controlFor('level');
    const sel = setLiteral({}, level, 'sandbox');
    expect(sel).toEqual({ level: 'sandbox' });
    expect(
      devMenuView(sel).state.notes.filter((n) => n.field === 'level' && n.reason === 'rejected'),
      'the parser must accept the literal this offers',
    ).toEqual([]);
    expect(setLiteral(sel, level, null)).toEqual({});
  });
});

describe('stepMultiset', () => {
  const tanks = () => controlFor('sandboxTanks');

  it('builds a list with repeats, which is what the parser takes', () => {
    // The numeric stepper was INERT here -- measured: stepping `sandboxTanks` from unset
    // returned the same empty selection, because `Number('brown,teal')` is NaN. This is the
    // control that flag never had.
    const c = tanks();
    const kind = (c.values ?? [])[0];
    let sel = stepMultiset({}, c, kind, 1);
    expect(sel).toEqual({ sandboxTanks: kind });
    sel = stepMultiset(sel, c, kind, 1);
    expect(sel).toEqual({ sandboxTanks: `${kind},${kind}` });
    expect(
      devMenuView(sel).state.notes.filter((n) => n.field === 'sandboxTanks' && n.reason === 'rejected'),
      'the list this builds must be one the parser takes',
    ).toEqual([]);
  });

  it('clears the parameter when the last one is removed, rather than emitting empty', () => {
    const c = tanks();
    const kind = (c.values ?? [])[0];
    const one = stepMultiset({}, c, kind, 1);
    expect(stepMultiset(one, c, kind, -1)).toEqual({});
  });

  it('cannot go below zero for a kind, by construction rather than by a guard', () => {
    // The counts are re-derived from the parameter STRING each call and the rebuild emits
    // nothing for a non-positive count, so a negative has nowhere to live. An explicit floor
    // guard was written here first and removed when its mutation survived -- unobservable
    // code that reads as a safety check is worse than none, because it invites trust.
    const c = tanks();
    const kind = (c.values ?? [])[0];
    expect(stepMultiset({}, c, kind, -1)).toEqual({});
    const one = stepMultiset({}, c, kind, 1);
    expect(stepMultiset(stepMultiset(one, c, kind, -1), c, kind, -1)).toEqual({});
    // ...and the count reads zero rather than a negative, on the way back up.
    expect(multisetCounts(stepMultiset({}, c, kind, -1), c).get(kind)).toBe(0);
  });

  it('counts each kind separately', () => {
    const c = tanks();
    const [a, b] = c.values ?? [];
    let sel = stepMultiset({}, c, a, 1);
    sel = stepMultiset(sel, c, b, 1);
    sel = stepMultiset(sel, c, a, 1);
    const counts = multisetCounts(sel, c);
    expect(counts.get(a)).toBe(2);
    expect(counts.get(b)).toBe(1);
  });

  it('isMultiset is derived from the registry, not from a field name', () => {
    // A flag carrying BOTH a `type` and a `values` list is one whose value is built out of
    // those values. The rule is what makes a second such flag work the day it is registered.
    expect(isMultiset(controlFor('sandboxTanks'))).toBe(true);
    expect(isMultiset(controlFor('players')), 'a plain numeric input').toBe(false);
    expect(isMultiset(controlFor('quality')), 'a select').toBe(false);
    expect(isMultiset(controlFor('aimRay')), 'a toggle').toBe(false);
  });
});
