import { describe, it, expect } from 'vitest';
import { defaultSlots } from './versus-setup';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import type { VersusConfig } from './versus-config';
import {
  descriptorFor,
  practiceLevelIdentity,
  identityForLevelPick,
  relaunchTargetFor,
  resolveBootSessionContext,
  type SessionIdentity,
} from './session-intent';

/**
 * The one translation boundary (issue #316, review finding 3). Every developer
 * and menu entry point must land on an accurate Campaign / Practice / Versus
 * descriptor, with provenance kept beside it rather than inside it.
 *
 * Population: the five boot shapes `resolveBootSessionContext` distinguishes
 * (setup-pane VS, sandbox, developer VS flags, developer level jump, plain
 * campaign), each asserted for BOTH the identity it produces and the
 * developer metadata it records. Excluded: flags that do not participate in
 * session selection (aimRay, quality, ...), covered by devflags.test.ts.
 */

const flags = (o: Partial<DevFlags> = {}): DevFlags => ({ ...DEV_FLAGS_OFF, ...o });

const paneConfig = (o: Partial<VersusConfig> = {}): VersusConfig => ({
  mode: 'ffa',
  players: 2,
  arenaId: 'random',
  stock: 3,
  friendlyFire: false,
  ...o, slots: defaultSlots(2) });

const boot = (o: {
  devFlags?: Partial<DevFlags>;
  versusConfig?: VersusConfig | null;
  developerMode?: boolean;
} = {}) =>
  resolveBootSessionContext({
    devFlags: flags(o.devFlags),
    versusConfig: o.versusConfig ?? null,
    developerMode: o.developerMode ?? false,
  });

describe('resolveBootSessionContext: every boot path gets an accurate identity', () => {
  it('a plain boot is Campaign with no developer provenance', () => {
    const ctx = boot();
    expect(ctx.identity).toEqual({ kind: 'campaign' });
    expect(ctx.developer).toEqual({ active: false, sessionOrigin: null, levelJump: null });
  });

  it('a setup-pane versus reboot is Versus, retaining the UNRESOLVED selection', () => {
    const ctx = boot({ versusConfig: paneConfig({ arenaId: 'random' }) });
    expect(ctx.identity.kind).toBe('versus');
    if (ctx.identity.kind !== 'versus') throw new Error('unreachable');
    expect(ctx.identity.rules.arenaSelection).toBe('random');
    expect(ctx.identity.rules.stock).toBe(3);
    // Pane-driven, not developer-driven, even when developer mode is on.
    expect(ctx.developer.sessionOrigin).toBe(null);
  });

  describe('developer versus flags -- the case that retained a Campaign descriptor', () => {
    it.each(['ffa', 'teams'] as const)('?dev=1&mode=%s is a VERSUS session', (mode) => {
      const ctx = boot({ devFlags: { mode }, developerMode: true });
      expect(ctx.identity.kind).toBe('versus');
      if (ctx.identity.kind !== 'versus') throw new Error('unreachable');
      expect(ctx.identity.rules.mode).toBe(mode);
      expect(ctx.developer.sessionOrigin).toBe('versus-flags');
    });

    it('reports the real one-slot player count rather than inventing a pair', () => {
      const ctx = boot({ devFlags: { mode: 'ffa' }, developerMode: true });
      if (ctx.identity.kind !== 'versus') throw new Error('unreachable');
      expect(ctx.identity.rules.players).toBe(1);
      // Neither is expressible as a developer flag.
      expect(ctx.identity.rules.stock).toBe(null);
      expect(ctx.identity.rules.arenaSelection).toBe(null);
    });

    it('carries the players and friendlyFire flags through', () => {
      const ctx = boot({
        devFlags: { mode: 'teams', players: 4, friendlyFire: true },
        developerMode: true,
      });
      if (ctx.identity.kind !== 'versus') throw new Error('unreachable');
      expect(ctx.identity.rules.players).toBe(4);
      expect(ctx.identity.rules.friendlyFire).toBe(true);
    });

    it('records BOTH facts when a jump and versus flags are combined', () => {
      // `?dev=1&mode=ffa&level=3` is a Versus session played on level 3's
      // arena. A single provenance enum could not say both, which is why
      // `levelJump` is its own field.
      const ctx = boot({ devFlags: { mode: 'ffa', level: 3 }, developerMode: true });
      expect(ctx.identity.kind).toBe('versus');
      expect(ctx.developer.sessionOrigin).toBe('versus-flags');
      expect(ctx.developer.levelJump).toBe(3);
    });
  });

  it('?dev=1&level=sandbox is Practice on the sandbox, with no fabricated ordinal', () => {
    const ctx = boot({ devFlags: { level: 'sandbox' }, developerMode: true });
    expect(ctx.identity).toEqual({ kind: 'practice-sandbox' });
    expect(ctx.developer.sessionOrigin).toBe('sandbox');
    expect(ctx.developer.levelJump).toBe(null);
  });

  it('?dev=1&level=N is Practice on that level -- NOT Campaign', () => {
    // A jump must not consume, advance, or end the active run, which is
    // precisely the Practice contract. Provenance is what distinguishes it
    // from a menu Level-Select pick.
    const ctx = boot({ devFlags: { level: 4 }, developerMode: true });
    expect(ctx.identity).toEqual({ kind: 'practice-level' });
    expect(ctx.developer.sessionOrigin).toBe('level-jump');
    expect(ctx.developer.levelJump).toBe(4);
  });

  it('developer mode with no session-selecting flag stays Campaign but records `active`', () => {
    const ctx = boot({ devFlags: { aimRay: true }, developerMode: true });
    expect(ctx.identity).toEqual({ kind: 'campaign' });
    expect(ctx.developer.active).toBe(true);
    expect(ctx.developer.sessionOrigin).toBe(null);
  });

  it('a setup-pane reboot records no level jump, since its LevelSystem ignores `level`', () => {
    const ctx = boot({
      devFlags: { level: 3 },
      versusConfig: paneConfig(),
      developerMode: true,
    });
    expect(ctx.developer.levelJump).toBe(null);
  });

  it('never produces a fourth session kind', () => {
    const kinds = [
      boot().identity.kind,
      boot({ devFlags: { level: 2 } }).identity.kind,
      boot({ devFlags: { level: 'sandbox' } }).identity.kind,
      boot({ devFlags: { mode: 'ffa' } }).identity.kind,
      boot({ versusConfig: paneConfig() }).identity.kind,
    ];
    for (const k of kinds) {
      expect(['campaign', 'practice-level', 'practice-sandbox', 'versus']).toContain(k);
    }
  });
});

