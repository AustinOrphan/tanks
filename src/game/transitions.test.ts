import { describe, it, expect } from 'vitest';
import { createTransitionRunner, type TransitionRunner } from './transitions';

/** A controllable clock: nothing fires until `advance` is called. */
function harness(durationMs = 150): {
  runner: TransitionRunner;
  advance(ms: number): void;
  log: string[];
  timersLive(): number;
  setDuration(ms: number): void;
} {
  let now = 0;
  let next = 1;
  let duration = durationMs;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const runner = createTransitionRunner({
    durationMs: () => duration,
    setTimeout: (fn, ms) => {
      const h = next++;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h) => {
      timers.delete(h);
    },
  });
  return {
    runner,
    log,
    timersLive: () => timers.size,
    setDuration: (ms) => {
      duration = ms;
    },
    advance(ms: number): void {
      now += ms;
      for (const [h, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(h);
          t.fn();
        }
      }
    },
  };
}

describe('createTransitionRunner: the shape of one transition', () => {
  it('runs `begin` synchronously and defers `settle` by the duration', () => {
    // Focus moves in `begin`, which is what makes "focus lands before the animation ends"
    // structural rather than a race: it has already happened when `run` returns.
    const h = harness(150);
    h.runner.run(() => h.log.push('begin'), () => h.log.push('settle'));
    expect(h.log, 'settle ran early, or begin was deferred').toEqual(['begin']);
    h.advance(149);
    expect(h.log).toEqual(['begin']);
    h.advance(1);
    expect(h.log).toEqual(['begin', 'settle']);
  });

  it('releases its timer once settled', () => {
    const h = harness(150);
    h.runner.run(() => {}, () => {});
    expect(h.runner.pending).toBe(1);
    h.advance(150);
    expect(h.runner.pending, 'the settled transition kept its timer').toBe(0);
    expect(h.timersLive()).toBe(0);
  });
});

describe('createTransitionRunner: reduced motion and a missing stylesheet', () => {
  it('a zero duration settles synchronously, scheduling nothing at all', () => {
    // Criterion 5: instant under reduced motion, with every other property intact. The
    // same path covers a build whose stylesheet did not load, because the duration is READ
    // from the stylesheet and there is deliberately no fallback constant.
    const h = harness(0);
    h.runner.run(() => h.log.push('begin'), () => h.log.push('settle'));
    expect(h.log, 'an instant transition deferred its settle').toEqual(['begin', 'settle']);
    expect(h.runner.pending).toBe(0);
    expect(h.timersLive(), 'an instant transition still scheduled a timer').toBe(0);
  });

  it('reads the duration per transition, so toggling reduced motion takes effect at once', () => {
    // Read at construction instead, and a player switching reduced motion on in Settings
    // would keep animating until the next reboot.
    const h = harness(150);
    h.setDuration(0);
    h.runner.run(() => h.log.push('begin'), () => h.log.push('settle'));
    expect(h.log).toEqual(['begin', 'settle']);
  });
});

