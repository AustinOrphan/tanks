import type { SlotSource } from '../input/assignment';
import { isBotDifficulty, DEFAULT_BOT_DIFFICULTY, type BotDifficulty } from '../sim/ai/bot-difficulty';
import { teamOf } from '../sim/arena';

/**
 * The VS setup's CANONICAL per-slot representation (issue #260).
 *
 * The binding decision the issue makes: per-slot source assignment is authoritative and a
 * bot COUNT is derived data. Before this, `VersusConfig` carried no per-slot field at all,
 * so the "Who's playing" rows mutated the running session's assignment and Start -- which
 * disposes that session -- rebuilt from defaults, discarding what the player had chosen.
 *
 * TWO TYPES, NOT ONE, and the split is the load-bearing part of this module:
 *
 *   - `VersusSlotRole` is what SURVIVES a reload: whether a slot is a human, a bot, or
 *     empty. Stable, small, and safe to write to storage.
 *   - `SlotSource` (input/assignment.ts) is which DEVICE a human slot is actually reading
 *     this page-session: keyboard, or gamepad index N. Volatile, and deliberately NOT
 *     persisted -- see `sanitizeSetup` for why a stored pad index is a hazard rather than
 *     a convenience.
 *
 * Persisting the role pattern and re-resolving the devices is what lets the issue have
 * both "the last valid role pattern survives reload" and "never silently binds a different
 * physical controller by stale index" at once. They look contradictory only if you treat
 * the device as part of the saved setup.
 */
export type VersusSlotRole = 'human' | 'bot' | 'none';

/** One slot, as stored. Deliberately free of anything page-session-scoped. */
export interface VersusSlotSetup {
  role: VersusSlotRole;
  /**
   * Team index, meaningful only when the match mode is `'teams'`. Carried
   * unconditionally, the same way `VersusConfig.friendlyFire` is: the consumers already
   * ignore it outside teams mode, so a conditional field would buy nothing and cost a
   * branch at every construction site.
   *
   * Team SELECTION and its count validation are issue #281's; this field is the slot-level
   * home it will write into, so that work does not have to re-shape the descriptor.
   */
  team?: number;
  /**
   * Competence preset for a `'bot'` slot (issue #267). Meaningful only when `role` is
   * `'bot'`; carried unconditionally, the same way `team` above is.
   *
   * Absent means `normal`, which `withBotDifficulty` resolves to the authored profile
   * unchanged -- so a setup saved before this field existed, and a slot the player never
   * touched, both play exactly as they did before.
   */
  difficulty?: BotDifficulty;
}

/**
 * The whole retained setup: the match rules plus the per-slot roles.
 *
 * Bot DIFFICULTY is deliberately absent AT THIS LEVEL. The issue's slot list says "Bot, with
 * contextual difficulty", and difficulty is a per-slot property, so it landed on
 * `VersusSlotSetup.difficulty` when #267 built the presets -- which is where this comment
 * predicted it would go. The original parenthetical here ("grepped: `botDifficulty` has no
 * definition anywhere") has since stopped being true twice over: `VersusSlotSetup.difficulty`
 * carries the choice, and `Tank.botDifficulty` carries it into the simulation (issue #891).
 */
export interface VersusSetup {
  mode: 'ffa' | 'teams';
  players: 2 | 3 | 4;
  stock: number;
  friendlyFire: boolean;
  arenaId: string;
  /** Length always equals `players` after `sanitizeSetup`; see its length rules. */
  slots: VersusSlotSetup[];
}

/** Why Start is refused, in words a slot card can show. `null` means Start is allowed. */
export type VersusSetupProblem =
  | { kind: 'unassigned'; slot: number }
  | { kind: 'no-human' }
  | { kind: 'device-missing'; slot: number }
  /**
   * Teams mode with every represented slot on ONE team (issue #281).
   *
   * Pane-level rather than slot-level, like `no-human`: no single card is at fault -- the
   * player can fix it by moving ANY one slot -- so blaming one would point at an arbitrary
   * card. `hud.ts`'s renderer routes both of these to the pane's own reason line.
   */
  | { kind: 'one-team' };

const ROLES: ReadonlySet<string> = new Set<VersusSlotRole>(['human', 'bot', 'none']);

/**
 * The draw-for-me sentinel. `VersusConfig.arenaId`'s own doc comment is emphatic that the
 * UNRESOLVED config -- the one still carrying this -- is what the pane reopens with, and
 * that it must survive a session in which a concrete arena was actually played. The same
 * holds across a reload: persisting the RESOLVED id would silently convert "surprise me"
 * into whatever board the first Start happened to roll, permanently.
 */
