/**
 * Picks one bootable iPhone simulator from `xcrun simctl list devices available -j`
 * output and prints its UDID on stdout, or a tab-separated name/UDID/runtime record with
 * `--details`. engines.yml uses the detailed form so a failed runner names the exact
 * device it exercised rather than reporting an opaque UUID. This avoids parsing
 * `simctl`'s human-readable table (not meant to be machine-read) or depending on `jq`
 * (not guaranteed present on every macOS runner image; Node already is, via setup-node).
 *
 * pickSimulatorUdid is exported separately from the CLI entry point specifically so it
 * can be unit-tested on ANY platform, including this Linux dev box, by feeding it
 * captured JSON -- `xcrun` itself only exists on macOS and cannot run here.
 */
import { execFileSync } from 'node:child_process';

/** [major, minor] from a runtime identifier like "com.apple.CoreSimulator.SimRuntime.iOS-17-4". */
function iosVersion(runtimeId) {
  const m = /iOS-(\d+)-(\d+)/.exec(runtimeId ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/**
 * `simctlJson` is either the raw JSON string `simctl list devices available -j` prints,
 * or the already-parsed object (accepted both ways so a test fixture can skip the
 * stringify/parse round trip). Shape: `{ devices: { "<runtime id>": [ {name, udid,
 * isAvailable, ...}, ... ] } }`.
 *
 * Picks an iPhone (name match, not device-type identifier -- `simctl`'s JSON does not
 * carry the device-type id at this list depth) on the HIGHEST available iOS runtime,
 * since that is the version most representative of what a real user's phone runs today.
 */
export function pickSimulator(simctlJson) {
  const data = typeof simctlJson === 'string' ? JSON.parse(simctlJson) : simctlJson;
  const devicesByRuntime = data.devices ?? {};
  const candidates = [];
  for (const [runtime, list] of Object.entries(devicesByRuntime)) {
    if (!/\.iOS-/.test(runtime)) continue; // skip watchOS/tvOS/xrOS runtime buckets
    for (const d of list ?? []) {
      if (d.isAvailable && /iPhone/i.test(d.name ?? '')) {
        candidates.push({ runtime, ...d });
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error('no available iPhone simulator found in `xcrun simctl list devices available -j`');
  }
  candidates.sort((a, b) => {
    const [aMaj, aMin] = iosVersion(a.runtime);
    const [bMaj, bMin] = iosVersion(b.runtime);
    return bMaj - aMaj || bMin - aMin;
  });
  const { name, runtime, udid } = candidates[0];
  return { name, runtime, udid };
}

/** Backward-compatible narrow result for callers that need only the boot target. */
export function pickSimulatorUdid(simctlJson) {
  return pickSimulator(simctlJson).udid;
}

/** Formats the CLI contract consumed by engines.yml's tab-delimited `read`. */
export function formatSimulator(picked, { details = false } = {}) {
  return details
    ? `${picked.name}\t${picked.udid}\t${picked.runtime}`
    : picked.udid;
}

// CLI entry only runs `simctl` when invoked directly (`node find-simulator.mjs`), so
// pickSimulatorUdid stays importable and testable without it -- see find-simulator.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--details')) {
    console.error(`unknown argument "${args.find((arg) => arg !== '--details')}"`);
    process.exit(2);
  }
  const json = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' });
  const picked = pickSimulator(json);
  console.log(formatSimulator(picked, { details: args.includes('--details') }));
}
