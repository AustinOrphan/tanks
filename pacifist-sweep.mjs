// Free-win-rate sweep: same procedure as src/sim/ai/pacifist.test.ts, over an
// arbitrary seed population. Run at two refs to get the contrast.
import { createArenaWorld } from './src/sim/arena.ts'
import { step } from './src/sim/world.ts'
import { SHELL_SPAWN_FORWARD, BULLET_RADIUS } from './src/sim/constants.ts'

const TICK_CAP = 60 * 60 * 5
const FIRST = Number(process.argv[2] ?? 1)
const N = Number(process.argv[3] ?? 60)

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function playPacifist(seed) {
  let w = createArenaWorld(seed)
  const rnd = mulberry(seed * 7919 + 13)
  let heading = rnd() * Math.PI * 2
  let ticks = 0, fires = 0, mines = 0
  while (w.status === 'playing' && ticks < TICK_CAP) {
    if (ticks % 45 === 0) heading += (rnd() - 0.5) * 2.4
    const dir = { x: Math.cos(heading), y: Math.sin(heading) }
    const r = step(w, { move: dir, aim: dir, fire: false, mine: false })
    fires += r.events.filter((e) => e.type === 'fire').length
    mines += r.events.filter((e) => e.type === 'mine-dropped').length
    ticks++
    w = r.world
  }
  return { seed, outcome: w.status === 'playing' ? 'timeout' : w.status, ticks, fires, mines }
}

const rows = []
for (let i = 0; i < N; i++) rows.push(playPacifist(FIRST + i))
const wins = rows.filter((r) => r.outcome === 'win')
console.log(JSON.stringify({
  probe: { SHELL_SPAWN_FORWARD, BULLET_RADIUS },
  seeds: { first: FIRST, count: N },
  freeWins: wins.length,
  freeWinSeeds: wins.map((r) => r.seed),
  rate: wins.length / N,
  timeouts: rows.filter((r) => r.outcome === 'timeout').length,
  shotsPerRound: rows.reduce((n, r) => n + r.fires, 0) / N,
  minesPerRound: rows.reduce((n, r) => n + r.mines, 0) / N,
}, null, 1))
