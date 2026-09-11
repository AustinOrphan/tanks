/**
 * The identity-marker VOCABULARY -- which second channels exist, and the one piece of
 * maths that keeps them readable. Renderer-independent, and here rather than in
 * `render/` for the reason issue #473 moved the identity PALETTE here: `game/devflags.ts`
 * has to validate the flag's values, and a game module importing a Three.js module to
 * learn a semantic is the coupling that move existed to remove. The geometry itself --
 * which does need THREE -- stays in `render/identity-marker.ts`.
 *
 * A SECOND CHANNEL for player identity, beside hue (issue #630).
 *
 * THE PROBLEM. In a four-player match, which tank is yours is carried entirely by the
 * colour of the ring on the ground -- `IDENTITY_RING_COLORS` (presentation/identity.ts)
 * and nothing else. That file already concedes the cost in its own notes: slots 1 and 2
 * sit ~20 degrees of hue apart, and the team palette's red/green pair is "the worst pair
 * for a deuteranope, and that is accepted rather than overlooked". Roughly one man in
 * twelve has a red-green deficiency, and under forced colours every hue here is replaced
 * outright.
 *
 * TWO CANDIDATES, NEITHER SHIPPED AS THE DEFAULT. The owner has not chosen between them,
 * so both are built and selectable (`?dev=1&identityMarker=arcs|shape`) and the default
 * stays exactly today's solid ring. This is the same posture `aiPerception=los` holds for
 * an alternative targeting policy: a candidate that can be played, not a change of
 * behaviour made on an agent's taste. The evidence that settles it is a real match, and
 * a flat mockup cannot produce it -- which is the whole reason both exist in the tree.
 *
 *  - `arcs`  -- the ring broken into (slot + 1) arcs. Counting.
 *  - `shape` -- circle / triangle / square / diamond outline. Recognition.
 *
 * WHY THE MARKER IS WORLD-ALIGNED, and the thing a mockup cannot tell you: the ring is
 * parented to the tank's group, and `view.group.rotation.y = -bodyA` is written every
 * frame, so the ring SPINS WITH THE HULL. A circular annulus is rotation-invariant and
 * this has never mattered. It matters enormously to both candidates -- a square turned 45
 * degrees IS the diamond, so two of the four shapes would collide the moment a player
 * turned. `identityMarkerSpin` returns the counter-rotation that cancels it; see its own
 * note for the derivation. Applied ONLY when a marker is active, so the shipped default
 * path is untouched down to the vertex.
 *
 * ONE MESH, NOT SEVERAL. `TankView.ring` is a single `THREE.Mesh`, and
 * `entities.test.ts` counts objects named `identity-ring` expecting exactly one per
 * player at four separate sites. The arc variant therefore merges its runs into ONE
 * BufferGeometry rather than adding sibling meshes -- which is also the cheaper thing to
 * draw, and keeps `disposeObject` correct with no new teardown path.
 */
export const IDENTITY_MARKER_STYLES = ['arcs', 'shape'] as const;
export type IdentityMarkerStyle = (typeof IDENTITY_MARKER_STYLES)[number];

/** Is this a marker style this module builds? The parse-side guard (`asIdentityMarker`). */
export function isIdentityMarkerStyle(value: unknown): value is IdentityMarkerStyle {
  return typeof value === 'string' && (IDENTITY_MARKER_STYLES as readonly string[]).includes(value);
}

/**
 * How many distinct markers each style can express. Four is the shipped player cap
 * (`devflags.ts`'s `players`), and `IDENTITY_RING_COLORS` carries exactly four entries for
 * the same reason. A fifth slot wraps rather than throwing -- the colour path already
 * degrades to a fallback hue instead of failing, and a marker that disagrees about how
 * many slots exist would be a second opinion on a question presentation/identity.ts owns.
 */
export const MARKER_VARIANTS = 4;

/**
 * The counter-rotation, in radians, that holds a marker still while its tank turns.
 *
 * DERIVATION, because the sign is not guessable and a wrong one spins the marker twice as
 * fast rather than stopping it. The mesh sits at `rotation.x = -PI/2`, so its own XY plane
 * maps onto the ground: a local point (x, y) lands at world (x, -y), and a local rotation
 * by `phi` therefore reads as a ground rotation of `-phi`. The parent contributes
 * `rotation.y = -bodyA`, which reads as a ground rotation of `+bodyA`. Total is
 * `bodyA - phi`, so `phi = bodyA` holds the marker world-fixed.
 *
 * Pinned by a test that rotates a real view and measures the marker's world vertices,
 * because "it looked right" is exactly how the wrong sign survives -- at small turn rates
 * both signs look like wobble.
 */
export function identityMarkerSpin(bodyAngle: number): number {
  return bodyAngle;
}

