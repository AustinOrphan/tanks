import { describe, it, expect, vi } from 'vitest';
import { defaultSlots } from './versus-setup';
import {
  APP_ROUTE_KINDS,
  campaignDescriptor,
  launchRoute,
  locationAtRoute,
  practiceLevelDescriptor,
  resolveSession,
  versusDescriptor,
  versusDraw,
  versusRulesFromConfig,
  versusWinnerSlot,
  versusWinnerTeam,
} from './app-state';
import type { AppLocation, VersusResult } from './app-state';
import type { VersusConfig } from './versus-config';
import { createGameStateMachine, createOutcomeClassifier } from './state';

/**
 * The classifier every machine in this file is built with unless a case needs
 * different context. Campaign completion off, and a versus result that is
 * clearly attributable so a test can tell it apart from a fabricated one.
 */
const testClassifier = (
  opts: { final?: boolean; result?: VersusResult } = {},
) =>
  createOutcomeClassifier({
    isFinalCampaignLevel: () => opts.final ?? false,
    versusResult: () => opts.result ?? versusWinnerSlot(0),
  });

const makeMachine = (opts: { final?: boolean; result?: VersusResult } = {}) =>
  createGameStateMachine({ classifyOutcome: testClassifier(opts) });

const versusConfigFixture = (overrides: Partial<VersusConfig> = {}): VersusConfig => ({
  mode: 'ffa',
  players: 2,
  arenaId: 'random',
  stock: 3,
  friendlyFire: false,
  ...overrides, slots: defaultSlots(2) });

const buildCampaignSession = () =>
  resolveSession(campaignDescriptor(), 42, 'plaza');

const buildPracticeSession = () =>
  resolveSession(practiceLevelDescriptor(2), 43, 'hollow');

const buildVersusSession = () =>
  resolveSession(versusDescriptor(versusRulesFromConfig(versusConfigFixture())), 44, 'plaza');

describe('createGameStateMachine -- initial location', () => {
  it('starts at the Launch route', () => {
    const sm = makeMachine();
    expect(sm.location).toEqual(locationAtRoute(launchRoute()));
    expect(sm.atLaunch).toBe(true);
    expect(sm.atMainMenu).toBe(false);
    expect(sm.inGameplay).toBe(false);
    expect(sm.isPlaying).toBe(false);
    expect(sm.isPaused).toBe(false);
    expect(sm.hasOutcome).toBe(false);
    expect(sm.isSimulating).toBe(false);
  });
});

describe('dismissLaunch -- guarded launch -> main menu', () => {
  it('moves launch -> main menu', () => {
    const sm = makeMachine();
    sm.dismissLaunch();
    expect(sm.atMainMenu).toBe(true);
    expect(sm.route?.kind).toBe('main-menu');
  });

  it('does nothing from anywhere except the Launch route', () => {
    const session = buildCampaignSession();
    for (const drive of [
      (sm: ReturnType<typeof makeMachine>) => {
        sm.dismissLaunch();
      },
      (sm: ReturnType<typeof makeMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
      },
      (sm: ReturnType<typeof makeMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
        sm.pause();
      },
      (sm: ReturnType<typeof makeMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
        sm.onEvents([{ type: 'win' }]);
      },
      (sm: ReturnType<typeof makeMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
        sm.onEvents([{ type: 'lose' }]);
      },
      (sm: ReturnType<typeof makeMachine>) => {
        sm.dismissLaunch();
        sm.toRoute('settings');
      },
    ]) {
      const sm = makeMachine();
      drive(sm);
      const before = sm.location;
      sm.dismissLaunch();
      expect(sm.location, 'dismissLaunch changed a non-launch location').toBe(before);
    }
  });
});

