/**
 * The canonical tank reference bundle (issue #385).
 *
 *   npm run tank-assets            -- writes to assets/tank/
 *   npm run tank-assets -- --out X -- somewhere else
 *
 * Branding, documentation and logo work kept starting from screenshots, and a traced
 * silhouette drifts from the game the moment anyone retunes a proportion. This exports
 * the ACTUAL shipped geometry so that work starts from the same tank the renderer draws.
 *
 * RUN THROUGH `vite-node`, which is what lets it import `src/render/tank-model.ts`
 * directly -- the same module `entities.ts` builds the live tank from. That import is the
 * whole design: there is no second copy of the dimensions here to go stale, and adding one
 * would defeat the reason the issue exists. Everything this file decides is presentation
 * (colour, file layout, metadata); every number describing the tank comes from the model.
 *
 * WHAT IS EXPORTED, and what is deliberately not: hull, two tracks, turret and barrel,
 * with their transforms. No skins, identity rings, spawn effects or arena -- the issue
 * scopes those out of the canonical model, and they are all `entities.ts` concerns that a
 * headless tool has no business reproducing.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { tankParts, tankGeometryParameters, TURRET_GROUP_Y } from '../../src/render/tank-model.ts';

/**
 * `GLTFExporter` reaches for `FileReader` to turn its Blob into bytes, and Node has no
 * such global. Shimmed rather than routed through a browser: the exporter is otherwise
 * pure geometry work, and putting a Playwright page in the middle of it would make a
 * headless asset build depend on a browser install for no gain.
 *
 * `onloadend`, not `onload` -- that is the callback GLTFExporter actually registers
 * (three/examples/jsm/exporters/GLTFExporter.js), and a shim that fires only `onload`
 * leaves the export promise pending forever with no error.
 */
function installFileReaderShim() {
  if (globalThis.FileReader !== undefined) return;
  globalThis.FileReader = class {
    #finish() {
      if (typeof this.onloadend === 'function') this.onloadend({ target: this });
      if (typeof this.onload === 'function') this.onload({ target: this });
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((b) => { this.result = b; this.#finish(); });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((b) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString('base64')}`;
        this.#finish();
      });
    }
  };
}

/** The shipped player hull colour. Named here because the bundle documents it. */
const PLAYER_HULL_HEX = '#3d7bd6';

/**
 * How much darker the tracks are than the hull paint -- the same factor `entities.ts`
 * applies, taken from the model's parameters rather than restated.
 */
function trackColor(hullHex, shade) {
  return new THREE.Color(hullHex).multiplyScalar(shade);
}

/**
 * Assemble the canonical tank from the shared parts.
 *
 * The hierarchy mirrors the game's: a `visual` group holding hull and tracks, and a
 * `turret` group holding dome and barrel, positioned at the height the gun actually sits
 * at. Reproduced because a designer opening the GLB should be able to rotate the turret
 * the way the game does, not find one welded mesh.
 */
function buildTank({ monochrome }) {
  const params = tankGeometryParameters();
  const root = new THREE.Group();
  root.name = 'tank';
  const visual = new THREE.Group();
  visual.name = 'visual';
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.position.y = TURRET_GROUP_Y;
  root.add(visual);
  root.add(turret);

  const hull = monochrome ? '#ffffff' : PLAYER_HULL_HEX;
  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hull), roughness: 0.55, metalness: 0.35, name: 'hull',
  });
  const trackMat = new THREE.MeshStandardMaterial({
    // A monochrome bundle is for tracing a silhouette, so its parts must NOT separate by
    // tone -- that is the one place this deliberately departs from the game's materials.
    color: monochrome ? new THREE.Color(hull) : trackColor(hull, params.TRACK_SHADE),
    roughness: 0.95, metalness: 0.35, name: 'track',
  });
  const turretMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hull), roughness: 0.42, metalness: 0.35, name: 'turret',
  });

  let trackN = 0;
  for (const part of tankParts()) {
    const mat = part.name === 'track' ? trackMat : part.name === 'hull' ? bodyMat : turretMat;
    const mesh = new THREE.Mesh(part.geometry, mat);
    mesh.name = part.name === 'track' ? `track-${trackN++ === 0 ? 'left' : 'right'}` : part.name;
    mesh.position.copy(part.position);
    mesh.rotation.z = part.rotationZ;
    (part.parent === 'turret' ? turret : visual).add(mesh);
  }
  return root;
}

/** The resolved source revision, or null outside a git checkout. */
function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main() {
  installFileReaderShim();
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = resolve(outIdx > -1 ? argv[outIdx + 1] : 'assets/tank');
  await mkdir(outDir, { recursive: true });

  const exporter = new GLTFExporter();
  const written = [];
  for (const monochrome of [false, true]) {
    const tank = buildTank({ monochrome });
    const stem = monochrome ? 'tank-mono' : 'tank';
    const glb = await exporter.parseAsync(tank, { binary: true });
    await writeFile(join(outDir, `${stem}.glb`), Buffer.from(glb));
    const gltf = await exporter.parseAsync(tank, { binary: false });
    await writeFile(join(outDir, `${stem}.gltf`), `${JSON.stringify(gltf, null, 2)}\n`);
    written.push(`${stem}.glb`, `${stem}.gltf`);
  }

  const params = tankGeometryParameters();
  const meta = {
    // Recorded so a bundle found on a designer's disk can be traced back to a tree, which
    // is the difference between "this is the tank" and "this was the tank, once".
    sourceRevision: gitRevision(),
    generatedBy: 'tools/tank-assets/generate.mjs',
    playerHullHex: PLAYER_HULL_HEX,
    // The parameters come from the model, so this file cannot describe a tank the export
    // is not. A change to any of them shows up here as a value.
    geometry: params,
    parts: tankParts().map((p) => ({
      name: p.name,
      parent: p.parent,
      position: [p.position.x, p.position.y, p.position.z],
      rotationZ: p.rotationZ,
      vertices: p.geometry.attributes.position.count,
    })),
    files: written,
  };
  await writeFile(join(outDir, 'tank.json'), `${JSON.stringify(meta, null, 2)}\n`);

  console.log(`wrote ${written.length + 1} files to ${outDir}`);
  for (const f of [...written, 'tank.json']) console.log(`  ${f}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
