import { describe, it, expect } from 'vitest';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import type { VersusConfig } from './versus-config';
import {
  descriptorFor,
  practiceLevelIdentity,
  resolveBootSessionContext,
  usesVersusTitleAffordances,
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
  ...o,
});

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

describe('usesVersusTitleAffordances', () => {
  it('is true for a setup-pane versus session', () => {
    expect(usesVersusTitleAffordances(boot({ versusConfig: paneConfig() }))).toBe(true);
  });

  it('is FALSE for a developer-flag versus session, which keeps the campaign LevelSystem', () => {
    // Continue and Levels still rebuild correct FFA/teams worlds there, so
    // hiding them would remove working affordances. The descriptor still
    // reports Versus -- these two questions are deliberately separate.
    const ctx = boot({ devFlags: { mode: 'ffa' }, developerMode: true });
    expect(ctx.identity.kind).toBe('versus');
    expect(usesVersusTitleAffordances(ctx)).toBe(false);
  });

  it('is false for campaign, practice and sandbox sessions', () => {
    expect(usesVersusTitleAffordances(boot())).toBe(false);
    expect(usesVersusTitleAffordances(boot({ devFlags: { level: 2 } }))).toBe(false);
    expect(usesVersusTitleAffordances(boot({ devFlags: { level: 'sandbox' } }))).toBe(false);
  });
});
