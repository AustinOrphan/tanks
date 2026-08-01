import type { Arena } from './arena';
import { loadArena } from './arena';
import type { Vec2, Wall } from './types';
import { lineOfSight } from './ai/targeting';
import type { ArenaClaim } from './config/arena-types';

/**
 * Evaluates an arena's declared design claims (config/arena-types.ts) against the
 * sim's OWN geometry -- lineOfSight, the same function the AI uses -- so a claim
 * means exactly what the game means by it.
 *
 * Test-facing: it imports the AI layer, which is why it lives here rather than in
 * config/ (that module stays free of AI dependencies). Nothing in the shipped
 * bundle imports this.
 */

/** The world-space centre of a grid cell, matching loadArena's spawn placement. */
function cellCentre(arena: Arena, [c, r]: readonly [number, number]): Vec2 {
  return { x: (c + 0.5) * arena.cellSize, y: (r + 0.5) * arena.cellSize };
}

function breach(walls: Wall[]): Wall[] {
  return walls.map((w) => (w.kind === 'destructible' ? { ...w, destroyed: true } : w));
}

/** The grid with `marks` overwritten as `*`, for failure messages. */
export function renderBoard(arena: Arena, marks: ReadonlyArray<[number, number]>): string {
  const rows = arena.grid.map((row) => [...row]);
  for (const [c, r] of marks) rows[r][c] = '*';
  return rows.map((row) => row.join('')).join('\n');
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

/** 4-neighbour flood fill over breachable cells. */
function reachable(arena: Arena): { open: number; reached: number } {
  const { rows, cols } = arena;
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
  let open = 0;
  let start: [number, number] | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isBreachable(arena, r, c)) {
        open++;
        if (!start) start = [r, c];
      }
    }
  }
  if (!start) return { open, reached: 0 };
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
  return { open, reached: reachedCount };
}

/**
 * The rules EVERY arena obeys, whatever it claims: no solid-sealed pockets, and no
 * enemy holding a straight line to the player spawn at spawn (Brown never moves, so
 * such a line is a death sentence three seconds into the level).
 *
 * Extracted from arena-validation.test.ts so a deliberately broken fixture can be
 * fed to it -- inline rules in a describe.each can only ever see arenas that exist.
 */
export function structuralFailures(arena: Arena): string[] {
  const failures: string[] = [];
  const { open, reached } = reachable(arena);
  if (reached !== open) {
    failures.push(
      `sealed pocket: ${reached} of ${open} breachable cells reachable\n${renderBoard(arena, [])}`,
    );
  }
  const { walls, spawns } = loadArena(arena);
  const player = spawns.find((s) => s.kind === 'player');
  if (!player) return [...failures, 'no player spawn'];
  for (const enemy of spawns.filter((s) => s.kind !== 'player')) {
    if (lineOfSight(enemy.pos, player.pos, walls)) {
      failures.push(
        `spawn sightline: ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) sees the player spawn`,
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
        // is silently blind to that; checking both is strictly stronger than the
        // bespoke test this claim type replaced, which only checked breached.
        const phases = [
          { name: 'intact', walls } as const,
          { name: 'breached', walls: breached } as const,
        ];
        for (const enemy of spawns.filter((s) => s.kind !== 'player')) {
          for (const off of offsets) {
            const target = { x: player.pos.x + off.x, y: player.pos.y + off.y };
            for (const phase of phases) {
              if (lineOfSight(enemy.pos, target, phase.walls)) {
                failures.push(
                  `spawnBlockRobust (${phase.name}): ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) sees the ` +
                  `player nudged by (${off.x}, ${off.y}) -- the block is a tangency, not a chord\n` +
                  `  why: ${claim.why}\n${renderBoard(arena, [])}`,
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
