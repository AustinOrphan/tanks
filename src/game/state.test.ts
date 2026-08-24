import { describe, it, expect, vi } from 'vitest';
import {
  campaignDescriptor,
  launchRoute,
  locationAtRoute,
  practiceDescriptor,
  resolveSession,
  versusDescriptor,
} from './app-state';
import type { AppLocation } from './app-state';
import type { VersusConfig } from './versus-config';
import {
  classifyWithCampaignCompletion,
  createGameStateMachine,
  defaultOutcomeClassifier,
} from './state';

const versusConfigFixture = (overrides: Partial<VersusConfig> = {}): VersusConfig => ({
  mode: 'ffa',
  players: 2,
  arenaId: 'random',
  stock: 3,
  friendlyFire: false,
  ...overrides,
});

const buildCampaignSession = () =>
  resolveSession(campaignDescriptor(), 42, 'plaza');

const buildPracticeSession = () =>
  resolveSession(practiceDescriptor(2), 43, 'hollow');

const buildVersusSession = () =>
  resolveSession(versusDescriptor(versusConfigFixture()), 44, 'plaza');

describe('createGameStateMachine -- initial location', () => {
  it('starts at the Launch route', () => {
    const sm = createGameStateMachine();
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
    const sm = createGameStateMachine();
    sm.dismissLaunch();
    expect(sm.atMainMenu).toBe(true);
    expect(sm.route?.kind).toBe('main-menu');
  });

  it('does nothing from anywhere except the Launch route', () => {
    const session = buildCampaignSession();
    for (const drive of [
      (sm: ReturnType<typeof createGameStateMachine>) => {
        sm.dismissLaunch();
      },
      (sm: ReturnType<typeof createGameStateMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
      },
      (sm: ReturnType<typeof createGameStateMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
        sm.pause();
      },
      (sm: ReturnType<typeof createGameStateMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
        sm.onEvents([{ type: 'win' }]);
      },
      (sm: ReturnType<typeof createGameStateMachine>) => {
        sm.dismissLaunch();
        sm.enterGameplay(session);
        sm.onEvents([{ type: 'lose' }]);
      },
      (sm: ReturnType<typeof createGameStateMachine>) => {
        sm.dismissLaunch();
        sm.toRoute('settings');
      },
    ]) {
      const sm = createGameStateMachine();
      drive(sm);
      const before = sm.location;
      sm.dismissLaunch();
      expect(sm.location, 'dismissLaunch changed a non-launch location').toBe(before);
    }
  });
});

describe('Route transitions -- toMainMenu and toRoute', () => {
  it('toMainMenu reaches Main Menu from anywhere (navigation-only)', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    expect(sm.atMainMenu).toBe(true);

    sm.enterGameplay(buildCampaignSession());
    sm.toMainMenu();
    expect(sm.atMainMenu).toBe(true);
  });

  it('toRoute reaches every AppRoute kind explicitly', () => {
    const sm = createGameStateMachine();
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
    const sm = createGameStateMachine();
    sm.toMainMenu();
    expect(sm.route?.kind).toBe('main-menu');
    expect(sm.route?.kind).not.toBe('title');
  });
});

describe('enterGameplay -- descriptor-vs-resolved-instance boundary', () => {
  it('enters gameplay with a resolved session, phase = playing', () => {
    const sm = createGameStateMachine();
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
      const sm = createGameStateMachine();
      sm.toRoute(kind);
      sm.enterGameplay(buildCampaignSession());
      expect(sm.isPlaying).toBe(true);
    }
  });

  it('legal from an outcome phase -- rematch reuses the descriptor', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    const descriptor = versusDescriptor(versusConfigFixture({ arenaId: 'random' }));
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
    expect(descriptor.config.arenaId).toBe('random');
  });

  it('illegal from the playing phase -- the running session must be ended first', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    expect(() => sm.enterGameplay(buildPracticeSession())).toThrow();
  });

  it('illegal from the paused phase -- same reason', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.pause();
    expect(() => sm.enterGameplay(buildPracticeSession())).toThrow();
  });
});

describe('pause / resume -- phase transitions', () => {
  it('pauses only from playing', () => {
    const sm = createGameStateMachine();
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
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.resume();
    expect(sm.isPlaying).toBe(true); // no-op, not a crash
    sm.pause();
    sm.resume();
    expect(sm.isPlaying).toBe(true);
  });

  it('cannot pause a finished session into a zombie state', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'lose' }]);
    sm.pause();
    expect(sm.hasOutcome).toBe(true);
    expect(sm.outcome?.kind).toBe('campaign-over');
  });

  it('paused ignores win/lose events -- the sim is not stepping', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.pause();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.isPaused).toBe(true);
    expect(sm.hasOutcome).toBe(false);
  });

  it('preserves the resolved session across pause/resume', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    const session = buildCampaignSession();
    sm.enterGameplay(session);
    sm.pause();
    expect(sm.session).toBe(session);
    sm.resume();
    expect(sm.session).toBe(session);
  });
});

