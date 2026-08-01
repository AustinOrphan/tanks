/**
 * The paint shop's memory: one persisted choice from a CURATED palette.
 *
 * Curated on purpose -- brown/grey/teal/olive are enemy IDENTITIES, and a player
 * painted teal has sabotaged their own readability. That is why this is a swatch
 * list and not a colour wheel, and why validation rejects anything off-list.
 *
 * Game layer only, render-only downstream: the chosen hex is handed to the renderer;
 * the sim's config colours stay pristine, so replays and balance never notice.
 */
export const CUSTOM_KEY = 'tanks.custom.v1';

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

export type SkinId = 'solid' | 'stripes' | 'camo' | 'checker' | 'flow';

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
  { id: 'checker', label: 'Checkerplate' },
  { id: 'flow', label: 'Flow', scroll: { u: 0.08, v: 0 } },
]);

export const DEFAULT_SKIN: SkinId = 'solid';

const IDS = new Set<string>(PALETTE.map((s) => s.id));
const SKIN_IDS = new Set<string>(SKINS.map((s) => s.id));

export interface CustomizationStore {
  hull(): HullColorId;
  /** Off-palette ids are refused, not stored: a save can never paint an enemy hue. */
  setHull(id: HullColorId): void;
  hexFor(id: HullColorId): string;
  skin(): SkinId;
  /** Off-list ids are refused, exactly like hull colours. */
  setSkin(id: SkinId): void;
}

export function createCustomizationStore(storage: Storage): CustomizationStore {
  function read(): { hull: HullColorId; skin: SkinId } {
    const fallback = { hull: DEFAULT_HULL, skin: DEFAULT_SKIN };
    let raw: string | null = null;
    try {
      raw = storage.getItem(CUSTOM_KEY);
    } catch {
      return fallback;
    }
    if (raw === null || raw === '') return fallback;
    try {
      const parsed = JSON.parse(raw) as { hull?: unknown; skin?: unknown } | null;
      // Each field validated independently: a junk skin must not reset the hull.
      return {
        hull:
          typeof parsed?.hull === 'string' && IDS.has(parsed.hull)
            ? (parsed.hull as HullColorId)
            : DEFAULT_HULL,
        skin:
          typeof parsed?.skin === 'string' && SKIN_IDS.has(parsed.skin)
            ? (parsed.skin as SkinId)
            : DEFAULT_SKIN,
      };
    } catch {
      return fallback;
    }
  }

  let shadow = read();

  function persist(): void {
    try {
      storage.setItem(CUSTOM_KEY, JSON.stringify(shadow));
    } catch {
      // Private mode: the shadow carries the session.
    }
  }

  return {
    hull: () => shadow.hull,
    setHull(id: HullColorId): void {
      if (!IDS.has(id)) return;
      shadow = { ...shadow, hull: id };
      persist();
    },
    hexFor(id: HullColorId): string {
      return PALETTE.find((s) => s.id === id)?.hex ?? PALETTE[0].hex;
    },
    skin: () => shadow.skin,
    setSkin(id: SkinId): void {
      if (!SKIN_IDS.has(id)) return;
      shadow = { ...shadow, skin: id };
      persist();
    },
  };
}
