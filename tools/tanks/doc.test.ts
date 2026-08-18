// The README enemy table is generated from the canonical roster. Regenerate it with
// `npm run tanks:doc`; changing this test to accept drift defeats the guard.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GAME_TANK_DEFS } from '../../src/sim/config/roster';
import { TANK_KINDS } from '../../src/sim/config/validate';
import {
  renderEnemyRosterBlock,
  replaceEnemyRoster,
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

  it('identifies its source and regeneration command', () => {
    const rendered = renderEnemyRosterBlock();
    expect(rendered).toContain('Generated');
    expect(rendered).toContain('npm run tanks:doc');
    expect(rendered).toContain('tank-defs.json');
    expect(rendered).toContain('ai-profiles.json');
  });
});