describe('Route transitions -- toMainMenu and toRoute', () => {
  it('toMainMenu reaches Main Menu from anywhere (navigation-only)', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    expect(sm.atMainMenu).toBe(true);

    sm.enterGameplay(buildCampaignSession());
    sm.toMainMenu();
    expect(sm.atMainMenu).toBe(true);
  });

  it('toRoute reaches every AppRoute kind explicitly', () => {
    const sm = makeMachine();
    for (const kind of [
      'launch',
      'main-menu',
      'campaign',
      'practice',
      'versus-setup',
      'settings',
      'records',
      'customize',
      'developer-tools',
    ] as const) {
      sm.toRoute(kind);
      expect(sm.route?.kind).toBe(kind);
    }
  });

  it('never produces a route named "title" for Main Menu', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    expect(sm.route?.kind).toBe('main-menu');
    expect(sm.route?.kind).not.toBe('title');
  });
});

describe('enterGameplay -- descriptor-vs-resolved-instance boundary', () => {
  it('enters gameplay with a resolved session, phase = playing', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    const session = buildCampaignSession();
    sm.enterGameplay(session);
    expect(sm.inGameplay).toBe(true);
    expect(sm.isPlaying).toBe(true);
    expect(sm.session).toBe(session);
    expect(sm.descriptor).toBe(session.descriptor);
  });

  it('legal from any route', () => {
    for (const kind of [
      'launch',
      'main-menu',
      'campaign',
      'practice',
      'versus-setup',
      'settings',
      'records',
      'customize',
      'developer-tools',
    ] as const) {
      const sm = makeMachine();
      sm.toRoute(kind);
      sm.enterGameplay(buildCampaignSession());
      expect(sm.isPlaying).toBe(true);
    }
  });

  it('legal from an outcome phase -- rematch reuses the descriptor', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    const descriptor = versusDescriptor(versusRulesFromConfig(versusConfigFixture({ arenaId: 'random' })));
    const first = resolveSession(descriptor, 7, 'plaza');
    sm.enterGameplay(first);
    sm.onEvents([{ type: 'win' }]);
    expect(sm.hasOutcome).toBe(true);
    const second = resolveSession(descriptor, 8, 'hollow');
    sm.enterGameplay(second);
    // Same descriptor, different resolved instance -- the descriptor was NOT
    // mutated into a mixture of retained intent and launch result.
    expect(sm.session).toBe(second);
    expect(sm.descriptor).toBe(descriptor);
    expect(descriptor.rules.arenaSelection).toBe('random');
  });

  it('illegal from the playing phase -- the running session must be ended first', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    expect(() => sm.enterGameplay(buildPracticeSession())).toThrow();
  });

  it('illegal from the paused phase -- same reason', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.pause();
    expect(() => sm.enterGameplay(buildPracticeSession())).toThrow();
  });
});

describe('pause / resume -- phase transitions', () => {
  it('pauses only from playing', () => {
    const sm = makeMachine();
    sm.pause();
    expect(sm.atLaunch).toBe(true); // launch is not pausable
    sm.dismissLaunch();
    sm.pause();
    expect(sm.atMainMenu).toBe(true); // a menu is not pausable either
    sm.enterGameplay(buildCampaignSession());
    sm.pause();
    expect(sm.isPaused).toBe(true);
  });

  it('resumes only from paused', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.resume();
    expect(sm.isPlaying).toBe(true); // no-op, not a crash
    sm.pause();
    sm.resume();
    expect(sm.isPlaying).toBe(true);
  });

  it('cannot pause a finished session into a zombie state', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'lose' }]);
    sm.pause();
    expect(sm.hasOutcome).toBe(true);
    expect(sm.outcome?.kind).toBe('campaign-over');
  });

  it('paused ignores win/lose events -- the sim is not stepping', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.pause();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.isPaused).toBe(true);
    expect(sm.hasOutcome).toBe(false);
  });

  it('preserves the resolved session across pause/resume', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    const session = buildCampaignSession();
    sm.enterGameplay(session);
    sm.pause();
    expect(sm.session).toBe(session);
    sm.resume();
    expect(sm.session).toBe(session);
  });
});

