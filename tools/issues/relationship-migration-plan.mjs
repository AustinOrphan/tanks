// Reviewed one-time migration ledger for GitHub's native issue relationships.
//
// Parent edges model decomposition. An issue can have only one native parent, so
// cross-cutting roll-ups remain ordinary references in issue bodies. Blocked-by
// edges model hard implementation prerequisites, not mere coordination.
export const RELATIONSHIP_MIGRATION = Object.freeze({
  repository: 'AustinOrphan/tanks',
  parents: Object.freeze([
    { parent: 294, children: [315, 355] },
    {
      parent: 315,
      children: [
        117, 226, 227, 228, 238, 240, 258, 289, 290, 316, 317, 318, 319, 320,
        321, 322, 323, 324, 325, 326, 327, 351, 364, 365, 366, 368,
        // Issue #691: declared `Parent: #315` in its body after the first migration ran.
        616,
      ],
    },
    // Issue #691: the firing-budget comparison and its leaves, whose bodies declared these
    // parents after the first migration ran.
    // #720: split out of #358 by the 2026-09-14 triage (see the block below).
    { parent: 358, children: [518, 720] },
    { parent: 518, children: [519, 520, 521, 578] },
    // The 2026-09-14 triage split: each of these issues was split out of its decision issue
    // and declared `Parent:` in its body, and the audit reported every one as
    // `declared-parent-missing-native`. The seventh, #720 -> #358, joins #358's existing
    // group above.
    { parent: 230, children: [718] },
    { parent: 359, children: [719] },
    { parent: 288, children: [721] },
    { parent: 418, children: [722] },
    { parent: 635, children: [723] },
    { parent: 696, children: [724] },
    // The in-app gallery workbench (#248), split into leaves by its 2026-09-14 triage
    // clarification. #248 itself stays under #238 below.
    { parent: 248, children: [729, 730, 731] },
    // The mobile benchmark instrumentation (#721), split into leaves on 2026-09-14 because its
    // scope is several pull requests. #721 itself stays under #288 above.
    { parent: 721, children: [734, 735, 736, 737, 738] },
    { parent: 228, children: [260, 261, 267, 268, 269, 278, 279, 280, 281, 282] },
    { parent: 229, children: [270, 271, 272, 273, 274, 425] },
    { parent: 233, children: [275, 276, 277] },
    { parent: 238, children: [243, 244, 246, 247, 248, 251] },
    { parent: 240, children: [245, 249, 250] },
    { parent: 241, children: [252, 253, 254] },
    { parent: 242, children: [255, 256] },
    { parent: 283, children: [284, 285, 286] },
    { parent: 317, children: [427, 468, 428, 429] },
    { parent: 325, children: [470] },
    { parent: 341, children: [335, 342, 343] },
    {
      parent: 355,
      children: [223, 229, 233, 237, 332, 356, 357, 358, 359, 360, 367, 371, 372],
    },
    { parent: 360, children: [369, 370] },
  ]),
  blockedBy: Object.freeze([
    { issue: 117, blockers: [116, 317, 318, 321] },
    { issue: 223, blockers: [267] },
    { issue: 226, blockers: [317, 318, 319, 320, 321] },
    { issue: 227, blockers: [226, 319, 320] },
    { issue: 238, blockers: [240] },
    { issue: 242, blockers: [238] },
    { issue: 243, blockers: [317, 318, 319, 321] },
    { issue: 246, blockers: [243, 244, 245, 317, 318, 319, 321] },
    { issue: 247, blockers: [244, 246] },
    { issue: 248, blockers: [246] },
    { issue: 249, blockers: [245, 246] },
    { issue: 250, blockers: [245] },
    { issue: 251, blockers: [243, 246, 247, 248, 317, 319, 321] },
    { issue: 252, blockers: [245, 246] },
    { issue: 253, blockers: [246] },
    { issue: 254, blockers: [246, 247] },
    { issue: 255, blockers: [248] },
    { issue: 256, blockers: [255] },
    { issue: 258, blockers: [342, 343] },
    { issue: 260, blockers: [316] },
    { issue: 261, blockers: [260, 316, 317, 318] },
    { issue: 267, blockers: [260, 316, 321] },
    { issue: 268, blockers: [321, 358] },
    {
      issue: 269,
      blockers: [260, 261, 267, 268, 274, 279, 281, 290, 316, 317, 318, 319, 320, 321, 327],
    },
    { issue: 271, blockers: [225, 270] },
    { issue: 272, blockers: [225, 270] },
    { issue: 273, blockers: [225, 270] },
    { issue: 274, blockers: [270, 271, 272, 273] },
    { issue: 276, blockers: [275] },
    { issue: 277, blockers: [275, 276] },
    { issue: 279, blockers: [260, 261, 317, 318] },
    { issue: 281, blockers: [260, 316, 321] },
    { issue: 284, blockers: [231] },
    { issue: 285, blockers: [231] },
    { issue: 286, blockers: [231, 285] },
    { issue: 289, blockers: [226, 320, 321] },
    { issue: 290, blockers: [226, 227, 319, 321] },
    { issue: 294, blockers: [116, 341] },
    { issue: 317, blockers: [316] },
    { issue: 318, blockers: [316, 317] },
    { issue: 319, blockers: [318, 321] },
    { issue: 322, blockers: [226, 317, 318, 321] },
    { issue: 323, blockers: [153, 316, 317, 318] },
    { issue: 324, blockers: [317, 320, 321] },
    { issue: 325, blockers: [317, 318, 321] },
    { issue: 326, blockers: [290, 316, 317, 318, 319, 321, 342, 343] },
    { issue: 327, blockers: [318, 319, 320, 321] },
    { issue: 335, blockers: [342] },
    { issue: 343, blockers: [335, 342] },
    { issue: 351, blockers: [321] },
    { issue: 352, blockers: [321] },
    { issue: 360, blockers: [233, 323, 357, 358, 367] },
    { issue: 368, blockers: [321] },
    { issue: 370, blockers: [369] },
    { issue: 371, blockers: [372] },
    { issue: 372, blockers: [359] },
    { issue: 468, blockers: [427] },
    { issue: 428, blockers: [468, 470] },
    { issue: 429, blockers: [427, 428] },
    // #248's leaves: the workbench route needs the registries under src/, and the command
    // and still download need the route.
    { issue: 730, blockers: [729] },
    { issue: 731, blockers: [730] },
    // #721's leaves: the overrides and the preview measurement need the benchmark report; the
    // device procedure and the CI check need the report and the one-knob overrides.
    { issue: 735, blockers: [734] },
    { issue: 736, blockers: [734] },
    { issue: 737, blockers: [734, 735] },
    { issue: 738, blockers: [734, 735] },
  ]),
});