export const RANDOM_ARENA = 'random';

/**
 * Whether a stored arena id is offerable at a given (players, mode). Injected rather than
 * imported so this module stays a pure model with no catalog dependency; the store passes
 * a `versusMapChoices`-backed predicate, and tests can pass their own.
 */
export type ArenaAllowed = (arenaId: string, players: number, mode: 'ffa' | 'teams') => boolean;

/**
 * Default role for a slot at first launch, before anything has been chosen.
 *
 * Slot 0 is the human on this device; every other slot starts as a BOT rather than as a
 * second human. That is the issue's "first-time keyboard-only ... produce playable
 * defaults" criterion made concrete: defaulting slot 1 to a human would hand a
 * keyboard-only player a match containing a tank nothing can drive, which is exactly the
 * "keyboard-only default can launch required inert tanks" gap the issue opens with.
 */
export function defaultSlots(players: number): VersusSlotSetup[] {
  const out: VersusSlotSetup[] = [];
  for (let i = 0; i < players; i++) out.push({ role: i === 0 ? 'human' : 'bot' });
  return out;
}

/**
 * Grow or shrink a slot array to `players`, KEEPING the roles already chosen.
 *
 * The pane's player-count buttons are the reason this exists as its own function: changing
 * 2 players to 3 used to leave `slots` at length 2, so Start emitted a config whose slots
 * did not describe the match being started -- the exact "Start initializes the session from
 * the exact displayed assignments" criterion, failing silently. Resizing rather than
 * rebuilding is what preserves a player's earlier choices when they change their mind about
 * the count and change it back.
 */
export function resizeSlots(slots: readonly VersusSlotSetup[], players: number): VersusSlotSetup[] {
  const defaults = defaultSlots(players);
  const out: VersusSlotSetup[] = [];
  for (let i = 0; i < players; i++) out.push(slots[i] ? { ...slots[i] } : defaults[i]);
  return out;
}

/**
 * Read-side repair for anything that came out of storage, or out of an older build.
 *
 * EVERY field is validated and defaulted INDEPENDENTLY, the rule touch-settings.ts already
 * follows: junk in one field must never fall another back away from what it actually
 * stored. A player who set 4 players and then hand-edited the JSON should still get their
 * player count.
 *
 * LENGTH is reconciled against `players` rather than trusted, because the two are stored
 * separately and can disagree across a build that changed the allowed counts: a short array
 * is extended with defaults, a long one is truncated. Neither throws. A stored setup is not
 * a save file the player can see, so failing loudly buys nothing and costs a launch.
 */
export function sanitizeSetup(
  raw: unknown,
  fallback: VersusSetup,
  isArenaAllowed: ArenaAllowed = () => true,
): VersusSetup {
  const o = (raw ?? {}) as Partial<Record<keyof VersusSetup, unknown>>;

  const mode: VersusSetup['mode'] = o.mode === 'ffa' || o.mode === 'teams' ? o.mode : fallback.mode;
  const players: VersusSetup['players'] =
    o.players === 2 || o.players === 3 || o.players === 4 ? o.players : fallback.players;
  const stock = typeof o.stock === 'number' && Number.isFinite(o.stock) && o.stock > 0
    ? Math.floor(o.stock)
    : fallback.stock;
  const friendlyFire = typeof o.friendlyFire === 'boolean' ? o.friendlyFire : fallback.friendlyFire;
  // ARENA VALIDATION IS NOT OPTIONAL POLISH, and this is the one field where a
  // well-formed stored value can still crash the launch path. `resolveVersusConfig`
  // THROWS twice over: once for an id naming no catalog entry, and again for a real id
  // whose entry does not support the (players, mode) being started. Both are reachable
  // from storage alone -- an arena retired between builds, or a player who stored
  // 'arena-two-player' and later chose 4 players -- so a stored setup could make the game
  // fail to start with no way for the player to see why.
  //
  // `'random'` is always allowed and is the fallback, because `pickVersusArena` resolves
  // it against the CURRENT catalog for the CURRENT (players, mode) and therefore cannot
  // name something unsupported.
  const storedArena = typeof o.arenaId === 'string' && o.arenaId !== '' ? o.arenaId : null;
  const arenaId =
    storedArena === null
      ? fallback.arenaId
      : storedArena === RANDOM_ARENA || isArenaAllowed(storedArena, players, mode)
        ? storedArena
        : RANDOM_ARENA;

  const rawSlots = Array.isArray(o.slots) ? o.slots : [];
  const slots: VersusSlotSetup[] = [];
  const defaults = defaultSlots(players);
  for (let i = 0; i < players; i++) {
    const s = (rawSlots[i] ?? {}) as { role?: unknown; team?: unknown; difficulty?: unknown };
    const role: VersusSlotRole = typeof s.role === 'string' && ROLES.has(s.role)
      ? (s.role as VersusSlotRole)
      : defaults[i].role;
    const slot: VersusSlotSetup = { role };
    if (typeof s.team === 'number' && Number.isFinite(s.team) && s.team >= 0) {
      slot.team = Math.floor(s.team);
    }
    // Validated like `role` is, and for the same reason: this comes off disk. An
    // unrecognised preset is DROPPED rather than defaulted-in-place, so the slot falls
    // back to `normal` through absence -- the one state the whole feature is additive
    // over -- instead of carrying a string no resolver knows what to do with.
    if (isBotDifficulty(s.difficulty)) slot.difficulty = s.difficulty;
    slots.push(slot);
  }

  return { mode, players, stock, friendlyFire, arenaId, slots };
}

