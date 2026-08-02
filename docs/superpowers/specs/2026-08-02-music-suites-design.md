# Music suites: sets of interchangeable tracks, and the joins between sets

Austin, 2026-08-02: *"the tracks … may need to be longer or at least be categorized
such that there can be, like, four tracks that are very similar in theme and
construction and build and flow together nicely no matter what order they're put
in, and they can at the beginning and end of those tracks have a smooth transition
into another set of, say, four tracks … that have their own identity."*

## The two-level model

- A **suite** is a set of tracks that share an identity and interchange freely.
  Any member may follow any other, in any order, with no audible join.
- **Suites chain**: leaving one suite for another is a deliberate, handled
  moment, not a cut.

Within a suite the joins are free *because* members share key, tempo, bar length
and progression — measured on the arena family, all four joins land at a sample
step of exactly 0. Only texture varies. Across suites those very things differ,
which is the whole problem: **key and tempo are what make a cross-suite join
hard.** Everything else is instrumentation and does not fight.

## Approved: per-suite tempo, with a ramp at the join

Suites may genuinely differ in tempo — a lull and an assault should not run at
the same pulse. The scheduler therefore accelerates or decelerates across the
transition rather than switching instantly.

The ramp is over the transition span only, and the step length is interpolated
per step (not per frame), so it stays a pure function of the step index. A ramp
that drifted would desynchronise the grid, which is why the existing
"gaps are a whole number of steps" pin must keep passing across a transition.

## Transitions: three strategies, one implemented first

Austin: *"we have to prepare to be able to use any of these, but we can start with
one and try out the others."* So the strategy is **data, per suite**, and the
mechanism is chosen by name. All three are described here; only `dominant` ships
in the first pass.

### 1. `dominant` — generated (the default, and the one built first)

Every key has one chord that sounds unfinished and pulls toward its home chord:
the fifth degree. In A minor that is E; in D minor it is A. Before switching to
a suite in key X, play one bar of **the dominant of X** at the outgoing tempo,
then switch. The ear hears "this wants to resolve to X", and X arrives sounding
intended rather than abrupt.

The arena track already uses this internally — its final bar is E, which is why
the loop pulls back to A minor rather than merely stopping.

**Why this one first:** it is derived from the incoming suite's declared key, so
N suites cost N declarations rather than N² bridges, and a newly written suite
works with every existing one the day it is added.

### 2. `outro` — one authored exit phrase per suite

Each suite ends with a written phrase that lands on a neutral pivot every other
suite can begin from. More musical control over how a suite says goodbye; costs
one composition per suite, and constrains every suite to agree on the pivot.

### 3. `bridge` — an authored passage per ordered pair

Maximum control: each A→B join is composed. With four suites that is twelve
bridges, and every new suite needs one against every existing suite. Worth it
only if the joins are themselves a feature you want to hear.

## Track length

Four 9.6-second members means a member repeats roughly every 38 seconds. Members
double to 16 bars, which pushes a repeat past two minutes; combined with
generated layers (which never repeat) the surface does not recur at all.

## Data shape

```json
{
  "id": "assault",
  "key": "Am",
  "stepSeconds": 0.15,
  "transition": "dominant",
  "members": ["arena", "arena-push", "arena-lull", "arena-charge"]
}
```

`key` is what the dominant is derived from and what a future `outro`/`bridge`
strategy would pivot around. Members are validated to agree with the suite on
tempo, bar length and progression — a member that disagrees cannot join
seamlessly, and that should be a boot failure naming the path, like every other
data error in this repo.

## Selection

A shuffle-bag over members, not independent draws: uniform random repeats a
member immediately about one time in four, which reads as more broken than a
plain loop. The bag also avoids the reverse mistake of a fixed rotation, which
becomes its own audible pattern.

## Testing

- Any member may follow any other with the step grid unbroken — swept over all
  ordered pairs, not sampled.
- A transition lands on a cycle boundary and the ramp never breaks the grid.
- The generated dominant is the correct chord for the incoming key, swept over
  every key the suites declare.
- Validation refuses a member that disagrees with its suite on tempo/bars/
  progression, with a negative control per field.

## Explicitly later

`outro` and `bridge` strategies; per-suite instrumentation defaults; suites
selected by game state (level, round phase) rather than by playlist order.
