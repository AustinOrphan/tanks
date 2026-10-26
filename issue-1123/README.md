# Issue #1123 evidence: the death vignette for every human player

Captured 2026-10-26 from a build of branch fix/death-vignette-every-human-player, through the
screens tooling's `versus-round` flow at 1280x800 on the host GPU. Autoplay drives slot 0;
every other slot is a person left idle unless a bot claims it. A MutationObserver on
`.hud-damage` logged every flash with its color beside each slot's stock.

- `ffa-p2-death-flash.png`: two-player FFA, seed 42. P2's death tints the vignette P2's
  orange (#ff8a1e), and P2's strip has lost a stock. For this still the CSS animation was held
  at its 12% keyframe (peak opacity), then released.
- `teams-p2-death-flash.png`: two-player Teams, seed 42. P2's death tints the vignette team
  B's pink (#fcc0fc), the team color rather than the slot's.
- `ffa3-bot-control-log.json`: three-player FFA with slot 2 a bot, seed 7. The bot lost stock
  three times with no flash logged; human P2's deaths flashed #ff8a1e and P1's #3fd0ff.
