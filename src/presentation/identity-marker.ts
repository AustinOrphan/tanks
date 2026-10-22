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
 * `shape` SHIPS AS THE FFA DEFAULT, AND IT IS THE ONE STYLE. Three styles were built and
 * compared behind `?dev=1&identityMarker=`, and the ruling on #234 chose `shape` on still
 * evidence (issue #922). The other two, `arcs` (the ring broken into one arc per slot) and
 * `roof` (blades on the turret crown), were deleted by issue #1023, and the flag now
 * rejects their names like any unknown value. This module still says nothing about
 * defaults: a `null` style here is "no marker", which is what teams, co-op and
 * single-player draw. WHICH sessions get `shape` without asking, and the `solid` value that
 * takes it back off, are the flag layer's (`game/identity-marker-flag.ts`), which resolves
 * both before the renderer or the HUD is handed a style.
 *
 *  - `shape` -- circle / triangle / square / starburst outline. Recognition. Ships in FFA.
 *
 * WHY THE MARKER IS WORLD-ALIGNED, and the thing a mockup cannot tell you: the ring is
 * parented to the tank's group, and `view.group.rotation.y = -bodyA` is written every
 * frame, so the ring SPINS WITH THE HULL. A circular annulus is rotation-invariant and
 * this has never mattered. It matters enormously to the `shape` style -- a square turned 45
 * degrees IS the diamond, so two of the four shapes would collide the moment a player
 * turned. `identityMarkerSpin` returns the counter-rotation that cancels it; see its own
 * note for the derivation. Applied ONLY when a marker is active, so the shipped default
 * path is untouched down to the vertex.
 *
 * ONE MESH, NOT SEVERAL. `TankView.ring` is a single `THREE.Mesh`, and
 * `entities.test.ts` counts objects named `identity-ring` expecting exactly one per
 * player at four separate sites. A marker is therefore built as ONE BufferGeometry rather
 * than as sibling meshes -- which is also the cheaper thing to draw, and keeps
 * `disposeObject` correct with no new teardown path.
 */
export const IDENTITY_MARKER_STYLES = ['shape'] as const;
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


/**
 * WHICH SLOT GETS WHICH MARK, as a description rather than as geometry (issue #778).
 *
 * This table used to live inside `render/identity-marker.ts` as a private `spec` array,
 * which was correct while the arena ring was its only consumer. It is not correct now that
 * the HUD draws the same mark: two consumers reading two copies is the second-source-of-
 * truth problem `identity.ts` already exists to prevent, and the failure mode is specific
 * and silent -- the strip would keep claiming a square for slot 3 after the ring moved to
 * something else, which breaks precisely the pairing #234 ruled on: the ring and the strip
 * ship as one channel.
 *
 * So it is a DESCRIPTION, not a path and not a BufferGeometry. `render/identity-marker.ts`
 * extrudes it into a 3D annulus band; `game/hud.ts` projects it into a 2D SVG outline. Each
 * consumer owns its own units, weights and tolerances, and neither owns the answer to
 * "which shape is slot 3".
 *
 * The circle is `circle` here rather than a 48-gon, even though the ring builds it as one.
 * A renderer approximating a curve with segments is a rendering decision; an SVG draws a
 * real `<circle>` and should not inherit a tessellation count it has no use for.
 */
export type MarkerOutline =
  | { readonly kind: 'circle' }
  | { readonly kind: 'polygon'; readonly sides: number; readonly rotation: number }
  | { readonly kind: 'star'; readonly points: number };

/**
 * The slot index wrapped into the variants that exist, including for a negative slot.
 *
 * `((n % m) + m) % m` rather than `n % m`, because JavaScript's `%` keeps the sign of the
 * dividend: `-1 % 4` is `-1`, which would index off the front of every table here.
 */
export function markerVariant(slot: number): number {
  return ((slot % MARKER_VARIANTS) + MARKER_VARIANTS) % MARKER_VARIANTS;
}

/**
 * The outline the `shape` style gives a slot: circle, triangle, square, starburst.
 *
 * The rotations are load-bearing and are NOT free to normalise. The triangle points up
 * (`-PI/2` puts its first vertex up-screen). The square is turned by `-PI/4`, which puts
 * its CORNERS on the diagonals and its edges flat to the screen -- turn it any other way
 * and it becomes the diamond that slot 4 used to be, which is the collision the starburst
 * was introduced to remove. See `render/identity-marker.ts` for why the starburst replaced
 * that diamond and why it is the one outline not corrected for perpendicular weight.
 */
export function shapeOutlineFor(slot: number): MarkerOutline {
  switch (markerVariant(slot)) {
    case 0: return { kind: 'circle' };
    case 1: return { kind: 'polygon', sides: 3, rotation: -Math.PI / 2 };
    case 2: return { kind: 'polygon', sides: 4, rotation: -Math.PI / 4 };
    default: return { kind: 'star', points: 6 };
  }
}

/**
 * Vertex angles of a regular n-gon, first vertex at `rotation`.
 *
 * Here rather than beside either consumer because both need the same vertices in the same
 * order: the ring walks them to build a band, the HUD walks them to build `points` on an
 * SVG polygon. A second implementation is how the two outlines start disagreeing by a
 * half-step without either looking wrong on its own.
 */
export function polygonAngles(sides: number, rotation: number): number[] {
  return Array.from({ length: sides }, (_, i) => rotation + (i * 2 * Math.PI) / sides);
}