describe('restart -- outcome -> playing', () => {
  it('restart from an outcome phase re-enters playing on the same session', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    const session = buildCampaignSession();
    sm.enterGameplay(session);
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.hasOutcome).toBe(true);
    sm.restart();
    expect(sm.isPlaying).toBe(true);
    expect(sm.session).toBe(session);
  });

  it('restart from playing or paused is a no-op', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    const before = sm.location;
    sm.restart();
    expect(sm.location).toBe(before);
    sm.pause();
    const paused = sm.location;
    sm.restart();
    expect(sm.location).toBe(paused);
  });

  it('restart from a route is a no-op', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    const before = sm.location;
    sm.restart();
    expect(sm.location).toBe(before);
  });
});

describe('onEvents -- typed outcome classification', () => {
  it('reacts only to the first terminal event in a batch', () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'win' }, { type: 'lose' }]);
    expect(sm.outcome?.kind).toBe('mission-clear');
  });

  it('ignores win/lose from a route -- no session to end', () => {
    const sm = createGameStateMachine();
    sm.onEvents([{ type: 'win' }]);
    expect(sm.atLaunch).toBe(true);
    sm.toMainMenu();
    sm.onEvents([{ type: 'win' }]);
    expect(sm.atMainMenu).toBe(true);
  });

  it('default classifier: campaign win -> mission-clear', () => {
    const session = buildCampaignSession();
    const outcome = defaultOutcomeClassifier([{ type: 'win' }], session);
    expect(outcome?.kind).toBe('mission-clear');
  });

  it('default classifier: campaign lose -> campaign-over', () => {
    const session = buildCampaignSession();
    const outcome = defaultOutcomeClassifier([{ type: 'lose' }], session);
    expect(outcome?.kind).toBe('campaign-over');
  });

  it('default classifier: practice win -> practice-result cleared', () => {
    const session = buildPracticeSession();
    expect(defaultOutcomeClassifier([{ type: 'win' }], session)).toEqual({
      kind: 'practice-result',
      cleared: true,
    });
    expect(defaultOutcomeClassifier([{ type: 'lose' }], session)).toEqual({
      kind: 'practice-result',
      cleared: false,
    });
  });

  it('default classifier: versus win/lose -> vs-match-end with localPlayerWon', () => {
    const session = buildVersusSession();
    expect(defaultOutcomeClassifier([{ type: 'win' }], session)).toEqual({
      kind: 'vs-match-end',
      localPlayerWon: true,
    });
    expect(defaultOutcomeClassifier([{ type: 'lose' }], session)).toEqual({
      kind: 'vs-match-end',
      localPlayerWon: false,
    });
  });

  it('default classifier: no terminal event -> null', () => {
    const session = buildCampaignSession();
    expect(defaultOutcomeClassifier([], session)).toBe(null);
    expect(
      defaultOutcomeClassifier(
        [{ type: 'explosion', pos: { x: 0, y: 0 } }],
        session,
      ),
    ).toBe(null);
  });

  it('classifyWithCampaignCompletion: last level clear -> campaign-complete', () => {
    const classify = classifyWithCampaignCompletion(() => true);
    const session = buildCampaignSession();
    expect(classify([{ type: 'win' }], session)?.kind).toBe('campaign-complete');
  });

  it('classifyWithCampaignCompletion: intermediate clear -> mission-clear', () => {
    const classify = classifyWithCampaignCompletion(() => false);
    const session = buildCampaignSession();
    expect(classify([{ type: 'win' }], session)?.kind).toBe('mission-clear');
  });

  it('classifyWithCampaignCompletion: lose -> campaign-over regardless of final-level predicate', () => {
    const finalClassify = classifyWithCampaignCompletion(() => true);
    const midClassify = classifyWithCampaignCompletion(() => false);
    const session = buildCampaignSession();
    expect(finalClassify([{ type: 'lose' }], session)?.kind).toBe('campaign-over');
    expect(midClassify([{ type: 'lose' }], session)?.kind).toBe('campaign-over');
  });

  it('a caller-supplied classifier is used by the state machine', () => {
    const sm = createGameStateMachine({
      classifyOutcome: classifyWithCampaignCompletion(() => true),
    });
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'win' }]);
    expect(sm.outcome?.kind).toBe('campaign-complete');
  });
});

describe('onChange -- subscription', () => {
  it('fires exactly on transitions', () => {
    const sm = createGameStateMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.dismissLaunch();
    sm.enterGameplay(buildCampaignSession());
    sm.onEvents([{ type: 'win' }]);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('does not fire onChange when the location is unchanged', () => {
    const sm = createGameStateMachine();
    sm.dismissLaunch();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.toMainMenu(); // already at main-menu
    expect(cb).not.toHaveBeenCalled();
  });

  it('emits the new AppLocation payload to subscribers', () => {
    const sm = createGameStateMachine();
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

describe('Navigation-only transitions do not resolve or persist', () => {
  it("dismissLaunch, toMainMenu, toRoute never own a session", () => {
    const sm = createGameStateMachine();
    sm.dismissLaunch();
    expect(sm.session).toBe(null);
    sm.toMainMenu();
    expect(sm.session).toBe(null);
    sm.toRoute('settings');
    expect(sm.session).toBe(null);
  });

  it("toMainMenu from within gameplay does NOT dispose the session --" +
      " it hands the display back to the route. Session cleanup is a caller concern.", () => {
    const sm = createGameStateMachine();
    sm.toMainMenu();
    sm.enterGameplay(buildCampaignSession());
    sm.toMainMenu();
    expect(sm.atMainMenu).toBe(true);
    expect(sm.session).toBe(null);
    expect(sm.descriptor).toBe(null);
  });
});
