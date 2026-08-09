# Tanks!

A top-down arena tank game. Clear the arena; one shot kills anything, including you.

Three.js renderer over a pure, deterministic 2D simulation — swept ray-vs-AABB shell
physics with in-tick reflection, proximity mines, and three enemy personalities.

| Enemy | Movement | Under fire | Mines | Shells |
| ----- | -------- | ---------- | ----- | ------ |
| Brown | Static | — | No | Normal, leads its target |
| Grey | Roams | Cautious — holds fire, then shoots back | Yes | Normal, leads its target |
| Teal | Roams | Aggressive — dodges *and* fires | Yes | Ricochet only, alternates bank/direct |

## Controls

| | |
| --- | --- |
| Move | `WASD` / arrow keys |
| Aim | Mouse |
| Fire | Left click |
| Drop mine | `Space` / right click |
| Mute | `M` |

## Development

Requires Node 20 or newer.

```sh
npm install
npm run dev      # vite dev server
npm test         # typecheck + 300+ vitest specs
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the built bundle
```

## Architecture

`src/sim/` is a pure, deterministic core: given a seed and an input stream it
produces the same world, tick for tick. It imports nothing from Three.js, the
DOM, or Howler — `src/sim/purity.test.ts` enforces that automatically and fails
naming the offending file and token.

Everything else is a one-way projection of sim state:

- `src/render/` interpolates between the previous and current world at the
  display's refresh rate, independent of the fixed 60 Hz sim.
- `src/audio/` maps `SimEvent`s to sound.
- `src/game/` owns the fixed-timestep loop, the state machine, and the HUD.

The build sets `base: './'`, so `dist/` is portable to any static host and any
subpath without reconfiguration.

## Audio assets

None are committed. `public/audio/` holds only a `.gitkeep`, so the manifest
declares nothing and the engine synthesises every sound in Web Audio rather than
requesting files that are not there — a deliberate choice, not a degraded mode,
so development is never blocked on assets. (It used to declare all ten anyway and
let each 404: 10 requests and 93,790 uncached bytes per load, measured against the
deployed site.) See [CREDITS.md](CREDITS.md); its attribution tables are
intentionally empty rather than fabricated.