/**
 * Resolve each slot's live device, given what is actually connected right now.
 *
 * THE STALE-INDEX RULE LIVES HERE, and it is the issue's one purely NEGATIVE criterion:
 * "reload preserves stable role/bot choices but never silently binds a different physical
 * controller by stale index". Nothing about a pad index is stored, so there is no stored
 * index to honour -- human slots are re-resolved from scratch against `connectedPads`
 * every time, in slot order. Slot 0 takes this device (keyboard/touch); each later human
 * slot takes the next connected pad, and a human slot with no pad left resolves to
 * `'none'`, which `versusSetupProblem` then reports as `device-missing` rather than
 * letting Start bind something arbitrary.
 *
 * The failure this prevents is specific: unplug pad A, plug in pad B, reload, and a stored
 * "slot 2 = pad 0" would silently hand slot 2 to a different physical controller than the
 * one the player assigned it to. Re-resolution makes that impossible by construction
 * rather than by a check someone has to remember to run.
 *
 * A PAD TANKS CANNOT READ IS SKIPPED (issue #713). `unreadablePads` (from
 * `unreadablePadIndices`, gamepad.ts) is removed from the connected list before any slot is
 * resolved, so a human slot takes the next READABLE pad, or resolves to `'none'` when none is
 * left -- which `versusSetupProblem` then reports as `device-missing`, exactly as for a pad
 * that is not there. Without it an unreadable pad earlier in the list bound a slot the
 * reader samples as neutral every tick, and Start was not refused.
 */
export function resolveSources(
  slots: readonly VersusSlotSetup[],
  connectedPads: readonly number[],
  unreadablePads: ReadonlySet<number> = new Set(),
): SlotSource[] {
  const pads = connectedPads.filter((padIndex) => !unreadablePads.has(padIndex));
  let nextPad = 0;
  let deviceTaken = false;
  return slots.map((s) => {
    if (s.role === 'bot') return { kind: 'bot' as const };
    if (s.role === 'none') return { kind: 'none' as const };
    if (!deviceTaken) {
      deviceTaken = true;
      return { kind: 'keyboard' as const };
    }
    if (nextPad < pads.length) return { kind: 'gamepad' as const, padIndex: pads[nextPad++] };
    return { kind: 'none' as const };
  });
}

/**
 * The single gate Start is allowed to consult. Returns the FIRST problem, or null.
 *
 * "Never accept Start with an inert required slot" is the issue's phrasing, and the three
 * ways a slot can be inert are distinguished on purpose, because a card that says only
 * "not ready" is not actionable: a slot nobody has assigned (`unassigned`), a human slot
 * whose device is not there (`device-missing`), and a whole match with no human in it
 * (`no-human`) each want a different sentence and a different fix.
 */
export function versusSetupProblem(
  slots: readonly VersusSlotSetup[],
  sources: readonly SlotSource[],
  // Trailing and optional, the precedent this file's neighbours already set: absent means
  // `'ffa'`, under which no team check applies at all. Only issue #281's team rule reads
  // it, so every existing caller keeps the exact three refusals it had.
  mode: 'ffa' | 'teams' = 'ffa',
): VersusSetupProblem | null {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].role === 'none') return { kind: 'unassigned', slot: i };
  }
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].role === 'human' && sources[i]?.kind === 'none') {
      return { kind: 'device-missing', slot: i };
    }
  }
  if (!slots.some((s) => s.role === 'human')) return { kind: 'no-human' };
  // LAST, deliberately: an unassigned or device-less slot is a more specific and more
  // actionable complaint than "everyone is on one team", and a slot that is `none` is not
  // in the match to have a team at all. By this line every slot is playing.
  if (mode === 'teams' && representedTeams(slots).size < 2) return { kind: 'one-team' };
  return null;
}

