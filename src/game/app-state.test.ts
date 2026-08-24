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
  legacyOutcomePresentation,
  outcomePhase,
  pausedPhase,
  playingPhase,
  practiceLevelDescriptor,
  practiceSandboxDescriptor,
  practiceResultOutcome,
  practiceRoute,
  recordsRoute,
  resolveSession,
  settingsRoute,
  versusDescriptor,
  versusRulesFromConfig,
  versusRulesFromDeveloperFlags,
  versusWinnerSlot,
  versusWinnerTeam,
  versusDraw,
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

  describe('practice targets', () => {
    it('a campaign-level target carries its 1-based ordinal', () => {
      expect(practiceLevelDescriptor(1)).toEqual({
        kind: 'practice',
        target: { kind: 'campaign-level', levelOrdinal: 1 },
      });
      expect(practiceLevelDescriptor(5).target).toEqual({
        kind: 'campaign-level',
        levelOrdinal: 5,
      });
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects ordinal %s',
      (ordinal) => {
        expect(() => practiceLevelDescriptor(ordinal)).toThrow();
      },
    );

    it('a sandbox target carries NO ordinal -- the sandbox is in no campaign sequence', () => {
      const d = practiceSandboxDescriptor();
      expect(d).toEqual({ kind: 'practice', target: { kind: 'sandbox' } });
      // The specific untruth the old bare-`levelOrdinal` shape forced: the
      // sandbox's synthetic level is not a member of CAMPAIGN_LEVELS, so ANY
      // number reported here would be fabricated.
      expect('levelOrdinal' in d.target).toBe(false);
    });

    it('sandbox and level practice are the same session KIND, not a fourth one', () => {
      expect(practiceSandboxDescriptor().kind).toBe('practice');
      expect(practiceLevelDescriptor(3).kind).toBe('practice');
    });
  });

  describe('versus rules -- retained intent is an immutable snapshot', () => {
    it('snapshots the pane config, retaining an UNRESOLVED random selection', () => {
      const cfg = versusConfigFixture({ arenaId: 'random' });
      const rules = versusRulesFromConfig(cfg);
      expect(rules.arenaSelection).toBe('random');
      expect(rules.mode).toBe('ffa');
      expect(rules.players).toBe(2);
      expect(rules.stock).toBe(3);
    });

    it('a later mutation of the caller\'s config cannot alter retained intent', () => {
      // The exact defect this shape exists to prevent: the setup pane keeps a
      // long-lived mutable `versusConfigState` it edits across rematches, and
      // holding that object by reference let a later pane edit silently rewrite
      // the intent of a session already in progress.
      const cfg = versusConfigFixture({ arenaId: 'random', players: 2 });
      const d = versusDescriptor(versusRulesFromConfig(cfg));
      cfg.arenaId = 'plaza';
      cfg.players = 4;
      expect(d.rules.arenaSelection).toBe('random');
      expect(d.rules.players).toBe(2);
    });

    it('the retained rules object is frozen', () => {
      const rules = versusRulesFromConfig(versusConfigFixture());
      expect(Object.isFrozen(rules)).toBe(true);
      expect(Object.isFrozen(versusDescriptor(rules))).toBe(true);
    });

    it('accepts a concrete arena selection too', () => {
      expect(versusRulesFromConfig(versusConfigFixture({ arenaId: 'plaza' })).arenaSelection)
        .toBe('plaza');
    });

    it.each([1, 5, 0, -1, 2.5])('rejects pane players=%s', (players) => {
      expect(() =>
        versusRulesFromConfig(versusConfigFixture({ players: players as 2 | 3 | 4 })),
      ).toThrow();
    });

    it('rejects an unknown mode', () => {
      expect(() =>
        versusRulesFromConfig(versusConfigFixture({ mode: 'chaos' as 'ffa' | 'teams' })),
      ).toThrow();
    });

    it.each([0, -1, 1.5])('rejects stock=%s', (stock) => {
      expect(() => versusRulesFromConfig(versusConfigFixture({ stock }))).toThrow();
    });
  });

  describe('versus rules from developer flags', () => {
    it('records null stock and null arena selection rather than fabricating them', () => {
      // Neither is expressible as a developer flag. Inventing a plausible
      // default here would be the same class of untruth `localPlayerWon` was.
      const rules = versusRulesFromDeveloperFlags({
        mode: 'ffa',
        players: 1,
        friendlyFire: false,
      });
      expect(rules.stock).toBe(null);
      expect(rules.arenaSelection).toBe(null);
    });

    it('permits a ONE-slot versus world, which ?dev=1&mode=ffa really builds', () => {
      expect(versusRulesFromDeveloperFlags({ mode: 'ffa', players: 1, friendlyFire: false })
        .players).toBe(1);
    });

    it.each([0, 5, -1, 2.5])('rejects players=%s', (players) => {
      expect(() =>
        versusRulesFromDeveloperFlags({ mode: 'ffa', players, friendlyFire: false }),
      ).toThrow();
    });

    it('carries teams + friendly fire through unchanged', () => {
      const rules = versusRulesFromDeveloperFlags({
        mode: 'teams',
        players: 4,
        friendlyFire: true,
      });
      expect(rules.mode).toBe('teams');
      expect(rules.friendlyFire).toBe(true);
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

  it('a retained Random descriptor produces distinct resolved instances (rematch)', () => {
    const descriptor = versusDescriptor(
      versusRulesFromConfig(versusConfigFixture({ arenaId: 'random' })),
    );
    const a = resolveSession(descriptor, 7, 'plaza');
    const b = resolveSession(descriptor, 8, 'hollow');
    expect(a).not.toBe(b);
    expect(a.descriptor).toBe(descriptor);
    expect(b.descriptor).toBe(descriptor);
    // The retained selection is STILL 'random' after both launches.
    expect(descriptor.rules.arenaSelection).toBe('random');
  });
});

describe('TypedOutcome variants', () => {
  it('constructs the five required outcome kinds', () => {
    expect(missionClearOutcome().kind).toBe('mission-clear');
    expect(campaignOverOutcome().kind).toBe('campaign-over');
    expect(campaignCompleteOutcome().kind).toBe('campaign-complete');
    expect(practiceResultOutcome(true)).toEqual({ kind: 'practice-result', cleared: true });
    expect(practiceResultOutcome(false)).toEqual({ kind: 'practice-result', cleared: false });
  });

  describe('versus results are attributed, never a local-player boolean', () => {
    it('names the surviving SLOT in FFA', () => {
      expect(vsMatchEndOutcome(versusWinnerSlot(2))).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'winner-slot', slot: 2 },
      });
    });

    it('names the surviving TEAM in teams', () => {
      expect(vsMatchEndOutcome(versusWinnerTeam(1))).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'winner-team', team: 1 },
      });
    });

    it('reports a DRAW for a simultaneous elimination', () => {
      expect(vsMatchEndOutcome(versusDraw())).toEqual({
        kind: 'vs-match-end',
        result: { kind: 'draw' },
      });
    });

    it('carries no field asserting that the local player won', () => {
      // The retired shape was `{ kind: 'vs-match-end', localPlayerWon: boolean }`,
      // which turned every decided couch match into a P1 victory claim.
      const outcome = vsMatchEndOutcome(versusWinnerSlot(3));
      expect('localPlayerWon' in outcome).toBe(false);
    });

    it.each([-1, 1.5])('rejects slot/team %s', (n) => {
      expect(() => versusWinnerSlot(n)).toThrow();
      expect(() => versusWinnerTeam(n)).toThrow();
    });
  });

  describe('legacyOutcomePresentation -- the named compatibility projection', () => {
    it('maps campaign and practice outcomes onto the shipped win/lose pair', () => {
      expect(legacyOutcomePresentation(missionClearOutcome())).toBe('win');
      expect(legacyOutcomePresentation(campaignCompleteOutcome())).toBe('win');
      expect(legacyOutcomePresentation(campaignOverOutcome())).toBe('lose');
      expect(legacyOutcomePresentation(practiceResultOutcome(true))).toBe('win');
      expect(legacyOutcomePresentation(practiceResultOutcome(false))).toBe('lose');
    });

    it('presents ANY decided versus match as a win, whichever seat survived', () => {
      // Preserves the shipped screen/music behaviour for the sim's `win` event
      // WITHOUT claiming the local player was the survivor.
      for (const result of [versusWinnerSlot(0), versusWinnerSlot(3), versusWinnerTeam(1)]) {
        expect(legacyOutcomePresentation(vsMatchEndOutcome(result))).toBe('win');
      }
    });

    it('presents a versus DRAW as a loss, matching the shipped `lose` event', () => {
      expect(legacyOutcomePresentation(vsMatchEndOutcome(versusDraw()))).toBe('lose');
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

    const ended = locationInGameplay(session, outcomePhase(vsMatchEndOutcome(versusDraw())));
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
      practiceLevelDescriptor(1).kind,
      versusDescriptor(versusRulesFromConfig(versusConfigFixture())).kind,
    ];
    expect(kinds).toEqual(['campaign', 'practice', 'versus']);
  });
});
