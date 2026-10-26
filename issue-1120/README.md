# Issue #1120 evidence: the converging spawn entrance

Each `respawn-<style>-before-after.gif` is the gallery's `respawn` moment (a kill at tick 18,
the revival at tick 138), BEFORE on the left and AFTER on the right, at game speed:

    npm run gallery -- --scene respawn --view close --anim --subdiv 1 --fps 60 --spawn-anim <style>

- BEFORE: main 72b0b2bf. Every entrance ring starts on the tank and expands outward.
- AFTER: branch feat/converging-spawn-entrance (b9a00ffc). Every entrance ring starts wide and
  faint and closes onto the tank, brightest as it lands; the death pulse at the start of each
  clip is the same thin expanding ring in both halves.

`respawn-warp-reduced-motion-after.gif` is the AFTER warp render with `--motion reduced`: the
ring holds at the landing radius and only fades in.

Rendered 2026-10-26 on an M1 Max with the repository's gallery tool.