describe('createTransitionRunner: interruption', () => {
  it('a second transition settles the first IMMEDIATELY, leaving nothing intermediate', () => {
    // Criterion 3. Cancelling the first instead would leave the screen it was in the
    // middle of hiding still on screen, underneath the new one.
    const h = harness(150);
    h.runner.run(() => h.log.push('begin-A'), () => h.log.push('settle-A'));
    h.advance(50);
    h.runner.run(() => h.log.push('begin-B'), () => h.log.push('settle-B'));
    expect(h.log, "the first transition's end state was not applied before the second began")
      .toEqual(['begin-A', 'settle-A', 'begin-B']);
    h.advance(150);
    expect(h.log).toEqual(['begin-A', 'settle-A', 'begin-B', 'settle-B']);
  });

  it('the interrupted transition never settles a SECOND time', () => {
    // The other half: settling early must consume it, or the original timer would fire
    // later and re-hide a screen the second navigation had just brought back.
    const h = harness(150);
    h.runner.run(() => {}, () => h.log.push('settle-A'));
    h.runner.run(() => {}, () => h.log.push('settle-B'));
    h.advance(1000);
    expect(h.log).toEqual(['settle-A', 'settle-B']);
  });

  it('repeated fast navigation holds at most ONE timer and leaks none', () => {
    // Criterion 6, asserted rather than observed. `pending` never exceeding 1 is the
    // structural claim; `timersLive()` reads the harness's own map, so a runner that
    // dropped handles without clearing them would show up here even though `pending` lied.
    const h = harness(150);
    for (let i = 0; i < 20; i++) {
      h.runner.run(() => {}, () => h.log.push(`settle-${i}`));
      expect(h.runner.pending, `after run ${i}`).toBe(1);
      expect(h.timersLive(), `after run ${i}`).toBe(1);
      h.advance(10);
    }
    h.advance(150);
    expect(h.runner.pending).toBe(0);
    expect(h.timersLive(), 'repeated navigation left timers behind').toBe(0);
    expect(h.log.length, 'every transition settled exactly once').toBe(20);
  });

  it('a transition started from an INTERRUPTED settle is settled, not orphaned', () => {
    // Found by mutating `settleNow`'s clear-before-run ordering and watching all ten
    // other tests stay green: they only ever exercised the TIMER path, so the interrupt
    // path's bookkeeping was unpinned. Probing it showed the real defect -- two live
    // timers while `pending` reported 1, and the chained transition's end state never
    // applied. `pending` is the field criterion 6 is asserted on, so a leak it cannot see
    // is the worst shape this bug could take.
    const h = harness(150);
    let chained = false;
    h.runner.run(
      () => h.log.push('begin-A'),
      () => {
        h.log.push('settle-A');
        if (chained) return;
        chained = true;
        h.runner.run(() => h.log.push('begin-C'), () => h.log.push('settle-C'));
      },
    );
    // B interrupts A. A's settle starts C; C is superseded by B before it can run.
    h.runner.run(() => h.log.push('begin-B'), () => h.log.push('settle-B'));

    expect(h.timersLive(), 'the chained transition orphaned a timer').toBe(1);
    expect(h.runner.pending, 'pending disagreed with the live timer count').toBe(h.timersLive());
    // The old chain resolves COMPLETELY before the new transition begins, so the
    // superseded end state cannot land on top of the arriving screen.
    expect(h.log, "the superseded transition's end state was never applied").toEqual([
      'begin-A', 'settle-A', 'begin-C', 'settle-C', 'begin-B',
    ]);

    h.advance(150);
    expect(h.log.at(-1)).toBe('settle-B');
    expect(h.timersLive(), 'a timer outlived the whole sequence').toBe(0);
  });

  it('a settle that starts another transition is not cancelled by its own predecessor', () => {
    // A screen that navigates on arrival. `settleNow` clears its bookkeeping BEFORE
    // running the callback; doing it after would have the finished transition wipe the
    // handle of the one its own settle just started.
    const h = harness(150);
    let chained = false;
    h.runner.run(
      () => {},
      () => {
        if (chained) return;
        chained = true;
        h.runner.run(() => h.log.push('begin-chained'), () => h.log.push('settle-chained'));
      },
    );
    h.advance(150);
    expect(h.log).toEqual(['begin-chained']);
    expect(h.runner.pending, 'the chained transition lost its timer').toBe(1);
    h.advance(150);
    expect(h.log).toEqual(['begin-chained', 'settle-chained']);
  });
});

describe('createTransitionRunner: disposal', () => {
  it('settles what is outstanding rather than dropping it', () => {
    // A HUD torn down mid-transition would otherwise leave the outgoing screen's leaving
    // state on an element the next session reuses.
    const h = harness(150);
    h.runner.run(() => {}, () => h.log.push('settle'));
    h.runner.dispose();
    expect(h.log, 'dispose dropped the outstanding end state').toEqual(['settle']);
    expect(h.timersLive()).toBe(0);
  });

  it('schedules nothing after disposal', () => {
    const h = harness(150);
    h.runner.dispose();
    h.runner.run(() => h.log.push('begin'), () => h.log.push('settle'));
    expect(h.log, 'a disposed runner still ran a transition').toEqual([]);
    expect(h.timersLive()).toBe(0);
  });
});
