// The README enemy table is generated from the canonical roster. Regenerate it with
// `npm run tanks:doc`; changing this test to accept drift defeats the guard.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arenaById } from '../../src/sim/config/arenas';
import { CAMPAIGN_LEVELS } from '../../src/sim/config/campaign';
import { firstAppearanceFor } from '../../src/sim/config/first-appearance';
import { GAME_TANK_DEFS } from '../../src/sim/config/roster';
import { TANK_KINDS } from '../../src/sim/config/validate';
import {
  firstMissionCell,
  NOT_IN_CAMPAIGN,
  renderEnemyRosterBlock,
  replaceEnemyRoster,
  rosterOrder,
  ROSTER_END,
  ROSTER_START,
} from './render';

const README = fileURLToPath(new URL('../../README.md', import.meta.url));

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('README enemy roster is generated, not hand-edited', () => {
  it('contains exactly one current generated block', () => {
    const committed = readFileSync(README, 'utf8');
    expect(occurrences(committed, ROSTER_START)).toBe(1);
    expect(occurrences(committed, ROSTER_END)).toBe(1);
    expect(replaceEnemyRoster(committed)).toBe(committed);
  });

  it('includes every configured enemy and excludes the player', () => {
    const rendered = renderEnemyRosterBlock();
    expect(rendered.length).toBeGreaterThan(700);

    for (const kind of TANK_KINDS) {
      const rowStart = `| ${GAME_TANK_DEFS[kind].displayName} |`;
      if (kind === 'player') {
        expect(rendered).not.toContain(rowStart);
      } else {
        expect(rendered).toContain(rowStart);
      }
    }
  });

  it("renders each enemy's First mission from the campaign, never from an authored number (issue #777)", () => {
    const rendered = renderEnemyRosterBlock();
    for (const kind of TANK_KINDS.filter((k) => k !== 'player')) {
      const derived = firstMissionCell(firstAppearanceFor(CAMPAIGN_LEVELS, arenaById, kind));
      expect(rendered, kind).toContain(`| ${GAME_TANK_DEFS[kind].displayName} | ${derived} |`);
    }
  });

  it('shows a kind the campaign never spawns as absent, not as a number', () => {
    expect(firstMissionCell(null)).toBe(NOT_IN_CAMPAIGN);
    expect(firstMissionCell(4)).toBe('4');
  });

  it('orders rows by first appearance, then catalog order, with absent kinds last', () => {
    // Synthetic, because the shipped roster's derived order happens to equal its catalog order,
    // so it cannot tell "sorted by appearance" from "not sorted at all".
    const appearance: Record<string, number | null> = { a: 3, b: null, c: 1, d: 1, e: null };
    expect(rosterOrder(['a', 'b', 'c', 'd', 'e'], (k) => appearance[k])).toEqual(['c', 'd', 'a', 'b', 'e']);
    // The same appearances in another catalog order: ties and absences follow it.
    expect(rosterOrder(['e', 'd', 'c', 'b', 'a'], (k) => appearance[k])).toEqual(['d', 'c', 'a', 'e', 'b']);
  });

  it('identifies its source and regeneration command', () => {
    const rendered = renderEnemyRosterBlock();
    expect(rendered).toContain('Generated');
    expect(rendered).toContain('npm run tanks:doc');
    expect(rendered).toContain('tank-defs.json');
    expect(rendered).toContain('ai-profiles.json');
  });
});
