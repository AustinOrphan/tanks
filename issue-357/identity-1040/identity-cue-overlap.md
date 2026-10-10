three 0.186.1, software-gl (SwiftShader), 640x480 frames, view game, dpr 1, posed identity element: 4 player tanks (slots 0-3) x 2 markers = 8 cells, 7.1 s

Owner footprint: the pixels that differ when that slot's identity-ring is hidden, in the frame with the cue absent and again with it drawn.
Cue footprint: the pixels that differ when that slot's mine-block is hidden, under --enemyRole both. Shared: owner (cue absent) and own cue.
Covered: of the shared pixels, those outside the cue-drawn owner footprint, i.e. ring pixels the riser hides. Shared, cue-drawn owner: pixels both draw into.

| marker | slot | body angle | owner px, cue absent | owner px, cue drawn | cue px | shared px | covered px | shared px, cue-drawn owner | shared px with other slots' cues |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| shape | 0 | 0 deg | 812 | 812 | 188 | 0 | 0 | 0 | 0 |
| shape | 1 | 90 deg | 736 | 732 | 97 | 5 | 4 | 1 | 0 |
| shape | 2 | 180 deg | 763 | 763 | 30 | 0 | 0 | 0 | 0 |
| shape | 3 | 45 deg | 741 | 741 | 175 | 0 | 0 | 0 | 0 |
| ring | 0 | 0 deg | 873 | 873 | 188 | 0 | 0 | 0 | 0 |
| ring | 1 | 90 deg | 988 | 984 | 97 | 6 | 4 | 2 | 0 |
| ring | 2 | 180 deg | 928 | 928 | 30 | 0 | 0 | 0 | 0 |
| ring | 3 | 45 deg | 766 | 766 | 175 | 0 | 0 | 0 | 0 |

Slots with a nonzero shared count, shape (population: 4 slots): 1.
Slots with a nonzero shared count, ring (population: 4 slots): 1.

CLI frame, shape-cue: npm run gallery -- --elements identity --identityMarker shape --enemyRole both --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-shape-cue
CLI frame, ring-cue: npm run gallery -- --elements identity --enemyRole both --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-ring-cue
CLI frame, shape-nocue: npm run gallery -- --elements identity --identityMarker shape --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-shape-nocue
CLI frame, ring-nocue: npm run gallery -- --elements identity --view game --w 640 --h 480 --out gallery-out/identity-cue-overlap-ring-nocue

| control | result | detail |
| --- | --- | --- |
| slots, shape | pass | 4 and 4 ringed tanks; want slots 0-3 by ring colour in x order, one mine-block each with the cue, none without |
| repeat draw identical, shape | pass | 0 pixels differ between the first and last full draw |
| cue is the riser alone, shape | pass | 0 pixels differ from no --enemyRole with all four mine-blocks hidden; 490 with them drawn |
| cue attribution complete, shape | pass | 490 pixels in the four slots' cue footprints, 490 between the arms |
| staging guard, shape | pass | 0 of 4 slots with an empty owner or cue footprint |
| a footprint against itself is all shared, shape | pass | 4 of 4 slots report their whole owner and cue footprint as shared with itself |
| disjoint rings share nothing, shape | pass | 0 pixels shared between different slots' rings |
| per-slot shared accounts for every owner and cue pixel, shape | pass | 5 pixels across the rows, 5 in all owner footprints and all cue footprints |
| slots, ring | pass | 4 and 4 ringed tanks; want slots 0-3 by ring colour in x order, one mine-block each with the cue, none without |
| repeat draw identical, ring | pass | 0 pixels differ between the first and last full draw |
| cue is the riser alone, ring | pass | 0 pixels differ from no --enemyRole with all four mine-blocks hidden; 490 with them drawn |
| cue attribution complete, ring | pass | 490 pixels in the four slots' cue footprints, 490 between the arms |
| staging guard, ring | pass | 0 of 4 slots with an empty owner or cue footprint |
| a footprint against itself is all shared, ring | pass | 4 of 4 slots report their whole owner and cue footprint as shared with itself |
| disjoint rings share nothing, ring | pass | 0 pixels shared between different slots' rings |
| per-slot shared accounts for every owner and cue pixel, ring | pass | 6 pixels across the rows, 6 in all owner footprints and all cue footprints |
| page frame is the CLI frame, shape-cue | pass | 0 pixels differ from the CLI's shape-cue frame; 4528 from its ring-cue frame |
| page frame is the CLI frame, shape-nocue | pass | 0 pixels differ from the CLI's shape-nocue frame; 490 from its shape-cue frame |
| page frame is the CLI frame, ring-cue | pass | 0 pixels differ from the CLI's ring-cue frame; 4528 from its shape-cue frame |
| page frame is the CLI frame, ring-nocue | pass | 0 pixels differ from the CLI's ring-nocue frame; 490 from its ring-cue frame |
