/**
 * The build-time environment this bundle reads, declared so `tsc` knows it exists.
 *
 * ONE VARIABLE, and it is the only one the shipped game reads at all. `VITE_`-prefixed
 * because that is the only prefix Vite exposes to client code -- an unprefixed variable is
 * silently absent at runtime rather than a type error, which is exactly the failure this
 * declaration makes impossible to reach by accident.
 *
 * Optional, and that is the contract rather than an oversight: a `npm run dev` server, a
 * local `npm run build`, and any tree that never went through the deploy workflow genuinely
 * have no commit to name. `readBuildIdentity` in `build-identity.ts` turns its absence into
 * an explicit unknown, which issue #247 requires a copied report to state honestly rather
 * than paper over with an empty field.
 */
interface ImportMetaEnv {
  readonly VITE_BUILD_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
