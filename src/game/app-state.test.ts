import { describe, it, expect } from 'vitest';
import type { VersusConfig } from './versus-config';
import {
  campaignCompleteOutcome,
  campaignDescriptor,
  campaignOverOutcome,
  campaignRoute,
  currentDescriptor,
  currentOutcome,
  currentPhase,
  currentRoute,
  currentSession,
  customizeRoute,
  DEV_METADATA_OFF,
  developerToolsRoute,
  hasOutcome,
  isAtRoute,
  isAtRouteKind,
  isInGameplay,
  isPaused,
  isPlaying,
  launchRoute,
  locationAtRoute,
  locationInGameplay,
  mainMenuRoute,
  missionClearOutcome,
  outcomeIsVictory,
  outcomePhase,
  pausedPhase,
  playingPhase,
  practiceDescriptor,
  practiceResultOutcome,
  practiceRoute,
  recordsRoute,
  resolveSession,
  settingsRoute,
  versusDescriptor,
  versusSetupRoute,
  vsMatchEndOutcome,
} from './app-state';

const versusConfigFixture = (overrides: Partial<VersusConfig> = {}): VersusConfig => ({
  mode: 'ffa',
  players: 2,
  arenaId: 'random',
  stock: 3,
  friendlyFire: false,
  ...overrides,
});

describe('AppRoute constructors', () => {
  it('produces one AppRoute value per kind and no others', () => {
    const routes = [
      launchRoute(),
      mainMenuRoute(),
      campaignRoute(),
      practiceRoute(),
      versusSetupRoute(),
      settingsRoute(),
      recordsRoute(),
      customizeRoute(),
      developerToolsRoute(),
    ];
    const kinds = routes.map((r) => r.kind);
    // The exhaustive route family for #316 has nine members; a tenth would
    // silently disappear here if the union expanded without this literal count
    // being updated.
    expect(kinds).toEqual([
      'launch',
      'main-menu',
      'campaign',
      'practice',
      'versus-setup',
      'settings',
      'records',
      'customize',
      'developer-tools',
    ]);
  });

  it('never names a route "title" -- the legacy Main Menu term is retired', () => {
    for (const r of [
      launchRoute(),
      mainMenuRoute(),
      campaignRoute(),
      practiceRoute(),
      versusSetupRoute(),
      settingsRoute(),
      recordsRoute(),
      customizeRoute(),
      developerToolsRoute(),
    ]) {
      expect(r.kind).not.toBe('title');
    }
  });
});