describe('onEvents -- typed outcome classification', () => {
  it('reacts only to the first terminal event in a batch', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'win' }, { type: 'lose' }]);
    expect(sm.outcome?.kind).toBe('mission-clear');
  });

  it('ignores win/lose from a route -- no session to end', () => {
    const sm = makeMachine();
    sm.onEvents([{ type: 'win' }]);
    expect(sm.atLaunch).toBe(true);
    sm.toMainMenu();
    sm.onEvents([{ type: 'win' }]);
    expect(sm.atMainMenu).toBe(true);
  });

  describe('campaign: Mission Clear vs Campaign Complete', () => {
    const drive = (opts: { final: boolean }, ev: 'win' | 'lose') => {
      const sm = makeMachine({ final: opts.final });
      sm.toMainMenu();
      sm.enterGameplay(buildCampaignSession());
      sm.onEvents([{ type: ev }]);
      return sm;
    };

    it('an intermediate clear is mission-clear', () => {
      expect(drive({ final: false }, 'win').outcome?.kind).toBe('mission-clear');
    });

    it('the FINAL level clear is campaign-complete, not mission-clear', () => {
      // Issue #316's finding 1: the two must be distinguishable, and the
      // difference comes from caller-side context, not the descriptor.
      expect(drive({ final: true }, 'win').outcome?.kind).toBe('campaign-complete');
    });

    it('a loss is campaign-over regardless of which level it happened on', () => {
      expect(drive({ final: false }, 'lose').outcome?.kind).toBe('campaign-over');
      expect(drive({ final: true }, 'lose').outcome?.kind).toBe('campaign-over');
    });
  });

  describe('practice', () => {
    const drive = (ev: 'win' | 'lose') => {
      const sm = makeMachine();
      sm.toMainMenu();
      sm.enterGameplay(buildPracticeSession());
      sm.onEvents([{ type: ev }]);
      return sm;
    };

    it('maps win/lose to a cleared flag, never to campaign outcomes', () => {
      expect(drive('win').outcome).toEqual({ kind: 'practice-result', cleared: true });
      expect(drive('lose').outcome).toEqual({ kind: 'practice-result', cleared: false });
    });

    it('a final-level practice clear is still a practice result, not campaign-complete', () => {
      const sm = makeMachine({ final: true });
      sm.toMainMenu();
      sm.enterGameplay(buildPracticeSession());
      sm.onEvents([{ type: 'win' }]);
      expect(sm.outcome?.kind).toBe('practice-result');
    });
  });

  describe('versus: attributed results, never a local-player guess', () => {
    const drive = (result: VersusResult, ev: 'win' | 'lose') => {
      const sm = makeMachine({ result });
      sm.toMainMenu();
      sm.enterGameplay(buildVersusSession());
      sm.onEvents([{ type: ev }]);
      return sm;
    };

    it('FFA where P2 wins reports slot 1, not a local-player victory', () => {
      // The exact case the retired `localPlayerWon: true` shape mis-stated.
      expect(drive(versusWinnerSlot(1), 'win').outcome).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'winner-slot', slot: 1 },
      });
    });

    it('FFA where a later slot wins reports THAT slot', () => {
      expect(drive(versusWinnerSlot(3), 'win').outcome).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'winner-slot', slot: 3 },
      });
    });

    it.each([0, 1])('Teams where team %s wins reports that team', (team) => {
      expect(drive(versusWinnerTeam(team), 'win').outcome).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'winner-team', team },
      });
    });

    it('a simultaneous elimination is a DRAW, not a defeat for a seat', () => {
      // The sim emits `lose` when ZERO remain. The classifier must not consult
      // the derived winner at all on that path.
      expect(drive(versusWinnerSlot(2), 'lose').outcome).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'draw' },
      });
    });

    it('a decided match presents as a win and a draw as a loss', () => {
      expect(drive(versusWinnerSlot(2), 'win').presentsAsWin).toBe(true);
      expect(drive(versusDraw(), 'lose').presentsAsLose).toBe(true);
    });
  });

  it('a batch with no terminal event leaves the phase alone', () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'explosion', pos: { x: 0, y: 0 } }]);
    expect(sm.isPlaying).toBe(true);
    expect(sm.hasOutcome).toBe(false);
  });
});

