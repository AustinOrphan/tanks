import { describe, it, expect } from 'vitest';
import {
  botSlotsOf,
  resolveSources,
  versusSetupProblem,
  type VersusSlotRole,
  type VersusSlotSetup,
} from './versus-setup';
import { seedAssignment } from './loop';
import type { DetectedPad } from '../input/gamepad';
import type { SlotSource } from '../input/assignment';

// ---------------------------------------------------------------------------
// THE SETUP-TO-SESSION MATRIX, and the one thing it found (issue #969).
//
// HOW THIS FILE EARNED ITS PLACE, stated plainly because most of what it was written for
// turned out to be covered already. The audit on #969 named two gaps -- a matrix sweep, and
// a launch-level inert-slot assertion -- and a mutation test refuted BOTH:
//
//   * `resolveSources`' pad hand-out changed to `nextPad < 2`, so no third pad is ever
//     given out, is killed by SEVEN existing tests across three files, including
//     `loop.test.ts`'s "VS: leaves a human with no controller as none, so the gate can name
//     it". The launch seam is already asserted; there was no inert-slot gap.
//
// What survived is narrower and is the reason this file exists:
//
//   * `padIndex: pads[nextPad++]` changed to `padIndex: pads[Math.min(nextPad++, 1)]` --
//     so a THIRD human slot re-binds the SECOND pad -- left five test files green
//     (`hud.navigation`, `loop`, `versus-setup`, `assignment`, `controllers-pane`).
//     Two players would drive one tank each from a single physical controller.
//
// It survived for a measurable reason: no existing case needs a third pad. The closest,
// `versus-setup.test.ts`'s "gives slot 0 this device and later human slots the connected pads
// in order", uses three slots and TWO pads, so `Math.min(nextPad, 1)` is the identity there.
// Reaching the defect needs four humans and three pads, which only a sweep does.
//
// So the assertion this file adds is DEVICE DISTINCTNESS, and the sweep is the vehicle that
// reaches the arity where it can fail. The inert-slot and Start-gate checks below are kept as
// cheap invariants over the same population -- they are NOT new coverage, and the comment
// above is there so no reader mistakes them for it.
// ---------------------------------------------------------------------------

/** A pad the game can read: `unsupported` absent is what `unreadablePadIndices` keys on. */
const pad = (padIndex: number): DetectedPad => ({ padIndex, id: `pad-${padIndex}` });

/**
 * The pads a mix needs to be launchable: the FIRST human slot takes this device
 * (`resolveSources` assigns `keyboard` once), and every later human needs a pad of its own.
 */
const padsFor = (humans: number): DetectedPad[] =>
  Array.from({ length: Math.max(0, humans - 1) }, (_, i) => pad(i));

const slotsFor = (roles: readonly VersusSlotRole[]): VersusSlotSetup[] =>
  roles.map((role) => ({ role }));

/** A playing slot left bound to nothing -- the "inert required slot" criterion 2 names. */
const inertPlayingSlots = (
  roles: readonly VersusSlotRole[],
  assignment: readonly SlotSource[],
): number[] =>
  roles.flatMap((role, i) => (role !== 'none' && assignment[i]?.kind === 'none' ? [i] : []));

/**
 * Every physical device the assignment binds, as a comparable token. `keyboard` is one
 * device too -- two slots both reading this keyboard is the same defect as two slots sharing
 * a pad -- so it is counted here rather than excluded.
 */
const devicesOf = (assignment: readonly SlotSource[]): string[] =>
  assignment.flatMap((s) =>
    s.kind === 'gamepad' ? [`pad:${s.padIndex}`] : s.kind === 'keyboard' ? ['keyboard'] : [],
  );

/**
 * REPRESENTATIVE role mixes, not every arrangement. Per player count: all-human, one human
 * with the rest bots, and (at 3 and 4) a mixed middle. Teams validity is not varied here
 * because `representedTeams` falls back to `teamOf(i)` = `i % 2`, so every mix below spans
 * two teams by construction; explicit 2v2 and 2v1v1 team choices are already covered by
 * `versus-setup.test.ts`'s own team cases.
 *
 * THE FOUR-HUMAN MIX IS THE LOAD-BEARING ONE. It is the only case in the repository that
 * hands out a third pad, and it is what kills the duplicate-binding mutation.
 */
const MIXES: { players: 2 | 3 | 4; roles: VersusSlotRole[] }[] = [
  { players: 2, roles: ['human', 'human'] },
  { players: 2, roles: ['human', 'bot'] },
  { players: 3, roles: ['human', 'human', 'human'] },
  { players: 3, roles: ['human', 'human', 'bot'] },
  { players: 3, roles: ['human', 'bot', 'bot'] },
  { players: 4, roles: ['human', 'human', 'human', 'human'] },
  { players: 4, roles: ['human', 'human', 'bot', 'bot'] },
  { players: 4, roles: ['human', 'bot', 'bot', 'bot'] },
];

const MODES = ['ffa', 'teams'] as const;