describe('SessionDescriptor construction', () => {
  it('campaignDescriptor: minimal, no configuration', () => {
    expect(campaignDescriptor()).toEqual({ kind: 'campaign' });
  });

  describe('practiceDescriptor', () => {
    it('accepts a 1-based level ordinal', () => {
      expect(practiceDescriptor(1)).toEqual({ kind: 'practice', levelOrdinal: 1 });
      expect(practiceDescriptor(5)).toEqual({ kind: 'practice', levelOrdinal: 5 });
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects ordinal %s',
      (ordinal) => {
        expect(() => practiceDescriptor(ordinal)).toThrow();
      },
    );
  });

  describe('versusDescriptor', () => {
    it('retains random arenaId as-is (arena resolution is a resolveSession-boundary concern)', () => {
      const cfg = versusConfigFixture({ arenaId: 'random' });
      const d = versusDescriptor(cfg);
      expect(d).toEqual({ kind: 'versus', config: cfg });
      expect(d.config.arenaId).toBe('random');
    });

    it('accepts a concrete arenaId too', () => {
      const cfg = versusConfigFixture({ arenaId: 'plaza' });
      expect(versusDescriptor(cfg).config.arenaId).toBe('plaza');
    });

    it.each([1, 5, 0, -1, 2.5])('rejects players=%s', (players) => {
      expect(() =>
        versusDescriptor(versusConfigFixture({ players: players as 2 | 3 | 4 })),
      ).toThrow();
    });

    it('rejects an unknown mode', () => {
      expect(() =>
        versusDescriptor(versusConfigFixture({ mode: 'chaos' as 'ffa' | 'teams' })),
      ).toThrow();
    });

    it.each([0, -1, 1.5])('rejects stock=%s', (stock) => {
      expect(() => versusDescriptor(versusConfigFixture({ stock }))).toThrow();
    });
  });
});

describe('ResolvedSession -- descriptor-vs-instance boundary', () => {
  it('holds the descriptor plus the launch-derived seed/arena', () => {
    const descriptor = campaignDescriptor();
    const session = resolveSession(descriptor, 42, 'plaza');
    expect(session.descriptor).toBe(descriptor);
    expect(session.seed).toBe(42);
    expect(session.arenaId).toBe('plaza');
  });

  it('rejects seed=0 (mulberry32 degeneracy) and non-integer seeds', () => {
    const descriptor = campaignDescriptor();
    expect(() => resolveSession(descriptor, 0, 'plaza')).toThrow();
    expect(() => resolveSession(descriptor, -1, 'plaza')).toThrow();
    expect(() => resolveSession(descriptor, 1.5, 'plaza')).toThrow();
  });

  it("rejects arenaId '' and 'random' -- the resolver must produce a concrete id", () => {
    const descriptor = campaignDescriptor();
    expect(() => resolveSession(descriptor, 42, '')).toThrow();
    expect(() => resolveSession(descriptor, 42, 'random')).toThrow();
  });

  it('a retained descriptor produces distinct resolved instances (rematch)', () => {
    const descriptor = versusDescriptor(versusConfigFixture({ arenaId: 'random' }));
    // A rematch reuses the descriptor, but the two resolved sessions are
    // distinct instances with independent seeds and possibly different resolved
    // arenas -- issue #316's binding "descriptor stays plain intent, resolved
    // instance owns launch-generated data" boundary.
    const a = resolveSession(descriptor, 7, 'plaza');
    const b = resolveSession(descriptor, 8, 'hollow');
    expect(a).not.toBe(b);
    expect(a.descriptor).toBe(descriptor);
    expect(b.descriptor).toBe(descriptor);
    expect(descriptor.config.arenaId).toBe('random');
  });
});

describe('TypedOutcome variants', () => {
  it('constructs the five required outcome kinds', () => {
    expect(missionClearOutcome().kind).toBe('mission-clear');
    expect(campaignOverOutcome().kind).toBe('campaign-over');
    expect(campaignCompleteOutcome().kind).toBe('campaign-complete');
    expect(practiceResultOutcome(true)).toEqual({ kind: 'practice-result', cleared: true });
    expect(practiceResultOutcome(false)).toEqual({ kind: 'practice-result', cleared: false });
    expect(vsMatchEndOutcome(true)).toEqual({ kind: 'vs-match-end', localPlayerWon: true });
    expect(vsMatchEndOutcome(false)).toEqual({ kind: 'vs-match-end', localPlayerWon: false });
  });

  describe('outcomeIsVictory', () => {
    it('classifies each outcome kind', () => {
      expect(outcomeIsVictory(missionClearOutcome())).toBe(true);
      expect(outcomeIsVictory(campaignCompleteOutcome())).toBe(true);
      expect(outcomeIsVictory(campaignOverOutcome())).toBe(false);
      expect(outcomeIsVictory(practiceResultOutcome(true))).toBe(true);
      expect(outcomeIsVictory(practiceResultOutcome(false))).toBe(false);
      expect(outcomeIsVictory(vsMatchEndOutcome(true))).toBe(true);
      expect(outcomeIsVictory(vsMatchEndOutcome(false))).toBe(false);
    });
  });
});

describe('AppLocation -- root discriminant', () => {
  it('an AppRoute and gameplay cannot both hold the primary surface', () => {
    const routeLoc = locationAtRoute(mainMenuRoute());
    expect(routeLoc.kind).toBe('route');
    // Types alone forbid `routeLoc.session`; runtime shape check:
    expect('session' in routeLoc).toBe(false);
    expect('phase' in routeLoc).toBe(false);

    const session = resolveSession(campaignDescriptor(), 42, 'plaza');
    const playLoc = locationInGameplay(session, playingPhase());
    expect(playLoc.kind).toBe('gameplay');
    expect('route' in playLoc).toBe(false);
  });

  it('gameplay phases are separate from location kind', () => {
    const session = resolveSession(campaignDescriptor(), 42, 'plaza');
    const playing = locationInGameplay(session, playingPhase());
    const paused = locationInGameplay(session, pausedPhase());
    const ended = locationInGameplay(session, outcomePhase(missionClearOutcome()));
    expect(isPlaying(playing)).toBe(true);
    expect(isPaused(paused)).toBe(true);
    expect(hasOutcome(ended)).toBe(true);

    // Same session reference across phases -- rematch and pause do not
    // reshape a resolved instance's identity, only its phase.
    expect(playing.kind === 'gameplay' && playing.session).toBe(session);
    expect(paused.kind === 'gameplay' && paused.session).toBe(session);
    expect(ended.kind === 'gameplay' && ended.session).toBe(session);
  });
});

describe('Predicates and accessors', () => {
  const session = resolveSession(campaignDescriptor(), 42, 'plaza');

  it('isAtRoute / isAtRouteKind', () => {
    expect(isAtRoute(locationAtRoute(mainMenuRoute()))).toBe(true);
    expect(isAtRoute(locationInGameplay(session, playingPhase()))).toBe(false);
    expect(isAtRouteKind(locationAtRoute(mainMenuRoute()), 'main-menu')).toBe(true);
    expect(isAtRouteKind(locationAtRoute(mainMenuRoute()), 'launch')).toBe(false);
  });

  it('isInGameplay / isPlaying / isPaused / hasOutcome', () => {
    const routeLoc = locationAtRoute(mainMenuRoute());
    expect(isInGameplay(routeLoc)).toBe(false);
    expect(isPlaying(routeLoc)).toBe(false);
    expect(isPaused(routeLoc)).toBe(false);
    expect(hasOutcome(routeLoc)).toBe(false);

    const playing = locationInGameplay(session, playingPhase());
    expect(isInGameplay(playing)).toBe(true);
    expect(isPlaying(playing)).toBe(true);
    expect(isPaused(playing)).toBe(false);
    expect(hasOutcome(playing)).toBe(false);

    const paused = locationInGameplay(session, pausedPhase());
    expect(isPlaying(paused)).toBe(false);
    expect(isPaused(paused)).toBe(true);

    const ended = locationInGameplay(session, outcomePhase(vsMatchEndOutcome(false)));
    expect(hasOutcome(ended)).toBe(true);
    expect(isPlaying(ended)).toBe(false);
  });

  it('currentRoute / currentDescriptor / currentSession / currentPhase / currentOutcome', () => {
    const routeLoc = locationAtRoute(settingsRoute());
    expect(currentRoute(routeLoc)?.kind).toBe('settings');
    expect(currentDescriptor(routeLoc)).toBe(null);
    expect(currentSession(routeLoc)).toBe(null);
    expect(currentPhase(routeLoc)).toBe(null);
    expect(currentOutcome(routeLoc)).toBe(null);

    const playing = locationInGameplay(session, playingPhase());
    expect(currentRoute(playing)).toBe(null);
    expect(currentDescriptor(playing)?.kind).toBe('campaign');
    expect(currentSession(playing)).toBe(session);
    expect(currentPhase(playing)?.kind).toBe('playing');
    expect(currentOutcome(playing)).toBe(null);

    const ended = locationInGameplay(session, outcomePhase(missionClearOutcome()));
    expect(currentOutcome(ended)?.kind).toBe('mission-clear');
  });
});

describe('DeveloperMetadata -- orthogonal to descriptors', () => {
  it('DEV_METADATA_OFF is inert', () => {
    expect(DEV_METADATA_OFF.active).toBe(false);
    expect(DEV_METADATA_OFF.sessionOrigin).toBe(null);
  });

  it('developer mode does not add a fourth session kind', () => {
    // The union has EXACTLY three kinds -- Campaign, Practice, Versus.
    // Developer entry produces one of those descriptors, carrying dev
    // metadata separately (issue #316 binding).
    const kinds: Array<'campaign' | 'practice' | 'versus'> = [
      campaignDescriptor().kind,
      practiceDescriptor(1).kind,
      versusDescriptor(versusConfigFixture()).kind,
    ];
    expect(kinds).toEqual(['campaign', 'practice', 'versus']);
  });
});