describe('onChange -- subscription', () => {
  it('fires exactly on transitions', () => {
    const sm = makeMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.dismissLaunch();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'win' }]);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('does not fire onChange when the location is unchanged', () => {
    const sm = makeMachine();
    sm.dismissLaunch();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.toMainMenu(); // already at main-menu
    expect(cb).not.toHaveBeenCalled();
  });

  it('emits the new AppLocation payload to subscribers', () => {
    const sm = makeMachine();
    const seen: AppLocation[] = [];
    sm.onChange((loc) => seen.push(loc));
    sm.dismissLaunch();
    sm.toRoute('settings');
    expect(seen.map((l) => l.kind === 'route' ? l.route.kind : 'gameplay')).toEqual([
      'main-menu',
      'settings',
    ]);
  });
});

describe('Navigation-only transitions are pure state (issue #316 acceptance)', () => {
  it('toMainMenu and toRoute never invoke the outcome classifier -- the machine\'s only injected collaborator', () => {
    // The state model owns no seed source, no level system and no store, so the
    // only way a transition here could reach outside itself is the one function
    // it is constructed with. Watching that call count is what makes "state
    // only" a MEASURED claim rather than a structural assertion about code a
    // reader has to take on trust.
    //
    // Fails if any route transition is ever wired to classify, resolve or
    // otherwise consult caller context on the way past.
    const classify = vi.fn(() => null);
    const sm = createGameStateMachine({ classifyOutcome: classify });
    sm.dismissLaunch();
    sm.toMainMenu();
    for (const kind of APP_ROUTE_KINDS) sm.toRoute(kind);
    expect(classify).not.toHaveBeenCalled();

    // ...including on the way OUT of live gameplay, which is how Quit navigates.
    sm.enterGameplay(buildCampaignSession());
    expect(classify).not.toHaveBeenCalled();
    sm.toMainMenu();
    sm.toRoute('settings');
    expect(classify).not.toHaveBeenCalled();
  });

  it('a route transition retains no part of the session it left', () => {
    // The other half of "creates no resolved instance": not just that nothing NEW
    // was resolved, but that the abandoned instance is not still owned as the
    // primary surface. Disposing anything world-side is the caller's job (see
    // toRoute's own doc comment); the MODEL keeps nothing.
    const sm = makeMachine();
    sm.toMainMenu();
    const session = buildCampaignSession();
    sm.enterGameplay(session);
    expect(sm.session).toBe(session);
    sm.toRoute('records');
    expect(sm.session).toBe(null);
    expect(sm.descriptor).toBe(null);
    expect(sm.phase).toBe(null);
    expect(sm.outcome).toBe(null);
  });
});

describe('Navigation-only transitions do not resolve or persist', () => {
  it("dismissLaunch, toMainMenu, toRoute never own a session", () => {
    const sm = makeMachine();
    sm.dismissLaunch();
    expect(sm.session).toBe(null);
    sm.toMainMenu();
    expect(sm.session).toBe(null);
    sm.toRoute('settings');
    expect(sm.session).toBe(null);
  });

  it("toMainMenu from within gameplay does NOT dispose the session --" +
      " it hands the display back to the route. Session cleanup is a caller concern.", () => {
    const sm = makeMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.toMainMenu();
    expect(sm.atMainMenu).toBe(true);
    expect(sm.session).toBe(null);
    expect(sm.descriptor).toBe(null);
  });
});