describe('descriptorFor: identity + level -> descriptor', () => {
  it('campaign ignores the ordinal it is handed', () => {
    expect(descriptorFor({ kind: 'campaign' }, 7)).toEqual({ kind: 'campaign' });
  });

  it('practice-level takes its ordinal from the level actually built', () => {
    expect(descriptorFor(practiceLevelIdentity(), 3)).toEqual({
      kind: 'practice',
      target: { kind: 'campaign-level', levelOrdinal: 3 },
    });
  });

  it('practice-sandbox reports no ordinal at all', () => {
    expect(descriptorFor({ kind: 'practice-sandbox' }, 1)).toEqual({
      kind: 'practice',
      target: { kind: 'sandbox' },
    });
  });

  it('versus carries the retained rules through unchanged', () => {
    const ctx = boot({ versusConfig: paneConfig({ arenaId: 'random' }) });
    const d = descriptorFor(ctx.identity, 1);
    expect(d.kind).toBe('versus');
    if (d.kind !== 'versus') throw new Error('unreachable');
    expect(d.rules.arenaSelection).toBe('random');
  });

  it('is a pure function -- the same inputs give an equal descriptor every time', () => {
    // This is what lets loop.ts re-derive on every world build instead of
    // storing a descriptor a transition could forget to update.
    const id: SessionIdentity = practiceLevelIdentity();
    expect(descriptorFor(id, 2)).toEqual(descriptorFor(id, 2));
    expect(descriptorFor(id, 2)).not.toEqual(descriptorFor(id, 3));
  });
});

describe('relaunchTargetFor -- what the buttons do, NOT what is being played', () => {
  it("is 'versus-setup' for a setup-pane versus session", () => {
    expect(relaunchTargetFor(boot({ versusConfig: paneConfig() }))).toBe('versus-setup');
  });

  it("is 'campaign-levels' for a developer-flag versus session, which keeps the campaign LevelSystem", () => {
    // THE DISCRIMINATING CASE, and the whole reason these are two values: the
    // session's IDENTITY is Versus (it builds a genuine FFA world, so its stock
    // strip and typed outcome must say so) while its BUTTONS stay campaign-shaped
    // -- Continue and Levels there still rebuild correct FFA/teams worlds through
    // the campaign level system, and loop.ts's onStartRestart lands this session's
    // finished-match click on a campaign board, so "Versus Setup" would name a pane
    // the click never opens.
    const ctx = boot({ devFlags: { mode: 'ffa' }, developerMode: true });
    expect(ctx.identity.kind).toBe('versus');
    expect(relaunchTargetFor(ctx)).toBe('campaign-levels');
  });

  it("is 'campaign-levels' for campaign, practice and sandbox sessions", () => {
    expect(relaunchTargetFor(boot())).toBe('campaign-levels');
    expect(relaunchTargetFor(boot({ devFlags: { level: 2 } }))).toBe('campaign-levels');
    expect(relaunchTargetFor(boot({ devFlags: { level: 'sandbox' } }))).toBe('campaign-levels');
  });
});

describe('identityForLevelPick', () => {
  it('turns a CAMPAIGN boot into practice-level -- the run-isolating gesture', () => {
    expect(identityForLevelPick(boot().identity)).toEqual(practiceLevelIdentity());
  });

  it('leaves a developer-flag VERSUS boot as versus, rules and all', () => {
    // The Levels button is genuinely reachable here: `?dev=1&mode=ffa` keeps the
    // campaign level system (so `levelChoice` is true and the campaign-shaped title
    // affordances leave the button on screen), and that system's `world()` stamps
    // `flags.mode` on EVERY level it builds. A pick therefore starts another FFA
    // match on a different arena -- not practice on a campaign level.
    const versus = boot({ devFlags: { mode: 'teams', players: 4 }, developerMode: true }).identity;
    expect(versus.kind).toBe('versus');
    expect(identityForLevelPick(versus)).toBe(versus);
  });

  it('leaves the sandbox as practice-sandbox, which has no truthful ordinal', () => {
    const sandbox = boot({ devFlags: { level: 'sandbox' }, developerMode: true }).identity;
    expect(sandbox).toEqual({ kind: 'practice-sandbox' });
    expect(identityForLevelPick(sandbox)).toBe(sandbox);
  });

  it('leaves a developer level jump as practice-level, which it already is', () => {
    const jumped = boot({ devFlags: { level: 3 }, developerMode: true }).identity;
    expect(identityForLevelPick(jumped)).toEqual(practiceLevelIdentity());
  });

  it('leaves a setup-pane versus boot as versus', () => {
    const pane = boot({ versusConfig: paneConfig() }).identity;
    expect(identityForLevelPick(pane)).toBe(pane);
  });
});
