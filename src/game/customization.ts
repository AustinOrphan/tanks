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

const IDS = new Set<string>(PALETTE.map((s) => s.id));

export interface CustomizationStore {
  hull(): HullColorId;
  /** Off-palette ids are refused, not stored: a save can never paint an enemy hue. */
  setHull(id: HullColorId): void;
  hexFor(id: HullColorId): string;
}

export function createCustomizationStore(storage: Storage): CustomizationStore {
  function read(): HullColorId {
    let raw: string | null = null;
    try {
      raw = storage.getItem(CUSTOM_KEY);
    } catch {
      return DEFAULT_HULL;
    }
    if (raw === null || raw === '') return DEFAULT_HULL;
    try {
      const parsed: unknown = JSON.parse(raw);
      const hull = (parsed as { hull?: unknown } | null)?.hull;
      return typeof hull === 'string' && IDS.has(hull) ? (hull as HullColorId) : DEFAULT_HULL;
    } catch {
      return DEFAULT_HULL;
    }
  }

  let shadow = read();

  return {
    hull: () => shadow,
    setHull(id: HullColorId): void {
      if (!IDS.has(id)) return;
      shadow = id;
      try {
        storage.setItem(CUSTOM_KEY, JSON.stringify({ hull: id }));
      } catch {
        // Private mode: the shadow carries the session.
      }
    },
    hexFor(id: HullColorId): string {
      return PALETTE.find((s) => s.id === id)?.hex ?? PALETTE[0].hex;
    },
  };
}