describe('the VS setup-to-session matrix (issue #969)', () => {
  it('never binds two slots to one device, across every mode x player-count x role mix', () => {
    let combinations = 0;
    let humansBound = 0;
    let maxPadsHandedOut = 0;
    const shared: string[] = [];
    const inert: string[] = [];
    const refused: string[] = [];

    for (const mode of MODES) {
      for (const { players, roles } of MIXES) {
        combinations += 1;
        const label = `${mode} N=${players} [${roles.join(',')}]`;
        const slots = slotsFor(roles);
        const humans = roles.filter((r) => r === 'human').length;
        const pads = padsFor(humans);

        // The pane's own view: what the Start gate is allowed to consult.
        const sources = resolveSources(slots, pads.map((p) => p.padIndex));
        const problem = versusSetupProblem(slots, sources, mode);
        if (problem !== null) refused.push(`${label}: ${problem.kind}`);

        // THE LAUNCH, through the seam the shipped path calls -- imported from `loop.ts`
        // rather than re-derived here, so this is not a test of a copy of the rule.
        const assignment = seedAssignment(slots, players, botSlotsOf(slots).size, pads);
        expect(assignment, label).toHaveLength(players);

        // THE ASSERTION THIS FILE IS FOR.
        const devices = devicesOf(assignment);
        humansBound += devices.length;
        maxPadsHandedOut = Math.max(maxPadsHandedOut, devices.filter((d) => d !== 'keyboard').length);
        if (new Set(devices).size !== devices.length) shared.push(`${label}: ${devices.join(' ')}`);

        const dead = inertPlayingSlots(roles, assignment);
        if (dead.length > 0) inert.push(`${label}: slot(s) ${dead.join(',')}`);
      }
    }

    // THE DEFECT-BEARING ASSERTION: no device drives two slots.
    expect(shared, 'combinations where one device was bound to two slots').toEqual([]);

    // The population, stated beside the counts. 16 = 2 modes x 8 role mixes; 32 human slots
    // = 2 modes x 16 humans per mode, which is (2+1) at N=2 + (3+2+1) at N=3 + (4+2+1) at
    // N=4. These pin the SWEEP rather than production: if a mix is dropped the sweep shrinks
    // silently, and the whole point of the four-human case is that it is present. Same reason
    // `versus-board.test.ts` pins its own `checked` count and `ARENA_DEFS.length`.
    expect(combinations, '2 modes x 8 role mixes').toBe(16);
    expect(humansBound, 'human slots bound to a device across the sweep').toBe(32);
    // ...and the arity that makes the distinctness assertion able to fail at all. Two pads
    // cannot expose a third-pad defect, so if this ever drops below 3 the assertion above
    // stops discriminating even while it still passes.
    expect(maxPadsHandedOut, 'the sweep must hand out a THIRD pad somewhere').toBe(3);

    // Cheap invariants over the same population. NOT new coverage -- see the file header.
    expect(refused, 'combinations the Start gate refused').toEqual([]);
    expect(inert, 'playing slots bound to nothing after seedAssignment').toEqual([]);
  });

  it('gives a fourth human the third pad, which is the case no other test reaches', () => {
    // The distinctness assertion above, spelled out as one readable case so a failure in the
    // sweep can be read against it. Four humans, three pads: this device plus pads 0, 1, 2 --
    // each exactly once.
    const roles: VersusSlotRole[] = ['human', 'human', 'human', 'human'];
    const pads = padsFor(4);
    expect(pads.map((p) => p.padIndex)).toEqual([0, 1, 2]);
    const assignment = seedAssignment(slotsFor(roles), 4, 0, pads);
    expect(assignment).toEqual([
      { kind: 'keyboard' },
      { kind: 'gamepad', padIndex: 0 },
      { kind: 'gamepad', padIndex: 1 },
      { kind: 'gamepad', padIndex: 2 },
    ]);
  });

  it('a pad lost between the gate and the launch leaves the later humans inert, not rebound', () => {
    // Already covered by `versus-setup.test.ts` and `loop.test.ts` at lower arity; kept at
    // FOUR humans because that is this file's population, and because the two resolutions
    // reading different pad sets is the hazard the sweep's single-pad-set discipline avoids.
    // `seedAssignment`'s own doc: devices are "re-resolved densely against what is plugged in
    // RIGHT NOW".
    const roles: VersusSlotRole[] = ['human', 'human', 'human', 'human'];
    const slots = slotsFor(roles);
    const atGate = resolveSources(slots, padsFor(4).map((p) => p.padIndex));
    expect(versusSetupProblem(slots, atGate, 'ffa'), 'valid while the pads are present').toBeNull();

    const launched = seedAssignment(slots, 4, 0, []);
    expect(inertPlayingSlots(roles, launched), 'slots 1-3 have nothing to drive them')
      .toEqual([1, 2, 3]);
    // Slot 0 keeps this device, so the failure is partial -- which is why counting inert
    // slots is the right shape and "did it launch" is not.
    expect(launched[0].kind).toBe('keyboard');
  });
});
