import type { Arena } from './arena';
import { loadArena } from './arena';
import type { Vec2, Wall } from './types';
import { bankShot, lineOfSight } from './ai/targeting';
import { AIBehavior, configFor } from './config';
import type { ArenaClaim } from './config/arena-types';
import { SPAWN_LETTERS } from './config/arena-types';

/**
 * Evaluates an arena's declared design claims (config/arena-types.ts) against the
 * sim's OWN geometry -- lineOfSight, the same function the AI uses -- so a claim
 * means exactly what the game means by it.
 *
 * Test-facing: it imports the AI layer, which is why it lives here rather than in
 * config/ (that module stays free of AI dependencies). Nothing in the shipped
 * bundle imports this.
 */

/**
 * The world-space centre of a grid cell, matching loadArena's spawn placement
 * (`(c + 0.5) * cellSize`, arena.ts). Exported with its inverse below because
 * this formula previously existed in three places -- here, loadArena, and a
 * hand-rolled inverse in arena-validation.test.ts -- with nothing pinning them
 * together. `cell-mapping.test.ts` now does.
 */
export function cellCentre(arena: Arena, [c, r]: readonly [number, number]): Vec2 {
  return { x: (c + 0.5) * arena.cellSize, y: (r + 0.5) * arena.cellSize };
}

/** The inverse of cellCentre: which cell a world point sits in. */
export function cellOf(arena: Arena, p: Vec2): [number, number] {
  return [Math.round(p.x / arena.cellSize - 0.5), Math.round(p.y / arena.cellSize - 0.5)];
}

/**
 * Every destructible wall destroyed, as a COPY -- the caller's array is left
 * intact. Exported so tests stop open-coding the idiom (three sites did, and
 * they mutated in place, which is a different thing).
 */
export function breach(walls: Wall[]): Wall[] {
  return walls.map((w) => (w.kind === 'destructible' ? { ...w, destroyed: true } : w));
}

/**
 * The grid with `marks` overwritten as `*`, for failure messages.
 *
 * An out-of-grid mark is REPORTED, not thrown: this runs on the failure path, so
 * a raw TypeError here would bury the failure it was called to explain. Data
 * from arenas.json cannot get here out of range (the validator bounds-checks
 * every claim cell), but a hand-built test claim can.
 */
export function renderBoard(
  arena: Arena,
  marks: ReadonlyArray<readonly [number, number, string?]>,
): string {
  const rows = arena.grid.map((row) => [...row]);
  const outside: string[] = [];
  for (const [c, r, glyph] of marks) {
    if (c < 0 || c >= arena.cols || r < 0 || r >= arena.rows) {
      outside.push(`[${c}, ${r}]`);
      continue;
    }
    rows[r][c] = glyph ?? '*';
  }
  const board = rows.map((row) => row.join('')).join('\n');
  return outside.length === 0
    ? board
    : `${board}\n(not drawn -- outside the ${arena.cols}x${arena.rows} grid: ${outside.join(' ')})`;
}

/**
 * A cell a tank could EVER stand on: open now, or openable by demolition. The
 * 2026-07-31 balance pass made ARENA_02's middle bar a full destructible barrier --
 * the halves START sealed and the level is about breaching it -- so plain-open
 * connectivity is a design choice, not an invariant. SOLID-sealed pockets remain
 * forbidden: no amount of play opens those.
 */
function isBreachable(arena: Arena, r: number, c: number): boolean {
  const kind = arena.legend[arena.grid[r][c]];
  return !kind || kind === 'destructible';
}

/**
 * 4-neighbour flood fill over breachable cells; also names what it could not reach.
 *
 * The fill starts at the PLAYER's cell, not at the first breachable cell in scan
 * order. Connectivity is symmetric so the pass/fail answer is identical either way,
 * but the REPORTED set is not: review caught the scan-order version marking the whole
 * play area as "cut off" on the sealed-pocket fixture, because that fixture's sealed
 * cell sorts first and became the fill's origin. Anchoring on the player makes
 * `unreached` mean "cut off from the player", which is the thing worth drawing.
 */
function reachable(arena: Arena): { open: number; reached: number; unreached: Array<[number, number]> } {
  const { rows, cols } = arena;
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
  let open = 0;
  let start: [number, number] | null = null;
  let fallback: [number, number] | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isBreachable(arena, r, c)) {
        open++;
        if (!fallback) fallback = [r, c];
        if (SPAWN_LETTERS[arena.grid[r][c]] === 'player') start = [r, c];
      }
    }
  }
  // A grid with no player spawn cannot reach the validator, but structuralFailures
  // is called on hand-built fixtures too; fall back rather than crash.
  start = start ?? fallback;
  if (!start) return { open, reached: 0, unreached: [] };
  const seenStack: Array<[number, number]> = [start];
  seen[start[0]][start[1]] = true;
  let reachedCount = 0;
  while (seenStack.length) {
    const [r, c] = seenStack.pop()!;
    reachedCount++;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (seen[nr][nc] || !isBreachable(arena, nr, nc)) continue;
      seen[nr][nc] = true;
      seenStack.push([nr, nc]);
    }
  }
  const unreached: Array<[number, number]> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isBreachable(arena, r, c) && !seen[r][c]) unreached.push([c, r]);
    }
  }
  return { open, reached: reachedCount, unreached };
}

