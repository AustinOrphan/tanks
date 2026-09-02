/**
 * The paint shop's memory: one persisted choice per catalog, validated against
 * `presentation/customization.ts`'s lists on the way in AND on the way out. Off-list ids
 * are refused rather than stored, so a save can never paint the player an enemy hue --
 * the catalog is curated for exactly that reason (see its own header).
 *
 * Game layer only, render-only downstream: the chosen hex is handed to the renderer;
 * the sim's config colours stay pristine, so replays and balance never notice.
 */
import {
  PALETTE,
  SKINS,
  ACCENTS,
  DEFAULT_HULL,
  DEFAULT_SKIN,
  DEFAULT_ACCENT,
  type HullColorId,
  type SkinId,
  type AccentId,
} from '../presentation/customization';

export const CUSTOM_KEY = 'tanks.custom.v1';

const IDS = new Set<string>(PALETTE.map((s) => s.id));
const SKIN_IDS = new Set<string>(SKINS.map((s) => s.id));
const ACCENT_IDS = new Set<string>(ACCENTS.map((s) => s.id));

export interface CustomizationStore {
  hull(): HullColorId;
  /** Off-palette ids are refused, not stored: a save can never paint an enemy hue. */
  setHull(id: HullColorId): void;
  hexFor(id: HullColorId): string;
  skin(): SkinId;
  /** Off-list ids are refused, exactly like hull colours. */
  setSkin(id: SkinId): void;
  /** The pattern's second tone. Defaults to `auto` -- see AccentId's doc comment. */
  accent(): AccentId;
  /** Off-list ids are refused, exactly like hull colours and skins. */
  setAccent(id: AccentId): void;
  /** null for `auto`: the render layer derives the tone from the hull hex itself. */
  accentHexFor(id: AccentId): string | null;
}

export function createCustomizationStore(storage: Storage): CustomizationStore {
  function read(): { hull: HullColorId; skin: SkinId; accent: AccentId } {
    const fallback = { hull: DEFAULT_HULL, skin: DEFAULT_SKIN, accent: DEFAULT_ACCENT };
    let raw: string | null = null;
    try {
      raw = storage.getItem(CUSTOM_KEY);
    } catch {
      return fallback;
    }
    if (raw === null || raw === '') return fallback;
    try {
      const parsed = JSON.parse(raw) as
        | { hull?: unknown; skin?: unknown; accent?: unknown }
        | null;
      // Each field validated independently: a junk skin must not reset the hull, and a
      // save from before `accent` existed must not reset either of the other two.
      return {
        hull:
          typeof parsed?.hull === 'string' && IDS.has(parsed.hull)
            ? (parsed.hull as HullColorId)
            : DEFAULT_HULL,
        skin:
          typeof parsed?.skin === 'string' && SKIN_IDS.has(parsed.skin)
            ? (parsed.skin as SkinId)
            : DEFAULT_SKIN,
        accent:
          typeof parsed?.accent === 'string' && ACCENT_IDS.has(parsed.accent)
            ? (parsed.accent as AccentId)
            : DEFAULT_ACCENT,
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
    accent: () => shadow.accent,
    setAccent(id: AccentId): void {
      if (!ACCENT_IDS.has(id)) return;
      shadow = { ...shadow, accent: id };
      persist();
    },
    accentHexFor(id: AccentId): string | null {
      return ACCENTS.find((s) => s.id === id)?.hex ?? null;
    },
    skin: () => shadow.skin,
    setSkin(id: SkinId): void {
      if (!SKIN_IDS.has(id)) return;
      shadow = { ...shadow, skin: id };
      persist();
    },
  };
}
