/**
 * The icons are generated, so the hazard is not that they are wrong -- it is that they
 * are STALE: the artwork edited here and `public/icons/` never regenerated. Nothing
 * imports a PNG, so a stale icon is invisible to `tsc`, to the bundle and to every other
 * test, and it ships as the app's face on a home screen.
 *
 * The committed files are therefore decoded and compared against what `render.mjs`
 * produces TODAY, pixel for pixel. Pixels rather than bytes: zlib's compressed output is
 * a property of the zlib version and CI runs Node 20 and 22, so a byte comparison would
 * be a flake waiting for a Node bump. Inflating is version-independent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs, dependency-free so it can be run as a CLI
import { ICONS, ART, BG, renderIcon, decodePng, encodePng } from './render.mjs';

interface Spec {
  file: string;
  size: number;
  radius: number;
  scale: number;
}
interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const specs = ICONS as Spec[];
const repo = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const committed = (spec: Spec): Image =>
  decodePng(readFileSync(join(repo('public/icons'), spec.file))) as Image;
const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

describe('the generated install icons', () => {
  it('has icons to check at all', () => {
    // Vacuity guard: every `it.each` below iterates this list, and an empty one would
    // report a green sweep over nothing.
    expect(specs.length).toBe(4);
  });

  it.each(specs.map((s) => [s.file, s] as const))(
    '%s on disk is exactly what render.mjs draws today',
    (_file, spec) => {
      // The staleness check. Fails the moment ART, BG, a size or a scale moves without
      // `node tools/icons/render.mjs` being re-run -- which is the whole reason the
      // icons are generated rather than pasted in.
      const disk = committed(spec);
      const fresh = renderIcon(spec) as Image;
      expect({ width: disk.width, height: disk.height }).toEqual({
        width: spec.size,
        height: spec.size,
      });
      let differing = 0;
      for (let i = 0; i < fresh.rgba.length; i++) {
        if (disk.rgba[i] !== fresh.rgba[i]) differing++;
      }
      // Population: all 4 channels of all size^2 pixels.
      expect(differing, `${spec.file} is stale -- run node tools/icons/render.mjs`).toBe(0);
    },
  );

  it('draws the same tank as public/favicon.svg', () => {
    // The generator carries its own copy of the geometry (it cannot parse SVG), so the
    // two can drift into two different logos. Colours are the checkable half: population
    // is the 4 artwork fills plus the background plate, i.e. every colour favicon.svg
    // names. The SHAPES are not cross-checked and could still drift -- stated because
    // "matches the favicon" would otherwise read as more than this proves.
    const svg = readFileSync(repo('public/favicon.svg'), 'utf8');
    const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(fills.length).toBe(5);
    expect(new Set(fills)).toEqual(
      new Set([BG as string, ...(ART as Array<{ fill: string }>).map((a) => a.fill)]),
    );
  });

  it.each(specs.map((s) => [s.file, s] as const))(
    '%s actually contains the artwork, not just a plate',
    (_file, spec) => {
      // The pixel comparison above passes on two blank images if the generator is what
      // broke. This is the independent half: every colour the logo is made of has to be
      // ON the icon, at a scale where anti-aliasing cannot account for it.
      const { rgba } = committed(spec);
      const counts = new Map<string, number>();
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] !== 255) continue;
        const key = hex(rgba[i], rgba[i + 1], rgba[i + 2]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const floor = spec.size * spec.size * 0.001;
      for (const colour of [BG as string, ...(ART as Array<{ fill: string }>).map((a) => a.fill)]) {
        expect(counts.get(colour) ?? 0, `${colour} is missing from ${spec.file}`).toBeGreaterThan(
          floor,
        );
      }
    },
  );

  it('keeps the maskable icon inside the safe zone a platform mask may crop to', () => {
    // `purpose: maskable` hands the platform the whole square and lets it crop to any
    // shape it likes; only the centre 80% circle is guaranteed to survive. Android's
    // circle mask on a full-bleed icon would take the barrel's tip and both track ends.
    // Mutating `scale` back to 1 fails here, which is what the 0.6 is FOR.
    const spec = specs.find((s) => s.file.includes('maskable'));
    expect(spec, 'no maskable icon in ICONS').toBeTruthy();
    const { width, rgba } = committed(spec as Spec);
    const c = width / 2;
    const safe = width * 0.4; // radius of the centre-80% circle
    let outside = 0;
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const isPlate = hex(rgba[i], rgba[i + 1], rgba[i + 2]) === BG;
        if (isPlate || rgba[i + 3] === 0) continue;
        if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > safe) outside++;
      }
    }
    // Population: all 512x512 pixels of the maskable icon.
    expect(outside).toBe(0);
  });

  it.each(specs.map((s) => [s.file, s] as const))(
    '%s rounds its corners only when the platform does not',
    (_file, spec) => {
      // `radius: 0` is load-bearing on both square icons -- iOS masks an
      // apple-touch-icon itself and a maskable icon must be full-bleed -- so a baked
      // radius shows as four transparent notches inside the platform's own shape.
      //
      // Be exact about what this proves: the expectation is DERIVED from `spec.radius`,
      // so it is a check on the RENDERER, not on the spec. Measured both ways -- making
      // `inRoundRect` ignore its radius fails this on the two rounded icons; giving the
      // apple-touch icon a radius and regenerating does NOT fail it (the expectation
      // moves with the spec), and is caught instead by the opacity assertion in
      // tools/webmanifest.test.ts, which reads the requirement off the PLATFORM rather
      // than off this file.
      const { width, rgba } = committed(spec);
      const corner = rgba[3]; // alpha of pixel (0,0)
      const centre = rgba[((width / 2) * width + width / 2) * 4 + 3];
      expect(centre).toBe(255);
      expect(corner, `${spec.file} corner alpha`).toBe(spec.radius > 0 ? 0 : 255);
    },
  );

  it('round-trips its own PNG encoding', () => {
    // decodePng is the measuring instrument for every assertion above, and it is written
    // in this repo. If it silently returned the same buffer it was handed, or dropped
    // the last scanline, the comparisons would still pass. A synthetic image with a
    // known non-uniform pattern is the negative control.
    const width = 3;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
    const decoded = decodePng(encodePng({ width, height, rgba })) as Image;
    expect({ width: decoded.width, height: decoded.height }).toEqual({ width, height });
    expect(Array.from(decoded.rgba)).toEqual(Array.from(rgba));
  });
});