/**
 * The rules EVERY arena obeys, whatever it claims: no solid-sealed pockets, no enemy
 * holding a straight line to the player spawn at spawn (Brown never moves, so such a
 * line is a death sentence three seconds into the level), and -- since green shipped --
 * no STATIONARY banking enemy holding a RICOCHET path to it either.
 *
 * Extracted from arena-validation.test.ts so a deliberately broken fixture can be
 * fed to it -- inline rules in a describe.each can only ever see arenas that exist.
 */
export function structuralFailures(arena: Arena): string[] {
  const failures: string[] = [];
  const { open, reached, unreached } = reachable(arena);
  if (reached !== open) {
    failures.push(
      `sealed pocket: ${reached} of ${open} breachable cells reachable; ` +
      `${unreached.length} cut off, marked below\n${renderBoard(arena, unreached)}`,
    );
  }
  const { walls, spawns } = loadArena(arena);
  const player = spawns.find((s) => s.kind === 'player');
  if (!player) return [...failures, 'no player spawn'];
  for (const enemy of spawns.filter((s) => s.kind !== 'player')) {
    if (lineOfSight(enemy.pos, player.pos, walls)) {
      failures.push(
        `spawn sightline: ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) sees the player spawn\n` +
        renderBoard(arena, [
          [...cellOf(arena, enemy.pos), 'E'] as const,
          [...cellOf(arena, player.pos), 'P'] as const,
        ]),
      );
    }
    // A BANKING enemy defeats the rule above by going round the wall that satisfies it.
    // Before green shipped, every enemy's only path to the spawn was the straight line
    // lineOfSight tests, so "no spawn sightline" and "no spawn shot" were the same
    // statement. They are not any more: RICOCHET_SNIPER is stationary, holds a 0.55 bank
    // weight and a 0.35s reaction, so a bank path onto the spawn is the same death
    // sentence the direct rule exists to prevent -- and on every respawn, not just once.
    //
    // STATIONARY bankers only, and that restriction is measured, not assumed. Applied to
    // every banking profile it fails two SHIPPED arenas: on arena-01 the grey at (13, 5)
    // banks onto the spawn off 1 wall and the teal at (11, 7) off 2, and arena-04's two
    // teals do the same. arena-01 is the oldest level in the game and plays fine, because
    // grey and teal are MOBILE -- they leave the spawn geometry within about a second, so
    // the line they hold at tick 0 is a curiosity. A stationary gunner never leaves, so it
    // holds that line for the whole level and on every respawn. That difference is the
    // whole rule; widening it to mobile tanks would reject levels the game has shipped.
    //
    // Also gated on the weight, so it costs nothing for kinds that never bank. INTACT
    // walls only, matching the direct rule immediately above: arena-02 deliberately opens
    // direct spawn lines once its barrier is breached, so a post-breach rule would
    // contradict a shipped level's design. An arena wanting the post-breach guarantee
    // declares spawnBlockRobust, which checks both phases AND, since review found
    // this sentence promising a guarantee the code did not implement, banks too.
    const cfg = configFor(enemy.kind);
    if (cfg.behavior === AIBehavior.STATIONARY
        && cfg.ai.bankShotWeight > 0
        && bankShot(enemy.pos, player.pos, walls, cfg.weapon.ricochetCount) !== null) {
      failures.push(
        `spawn BANK line: ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) can bank onto the ` +
        `player spawn off ${cfg.weapon.ricochetCount} wall(s), with no direct line needed\n` +
        renderBoard(arena, [
          [...cellOf(arena, enemy.pos), 'E'] as const,
          [...cellOf(arena, player.pos), 'P'] as const,
        ]),
      );
    }
  }
  return failures;
}

