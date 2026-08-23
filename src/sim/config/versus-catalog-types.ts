/**
 * The dedicated VS arena catalog contract (issue #270): what a map ADVERTISES for
 * competitive play -- stable id, supported player counts and modes, spawn policy,
 * variant generators, and selector display metadata. Deliberately a separate
 * vocabulary from `ArenaClaim` (campaign intent) and a separate namespace from
 * campaign ordering: `arenaId` points into `arenas.json` for geometry reuse, but
 * nothing here reads or implies campaign progression.
 *
 * Declarations are promises, and two layers keep them honest: the schema
 * (`validateVersusCatalog`, config/validate.ts) rejects malformed entries at load,
 * and the geometry validators (`versus-catalog-rules.ts`) prove every declared
 * (player count, mode, variant) combination against the real spawn/sightline
 * machinery in tests.
 */
import type { GameMode } from '../types';

/** The two versus modes. A subtype of `GameMode` (never `'campaign-coop'`). */
export type VersusMode = Extract<GameMode, 'ffa' | 'teams'>;
export const VERSUS_MODES: readonly VersusMode[] = ['ffa', 'teams'];

/** Versus-supported player counts -- the same 2..4 range the setup pane offers. */
export const VERSUS_PLAYER_COUNTS: readonly number[] = [2, 3, 4];

/**
 * Advertised variant generators. `seeded-destructible` is the one that exists:
 * seeded removal of a subset of destructible cells (`versus-variants.ts`), always
 * on for versus sessions with a seed. An entry declaring it is validated across a
 * pinned seed sweep; an entry with an EMPTY `variants` list ships its fixed board
 * only and skips that sweep.
 */
export const VERSUS_VARIANT_KINDS = ['seeded-destructible'] as const;
export type VersusVariantKind = (typeof VERSUS_VARIANT_KINDS)[number];

/**
 * Spawn placement policies. `maximin` is the shipped one -- `pickVersusSpawnCell`'s
 * farthest-first placement with the hard mutual-LOS filter (versus-spawns.ts). The
 * field exists so a future policy (e.g. #225's authoritative clearance rule) is a
 * declared, validated property of an entry rather than an ambient assumption.
 */
export const VERSUS_SPAWN_POLICIES = ['maximin'] as const;
export type VersusSpawnPolicy = (typeof VERSUS_SPAWN_POLICIES)[number];

export interface VersusCatalogEntry {
  /**
   * Stable VS id -- the selection namespace (`VersusConfig.arenaId` before Start
   * resolution, pane state, a future selector's key). NEVER `'random'`: that string
   * is the menu's reserved draw-for-me sentinel, and the schema rejects it.
   */
  id: string;
  /** The arena geometry this entry plays on -- must name an `arenas.json` entry. */
  arenaId: string;
  /** Selector display name (#274 consumes; hud's `arenaLabel` parity today). */
  displayName: string;
  /** One-line gameplay intent note (selector copy, #274). */
  intent: string;
  /** Preview reference token consumed by the selector (#274). */
  preview: string;
  /** Supported player counts -- non-empty, strictly increasing, each in {2,3,4}. */
  players: number[];
  /** Supported modes -- non-empty, unique. */
  modes: VersusMode[];
  /** The spawn placement policy the entry is validated under. */
  spawnPolicy: VersusSpawnPolicy;
  /** Advertised variant generators -- unique; may be empty (fixed board only). */
  variants: VersusVariantKind[];
}