/**
 * The distinct teams actually represented by the playing slots.
 *
 * EFFECTIVE teams, not configured ones: a slot with no choice yet falls back to
 * `teamOf(slot)`, which is exactly what `loadArena` does when it stamps the tank. Reading
 * the configured value alone would refuse a freshly-opened pane -- where every `team` is
 * still `undefined` -- even though starting it would build a perfectly good 2v2.
 */
export function representedTeams(slots: readonly VersusSlotSetup[]): Set<number> {
  const out = new Set<number>();
  slots.forEach((s, i) => {
    if (s.role !== 'none') out.add(s.team ?? teamOf(i));
  });
  return out;
}

/**
 * Bot slots, DERIVED -- the issue's "a bot count is derived data and is not authoritative".
 * `loop.ts` wants this shape (`botSlotsFor`), and computing it here keeps the descriptor
 * the only place the answer lives.
 */
export function botSlotsOf(slots: readonly VersusSlotSetup[]): Set<number> {
  const out = new Set<number>();
  slots.forEach((s, i) => {
    if (s.role === 'bot') out.add(i);
  });
  return out;
}

/**
 * The LAST `botCount` of `playerCount` slots -- the derived fill rule a session with no
 * setup pane uses. Moved here from `loop.ts` (issue #891) unchanged, because `levels.ts`
 * needs it too and cannot import `loop.ts`.
 *
 * `botCount` is clamped rather than trusted: unclamped, a count larger than `playerCount`
 * starts the loop at a NEGATIVE index and returns slots that do not exist. Every shipped
 * caller clamps first (`loop.ts` does `Math.min(devFlags.bots ?? 0, playerCount)`, because
 * the two flags parse independently), so this is belt-and-braces rather than a fix -- but a
 * second caller is exactly the moment that assumption stops being checked in one place.
 */
export function botSlotsFor(playerCount: number, botCount: number): Set<number> {
  const slots = new Set<number>();
  const n = Math.min(Math.max(0, botCount), Math.max(0, playerCount));
  for (let i = playerCount - n; i < playerCount; i++) slots.add(i);
  return slots;
}

/**
 * Which slots a computer drives and at what difficulty, for BOTH entry paths (issue #891).
 *
 * THE SAME TWO-PATH SHAPE `seedAssignment` HAS, deliberately and by the same argument its
 * own header makes: a VS session started from the setup pane carries per-slot roles and
 * those are authoritative, while a campaign or dev-flag session has no pane and falls back
 * to the derived last-K rule. The simulation's view of which tanks are bots must agree with
 * the input layer's, or the contact overlay rings one tank while another is being driven --
 * so the two derivations are pinned against each other by test rather than by inspection.
 *
 * `playerCount`/`botCount` are ignored when `versusSlots` is present, exactly as
 * `seedAssignment` ignores them on that path.
 */
export function botSlotDifficulties(
  versusSlots: readonly VersusSlotSetup[] | undefined,
  playerCount: number,
  botCount: number,
): (BotDifficulty | undefined)[] {
  if (versusSlots) return botDifficultiesOf(versusSlots);
  const bots = botSlotsFor(playerCount, botCount);
  return Array.from({ length: Math.max(0, playerCount) }, (_, i) =>
    (bots.has(i) ? DEFAULT_BOT_DIFFICULTY : undefined));
}

/**
 * The per-slot difficulty array the simulation stamps onto tanks as `Tank.botDifficulty`
 * (issue #891), indexed by slot and sparse: `undefined` at a slot is a human.
 *
 * DERIVED FROM `role`, exactly as `botSlotsOf` above is, so the two cannot disagree about
 * which slots are bots -- the same reason #260 refuses to store a bot count beside the roles.
 * A non-bot slot contributes `undefined` even if it is carrying a stale `difficulty` from
 * having been a bot earlier in the setup pane, because `difficulty` is documented as
 * meaningful only when `role` is `'bot'`.
 *
 * A bot slot with no explicit choice resolves to `DEFAULT_BOT_DIFFICULTY` here rather than
 * being left `undefined`, because in the array `undefined` already means "human". Leaving it
 * would make a bot slot the player never touched build a tank the simulation treats as a
 * human -- no commitment, no contact overlay -- which is the one confusion this array exists
 * to remove.
 */
export function botDifficultiesOf(
  slots: readonly VersusSlotSetup[],
): (BotDifficulty | undefined)[] {
  return slots.map((s) => (s.role === 'bot' ? (s.difficulty ?? DEFAULT_BOT_DIFFICULTY) : undefined));
}