export function claimFailures(arena: Arena, claims: ArenaClaim[]): string[] {
  const { walls, spawns } = loadArena(arena);
  const breached = breach(walls);
  const player = spawns.find((s) => s.kind === 'player');
  if (!player) return ['no player spawn: the structural validator should have caught this'];
  const failures: string[] = [];

  for (const claim of claims) {
    switch (claim.type) {
      case 'sightlineAfterBreach': {
        const from = cellCentre(arena, claim.from);
        const sees = lineOfSight(from, player.pos, breached);
        if (sees !== claim.sees) {
          failures.push(
            `sightlineAfterBreach at [${claim.from}]: expected sees=${claim.sees}, measured ${sees}\n` +
            `  why: ${claim.why}\n${renderBoard(arena, [claim.from])}`,
          );
        }
        break;
      }
      case 'lane': {
        const a = cellCentre(arena, claim.from);
        const b = cellCentre(arena, claim.to);
        const states = {
          intact: lineOfSight(a, b, walls) ? 'open' : 'blocked',
          breached: lineOfSight(a, b, breached) ? 'open' : 'blocked',
        } as const;
        for (const phase of ['intact', 'breached'] as const) {
          if (states[phase] !== claim[phase]) {
            failures.push(
              `lane [${claim.from}]->[${claim.to}] ${phase}: expected ${claim[phase]}, measured ${states[phase]}\n` +
              `  why: ${claim.why}\n${renderBoard(arena, [claim.from, claim.to])}`,
            );
          }
        }
        break;
      }
      case 'spawnBlockRobust': {
        const offsets: Vec2[] = [
          { x: claim.nudge, y: 0 }, { x: -claim.nudge, y: 0 },
          { x: 0, y: claim.nudge }, { x: 0, y: -claim.nudge },
        ];
        // Both wall phases, not just intact: the defect this claim exists to catch
        // (arena-03's original corner-tangency) was a POST-breach tangency -- with
        // the centre peek destroyed, both browns' lines were blocked only by a
        // single-point tangency that a 0.1-unit nudge opened. Checking intact alone
        // is silently blind to that. Checking both IS stronger than the bespoke test
        // this claim type replaced, but not because intact adds detection power on
        // its own: measured across all 5 arena-01/02/03-and-fixture scenarios --
        // this switch case only runs where the claim is DECLARED, so arena-02 (which
        // does not declare it) is measured by its own test in arena-validation.test.ts
        // rather than here -- 0 failures were intact-only. Breach only ever reveals sightlines, never
        // hides them, so an intact failure is always also a breached one at the same
        // enemy/offset. arena-02 fails 12 of its 16 breached-phase checks and 0 of 16
        // intact -- exactly why it carries no spawnBlockRobust claim: the level's
        // design is to open sightlines when the centre barrier breaches, not to
        // survive it. The actual gain over the deleted test is the 4 cardinal
        // offsets here versus its 2 (±x), run on every claiming arena; the intact
        // phase's value is labelling which wall state a failure lives in, not
        // catching anything breached alone would miss.
        const phases = [
          { name: 'intact', walls } as const,
          { name: 'breached', walls: breached } as const,
        ];
        // A STATIONARY banker is checked for a RICOCHET onto the nudged spawn as well as
        // a straight line. structuralFailures forbids it a bank onto the spawn with walls
        // INTACT; this is the post-breach half, and the reason it lives here rather than
        // there is the same reason the direct rule stops at intact -- arena-02 opens spawn
        // lines on purpose when its barrier goes, so a universal post-breach rule would
        // reject a shipped level. Declaring spawnBlockRobust is how an arena opts in to
        // the stronger guarantee. Written after review found the comment here promising
        // exactly this escape hatch while the code checked lineOfSight only, so an arena
        // could declare the claim and still hand green a post-breach ricochet onto the
        // respawn point. Costs nothing for the four kinds that never bank and for every
        // mobile one.
        for (const enemy of spawns.filter((s) => s.kind !== 'player')) {
          const cfg = configFor(enemy.kind);
          const banks = cfg.behavior === AIBehavior.STATIONARY && cfg.ai.bankShotWeight > 0;
          for (const off of offsets) {
            const target = { x: player.pos.x + off.x, y: player.pos.y + off.y };
            for (const phase of phases) {
              if (lineOfSight(enemy.pos, target, phase.walls)) {
                failures.push(
                  `spawnBlockRobust (${phase.name}): ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) sees the ` +
                  `player nudged by (${off.x}, ${off.y}) -- the block is a tangency, not a chord\n` +
                  `  why: ${claim.why}\n` +
                  `  (E = the enemy that sees, P = the player spawn)\n` +
                  renderBoard(arena, [
                    [...cellOf(arena, enemy.pos), 'E'] as const,
                    [...cellOf(arena, player.pos), 'P'] as const,
                  ]),
                );
              }
              if (banks && bankShot(enemy.pos, target, phase.walls, cfg.weapon.ricochetCount) !== null) {
                failures.push(
                  `spawnBlockRobust (${phase.name}, BANK): ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) can ` +
                  `ricochet onto the player nudged by (${off.x}, ${off.y}) -- no direct line needed\n` +
                  `  why: ${claim.why}\n` +
                  `  (E = the enemy that banks, P = the player spawn)\n` +
                  renderBoard(arena, [
                    [...cellOf(arena, enemy.pos), 'E'] as const,
                    [...cellOf(arena, player.pos), 'P'] as const,
                  ]),
                );
              }
            }
          }
        }
        break;
      }
    }
  }
  return failures;
}
