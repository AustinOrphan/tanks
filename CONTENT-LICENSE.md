# First-party content notice

**Copyright Austin Orphan. All rights reserved.**

This notice covers the project's own **content**. It does not cover code, and it does not
cover third-party material. Three things govern this repository, and every file is under
exactly one of them:

| What | Governed by |
| --- | --- |
| Original code, tests and repository tooling | [`LICENSE`](LICENSE) — PolyForm Shield 1.0.0 |
| First-party content (this notice) | **All Rights Reserved** |
| Third-party components | Their own licenses, recorded in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) |

> This file records the project's licensing boundary. It is not legal advice.

## What is reserved

All rights are reserved in the project's first-party content, including:

- artwork, models, textures and materials;
- audio, music and sound design;
- levels, arenas, maps and their layout data;
- narrative, copy and other written game text;
- screenshots, captures and promotional media;
- logos, product names, and other branding.

Reserved content is **not** licensed by `LICENSE`. PolyForm Shield 1.0.0 licenses the
software; it grants no rights in the material above. Nothing here is dedicated to the
public domain, and no license to reserved content should be inferred from this repository
being readable.

## Classifying a file

The rules below are meant to settle any file in the tree without guessing. Where two could
apply, the more specific one wins.

**Third-party first.** Anything under `node_modules/`, and any dependency listed in
`THIRD-PARTY-NOTICES.md`, is governed solely by its own license. That generated file and
its verification remain the authoritative third-party notice path — this notice does not
restate, override or relicense any of it.

**Then reserved content:**

| Path | Why |
| --- | --- |
| `public/icons/**`, `public/favicon.svg` | branding and product marks |
| `public/audio/**` | audio (no audio is committed today — see [`CREDITS.md`](CREDITS.md)) |
| `src/sim/config/data/arenas.json`, `campaign.json`, `versus-catalog.json` | level, arena and map content |
| `docs/**` prose, and screenshots or captures referenced from it | narrative, copy and media |
| Product names and logos wherever they appear | branding |

**Everything else is code**, and is licensed under `LICENSE`: `src/**` (other than the
content data named above), `tools/**`, `tests`, build configuration, and repository
tooling.

**Two boundary cases, stated so they are not judgement calls:**

- **Generated output** (`dist/**`, gallery and capture output) inherits the license of
  whatever it was generated from. A bundle contains both code and reserved content.
- **Data files that are balance rather than content** — `balance.json`, `ai-profiles.json`,
  `tank-defs.json` — are **code**. They configure behaviour rather than describing a level
  or a piece of art, and the sim reads them the way it reads any other module.

## Permission

The owner may grant exceptions, commercial licenses, or modding permissions separately.
Separately granted **written** permission overrides the default above. Absent that, assume
reserved content is not licensed to you.
