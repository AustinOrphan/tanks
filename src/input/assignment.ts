import type { InputState, Vec2 } from '../sim/types';
import type { PlayerInputSource } from './gamepad';

/**
 * Controller assignment UI's model (docs/superpowers/plans/2026-08-17-controller-assignment.md).
 * Pure: zero DOM, zero gamepad IO, testable without the HUD.
 *
 * `'keyboard'` names the merged desktop/touch `InputController` (`input.ts`'s `input`),
 * not literally "keys only" -- it is whatever slot 0 has always been. `'none'` is a
 * DELIBERATE unassignment, distinct from a slot that has never been given anything:
 * see `createHeldInputSource` below for what samples it.
 */
export type SlotSource =
  | { kind: 'keyboard' }
  | { kind: 'gamepad'; padIndex: number }
  | { kind: 'bot' }
  | { kind: 'none' };

/** Indexed by slot, length === playerCount. Session-only: never written to Storage. */
export type Assignment = SlotSource[];

/**
 * Today's rule, made explicit and readable as data instead of re-derived on every read:
 * slot 0 is `'keyboard'`, every slot i >= 1 is `{gamepad, padIndex: i}` (`pad[i] ->
 * slot[i]`, gamepad.ts) -- UNLESS the slot is bot-claimed (`botSlots`, `loop.ts`'s
 * `botSlotsFor`), in which case it is `'bot'` regardless of index. Bots claim their
 * declared slots first; controllers (or keyboard, at slot 0) fill whatever remains --
 * exactly `loop.ts`'s pre-assignment-UI precedence, see its `realSources` doc comment.
 */
export function deriveInitialAssignment(
  playerCount: number,
  botSlots: ReadonlySet<number>,
): Assignment {
  const out: Assignment = [];
  for (let i = 0; i < playerCount; i++) {
    if (botSlots.has(i)) {
      out.push({ kind: 'bot' });
      continue;
    }
    out.push(i === 0 ? { kind: 'keyboard' } : { kind: 'gamepad', padIndex: i });
  }
  return out;
}

/**
 * Pure: returns a NEW array, never mutates `assignment`. Enforces STRUCTURAL exclusivity
 * only -- it has no view of live hardware, so it cannot know whether a padIndex it is
 * handed is actually connected.
 *
 * Assigning `'keyboard'` bounces whichever OTHER slot currently holds `'keyboard'` to
 * `'none'` (reserved-idle, not stolen -- see `createHeldInputSource`). Assigning
 * `{gamepad, padIndex: N}` bounces whichever OTHER slot already claims padIndex N the
 * same way. `'bot'` and `'none'` never bounce anything -- there is nothing exclusive
 * about either. `i !== slot` in both bounce loops is load-bearing: reassigning a slot
 * to the exact source it already holds must be a no-op, not a self-bounce to `'none'`.
 */
export function reassign(assignment: Assignment, slot: number, source: SlotSource): Assignment {
  const next = assignment.slice();
  if (source.kind === 'keyboard') {
    for (let i = 0; i < next.length; i++) {
      if (i !== slot && next[i].kind === 'keyboard') next[i] = { kind: 'none' };
    }
  } else if (source.kind === 'gamepad') {
    for (let i = 0; i < next.length; i++) {
      const cur = next[i];
      if (i !== slot && cur.kind === 'gamepad' && cur.padIndex === source.padIndex) {
        next[i] = { kind: 'none' };
      }
    }
  }
  next[slot] = source;
  return next;
}

/**
 * The reserved-idle `PlayerInputSource` for a `'none'` slot: a real, UI-selectable call
 * site now, unlike the pre-assignment-UI world where every co-player slot always had
 * hardware or a bot behind it. `loop.ts`'s per-slot sample loop calls `.sample()`
 * unconditionally, so a bare `'none'` descriptor still needs SOME source, and it must
 * never poll hardware.
 *
 * A DELIBERATE UN-RETIREMENT of `loop.ts`'s `createIdleInputSource` (n-player arc PR3,
 * deleted when every co-player slot got its own dedicated `createGamepadInputSource`,
 * whose own "no pad ever connected" branch already produced the same echo -- see
 * `gamepad.ts`'s module doc comment). CLAUDE.md's retirement note says a generator
 * "rots" only while nothing calls it; `'none'` is a real call site again, so bringing the
 * shape back is warranted, not a regression of that principle.
 *
 * The mechanism: `world.ts`'s `driveTank` computes `aimDir = vsub(input.aim,
 * player.pos)` and skips the turret slew only when `aimDir` is EXACTLY `{0,0}`. A
 * constant `aim: {0,0}` is only that zero for a tank spawned at the world's origin --
 * for every other spawn it reads as a real aim point there, and the turret slews toward
 * it. Echoing the tank's own last-known position back as `aim` makes `aimDir` resolve to
 * `{0,0}` regardless of where the tank spawned, so the turret holds instead ("tank holds,
 * reclaimable" -- see the doc's Reserved-idle semantics). Proven red-first: replacing the
 * echo with a constant `{0,0}` aim fails `assignment.test.ts`'s "RED-FIRST" turret-slew
 * test, driven through the real sim.
 *
 * Raw echo, not `quantizeAim`'d: a spawn is rarely exactly on `touch.ts`'s AIM_GRID, and
 * `driveTank`'s turret-hold guard requires `aimDir` to be EXACTLY `{0,0}` -- a quantized
 * echo would round to a slightly different point and reproduce a smaller version of the
 * same slew. `setPlayerPosition(null)` is ignored (holds the last REAL position) rather
 * than falling back to `{0,0}`, the one place this differs from `createGamepadInputSource`'s
 * own no-pad fallback -- see that function's doc comment for why its shape has to accept
 * null (a real gamepad reader's `playerPos` truly can go null), which a reserved-idle
 * slot with no hardware never needs to.
 */
export function createHeldInputSource(): PlayerInputSource {
  let lastPos: Vec2 = { x: 0, y: 0 };
  return {
    sample(): InputState {
      return { move: { x: 0, y: 0 }, aim: { ...lastPos }, fire: false, mine: false };
    },
    setPlayerPosition(pos: Vec2 | null): void {
      if (pos !== null) lastPos = { x: pos.x, y: pos.y };
    },
    gamepadConnected(): boolean {
      return false;
    },
    dispose(): void {
      // No resources: no listeners, no timers, no wrapped reader.
    },
  };
}
