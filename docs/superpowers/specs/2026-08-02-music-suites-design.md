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

### 1. `dominant` — the pickup entry (the shipped strategy, fifth design)

Four earlier attempts each composed interstitial material — a held pad, then
arpeggios, then rolled swells — and Austin rejected every one, finally naming
the law they all broke: *"you're still using something that exists in neither
section to bridge between the two and it's off."* **A bridge may use only
material the sections themselves contain.**

The through-line construction supplies it. Every progression ends on its own
dominant (arena's last bar is E pulling home to Am; vanguard's is A pulling to
Dm), so the incoming piece's **own final bar is already the entry music**: it is
played first, as a pickup, then the cycle starts from the top. The tempo ramp
rides across that bar. Nothing is synthesised except the tempo interpolation.

The validator enforces what the entry trusts: a suite whose members do not end
on the dominant of its key is a boot failure, not a sour join found by ear.

**Why this one:** zero authored bridges, zero invented material, and any new
suite that follows the construction recipe works with every existing one.

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

## Compatibility rules (added 2026-08-02, after the siege join jarred)

Austin heard the assault-to-siege join as "suddenly and pretty jarringly"
transformed, and the diagnosis was contrast, not machinery: 47% tempo gap, on
top of a key and texture change. Rules, per his direction "within 20% tempo and
related keys, probably weight same keys higher and then related keys":

- **Tempo is a hard limit**: adjacent suites must be within 20% (`TEMPO_RATIO_LIMIT`).
  Beyond that a ramp reads as a gear change no matter what the harmony does.
- **Key is a weight** (`keyAffinity`): same key 4, relative major/minor or a
  fifth apart in the same mode 2, parallel major/minor 1, anything else 0 --
  excluded outright.
- `pickNextSuite` draws in proportion to those weights; `rankCandidates` is the
  pure policy underneath it, testable without randomness.

## The through line

Austin: "maybe there needs to be a reasonably consistent through line in sets?
Not monotonous but clearly related." Made structural rather than hoped for:
sibling suites share **construction**, not material. The vanguard family is the
arena family's shape in another key -- the same progression *skeleton*
(i-VI-VII-V, the V major for its leading tone), the same 16-step bars, the same
rhythmic cells (octave-jump bass, backbeat stabs), the same four textures
(base / push / lull / charge) -- with its own pitches, pulse and generated
lines. Clearly siblings; not the same piece. New suites should follow the same
recipe: copy the construction, change the material.

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
