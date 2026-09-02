/**
 * The paint shop's CATALOG: every tank choice a player can make, as data -- hull swatches,
 * accent tones, skins and spawn animations, each with its id, label and (where the choice
 * IS a colour) its hex. Renderer-independent on purpose: `render/skins.ts` paints the
 * textures and `render/spawn-anim.ts` runs the entrances, but WHICH choices exist, what
 * they are called and which is the default is application vocabulary that the HUD's
 * Customize panel, the persistence store (`game/customization.ts`), the renderer and the
 * gallery tool all read. Issue #473 moved the catalog here from `game/customization.ts`
 * so the renderer no longer imports a game module to learn its own skin ids.
 *
 * Curated on purpose -- brown/grey/teal/olive are enemy IDENTITIES, and a player painted
 * teal has sabotaged their own readability. That is why this is a swatch list and not a
 * colour wheel, and why the store's validation rejects anything off-list. The sim's
 * config colours stay pristine, so replays and balance never notice a pick.
 */
export interface Swatch {
  id: HullColorId;
  label: string;
  hex: string;
}

export type HullColorId = 'blue' | 'red' | 'orange' | 'purple' | 'green' | 'white';

/** First entry is the shipped default and must equal the roster's player colour. */
export const PALETTE: readonly Swatch[] = Object.freeze([
  { id: 'blue', label: 'Classic blue', hex: '#3d7bd6' },
  { id: 'red', label: 'Red', hex: '#d64545' },
  { id: 'orange', label: 'Orange', hex: '#e08a2e' },
  { id: 'purple', label: 'Purple', hex: '#8a5ad6' },
  { id: 'green', label: 'Green', hex: '#4fae52' },
  { id: 'white', label: 'White', hex: '#e8ecf2' },
]);

export const DEFAULT_HULL: HullColorId = 'blue';

/**
 * The pattern's SECOND tone -- the racing stripe, the checker cell, the camo blotch.
 * Historically this was always DERIVED from the hull hex (lighten/scale in
 * render/skins.ts), which is why a player never had "add white to whatever hull I
 * picked" as a choice of their own. `auto` keeps exactly that derivation (`hex: null`
 * is the sentinel render/skins.ts reads to mean "compute it from the base, as before"),
 * kept as the default so an existing save's tank does not change appearance. The
 * others are literal tones, not further derived -- picking `black` means black bands,
 * not a darkened version of black.
 */
export type AccentId = 'auto' | 'black' | 'white' | 'silver' | 'gold';

export interface AccentSwatch {
  id: AccentId;
  label: string;
  /** null only for `auto`: the render layer derives the tone from the hull itself. */
  hex: string | null;
}

/** First entry is `auto`, the shipped default. */
export const ACCENTS: readonly AccentSwatch[] = Object.freeze([
  { id: 'auto', label: 'Auto (matches hull)', hex: null },
  { id: 'black', label: 'Black', hex: '#101010' },
  { id: 'white', label: 'White', hex: '#f2f2f2' },
  { id: 'silver', label: 'Silver', hex: '#ccd3dc' },
  { id: 'gold', label: 'Gold', hex: '#e8c547' },
]);

export const DEFAULT_ACCENT: AccentId = 'auto';

export type SkinId = 'solid' | 'stripes' | 'camo' | 'clouds' | 'checker' | 'flow' | 'two-tone';

export interface SkinDef {
  id: SkinId;
  label: string;
  /**
   * Texture-offset drift in repeats/second, for ANIMATED skins. Per-skin DATA on
   * purpose: the user wants a bold-speed variant eventually, and that should be a
   * data entry here, not new machinery.
   */
  scroll?: { u: number; v: number };
}

/** First entry is the default. Generation lives in render/skins.ts (it needs THREE). */
export const SKINS: readonly SkinDef[] = Object.freeze([
  { id: 'solid', label: 'Solid' },
  { id: 'stripes', label: 'Racing stripes' },
  { id: 'camo', label: 'Camo' },
  // Next to camo deliberately: they are the same blotch painter at different coverage,
  // so a player comparing them wants them side by side.
  { id: 'clouds', label: 'Clouds' },
  { id: 'checker', label: 'Checkerplate' },
  { id: 'flow', label: 'Flow', scroll: { u: 0.08, v: 0 } },
  // NOT scrolling, deliberately: a second animated skin would trip the "flow is the
  // only animated one" exclusivity test below, which is a real design question
  // (docs/superpowers/backlog.md's animated-skins spike) that this issue does not need
  // to answer. Two-tone is also what every ENEMY kind now wears (entities.ts's
  // `enemySkinMapFor`), and an animated enemy livery is a different feature again.
  { id: 'two-tone', label: 'Two-tone' },
]);

export const DEFAULT_SKIN: SkinId = 'solid';

export type SpawnAnimId = 'warp' | 'rise' | 'beacon';

export interface SpawnAnimDef {
  id: SpawnAnimId;
  label: string;
}

/** First entry is the default. Implementations live in render/spawn-anim.ts (they need THREE). */
export const SPAWN_ANIMATIONS: readonly SpawnAnimDef[] = Object.freeze([
  { id: 'warp', label: 'Warp' },
  { id: 'rise', label: 'Rise' },
  { id: 'beacon', label: 'Beacon' },
]);

export const DEFAULT_SPAWN_ANIM: SpawnAnimId = 'warp';

/**
 * The scroll a skin carries, or null. THE one place "is this skin animated?" is
 * answered -- `render/entities.ts` needs the vector to advance the texture offset and
 * `render/preview.ts` needs the boolean to decide whether to run a repaint loop, and
 * two `SKINS.find(...)` calls in two files would be two things to keep in step.
 */
export function skinScroll(id: SkinId): { u: number; v: number } | null {
  return SKINS.find((s) => s.id === id)?.scroll ?? null;
}
