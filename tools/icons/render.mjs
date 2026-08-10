/**
 * The install icons, drawn from the same geometry as `public/favicon.svg`.
 *
 * They are GENERATED rather than hand-drawn because nothing on this machine
 * rasterises SVG (no imagemagick, no rsvg, no headless-browser step in `npm test`),
 * and because a generated icon is checkable: `render.test.ts` decodes each committed
 * PNG and compares it pixel for pixel against what this file produces today. A stale
 * icon -- the artwork edited here and the file in `public/icons/` never regenerated --
 * is otherwise invisible, exactly like the dead CSS `hud.css.test.ts` exists to catch.
 *
 * Bytes are deliberately NOT compared: zlib's compressed output is a property of the
 * zlib version, and CI runs Node 20 and 22. Inflating is version-independent, so the
 * test decodes instead.
 *
 * Run `node tools/icons/render.mjs` to rewrite `public/icons/`.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The favicon's geometry, in its own 32x32 viewBox, in paint order.
 * Colours are copied from `public/favicon.svg`; `render.test.ts` pins that they match.
 */
export const ART = [
  { kind: 'rect', x: 15, y: 6, w: 3, h: 10, r: 0, fill: '#8fb98a' }, // barrel
  { kind: 'circle', cx: 16, cy: 18, r: 4.5, fill: '#8fb98a' }, // turret
  { kind: 'rect', x: 6, y: 20, w: 20, h: 6, r: 1.5, fill: '#6f9a6b' }, // hull
  { kind: 'rect', x: 5, y: 25, w: 22, h: 3, r: 1.5, fill: '#3f5a3d' }, // tracks
];

/** The background plate the artwork sits on, also from favicon.svg. */
export const BG = '#1a1a1a';
/** favicon.svg's corner radius, in the same 32-unit space. */
export const BG_RADIUS = 6;

/**
 * Every icon the manifest and index.html reference.
 *
 * - `radius`: corner rounding in 32-unit space. Zero for the two square ones, and that
 *   is not a shortcut. iOS applies its OWN mask to an apple-touch-icon, so baked-in
 *   rounded corners show as dark notches inside it; a maskable icon is cropped by the
 *   platform to whatever shape it likes, so it must be full-bleed.
 * - `inset`: the artwork is scaled about the centre by this factor. A maskable icon's
 *   guaranteed-visible region is the centre 80% (the "safe zone" in the W3C
 *   `purpose: maskable` definition), so the tank is drawn at 60% and clears it.
 */
export const ICONS = [
  { file: 'icon-192.png', size: 192, radius: BG_RADIUS, scale: 1 },
  { file: 'icon-512.png', size: 512, radius: BG_RADIUS, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, scale: 0.6 },
  { file: 'apple-touch-icon-180.png', size: 180, radius: 0, scale: 1 },
];

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

/** Inside test for a rounded rectangle, in 32-unit space. */
function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  if (r <= 0) return true;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 4x4 subsamples per pixel: enough that a 4.5-unit circle at 192px reads smooth. */
const SUB = 4;

/**
 * Render one icon spec to straight (non-premultiplied) RGBA.
 *
 * @param {{size: number, radius: number, scale: number}} spec
 * @returns {{width: number, height: number, rgba: Uint8Array}}
 */
export function renderIcon(spec) {
  const { size, radius, scale } = spec;
  const rgba = new Uint8Array(size * size * 4);
  const bg = hex(BG);
  const art = ART.map((s) => ({ ...s, rgb: hex(s.fill) }));

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Premultiplied accumulator: every layer here is opaque, so this is just an
      // area-weighted average of whatever colour won each subsample.
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const ux = ((px + (sx + 0.5) / SUB) / size) * 32;
          const uy = ((py + (sy + 0.5) / SUB) / size) * 32;
          let rgb = null;
          if (inRoundRect(ux, uy, 0, 0, 32, 32, radius)) rgb = bg;
          // Foreground scaled about the centre: test the INVERSE-transformed point.
          const fx = (ux - 16) / scale + 16;
          const fy = (uy - 16) / scale + 16;
          for (const s of art) {
            const hit =
              s.kind === 'circle'
                ? (fx - s.cx) ** 2 + (fy - s.cy) ** 2 <= s.r * s.r
                : inRoundRect(fx, fy, s.x, s.y, s.w, s.h, s.r);
            // Artwork outside the plate is clipped away with it.
            if (hit && rgb !== null) rgb = s.rgb;
          }
          if (rgb !== null) {
            ar += rgb[0];
            ag += rgb[1];
            ab += rgb[2];
            aa += 1;
          }
        }
      }
      const n = SUB * SUB;
      const i = (py * size + px) * 4;
      if (aa === 0) continue; // transparent
      rgba[i] = Math.round(ar / aa);
      rgba[i + 1] = Math.round(ag / aa);
      rgba[i + 2] = Math.round(ab / aa);
      rgba[i + 3] = Math.round((aa / n) * 255);
    }
  }
  return { width: size, height: size, rgba };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA PNG, every scanline filter 0 -- which is what makes decoding trivial. */
export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 4);
    raw[off] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, off + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decode a PNG this file wrote. Deliberately NOT a general decoder: it asserts the
 * shape it expects (8-bit RGBA, filter 0) rather than growing branches nothing covers.
 *
 * @param {Buffer} buf
 * @returns {{width: number, height: number, rgba: Uint8Array}}
 */
export function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG: bad signature');
  }
  let off = 8;
  let header = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!header) throw new Error('no IHDR');
  if (header.depth !== 8 || header.colorType !== 6) {
    throw new Error(`unsupported PNG: depth ${header.depth}, colour type ${header.colorType}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const off2 = y * (1 + width * 4);
    if (raw[off2] !== 0) throw new Error(`scanline ${y} uses filter ${raw[off2]}, expected 0`);
    rgba.set(raw.subarray(off2 + 1, off2 + 1 + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

export const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/icons');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(ICON_DIR, { recursive: true });
  for (const spec of ICONS) {
    const png = encodePng(renderIcon(spec));
    writeFileSync(join(ICON_DIR, spec.file), png);
    console.log(`${spec.file}: ${spec.size}x${spec.size}, ${png.length} bytes`);
  }
}
