---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Deployment residuals, measured while shipping the GitHub Pages workflow
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Deployment residuals, measured while shipping the GitHub Pages workflow

**Raised 2026-08-03**, reviewing PR #80. Measured against the live `austinorphan.com`
Pages infrastructure using sibling project sites of the same account, because `/tanks/`
was not yet deployed.

**1. ~~The ten missing audio files cost 91.6 kB on every load~~ — CLOSED.** The manifest
no longer declares files that do not exist, so the ten requests are gone (measured on the
built bundle: 10 → 0). The entry stays only as the record of the measurement, because the
figure is quoted elsewhere: a GitHub Pages 404 body is 9,379 bytes and carries no
`cache-control`, so the cost was 93,790 bytes and 10 round trips on EVERY load, never
cached — re-measured directly against the deployed `/tanks/` rather than sibling sites,
10 of 10 requests, all 404, all uncached. The decision taken was the second of the two the
original entry named: stop requesting files that are not there, and let `src/audio/synth.ts`
be the voice rather than the fallback. `CREDITS.md`'s licensing policy is unchanged and
still unexercised — committing a real set remains open as issue #86.

**2. A service worker this repo does not own controls `/tanks/`.** The portfolio root
registers `navigator.serviceWorker.register("/sw.js")`, served from the origin root with no
`Service-Worker-Allowed` header, so its scope is `/`. It calls `clients.claim()`, and its
`activate` handler deletes every CacheStorage entry not named `austin-orphan-portfolio-v2`.
Harmless today — its precache list is `/`, `/blog`, `/rss.xml`, and `caches.match` is keyed
by exact URL, so every game request falls through to `fetch`. But any offline/precache work
here would be silently wiped whenever a player visits the portfolio, and if that worker
gains runtime caching the game would serve stale hashed assets with no way for this
pipeline to invalidate them. Not fixable from this repo. **UNVERIFIED:** the scope is
derived from the spec and the absent header, not measured in a browser —
`navigator.serviceWorker.getRegistrations()` on a deployed `/tanks/` page would settle it.

**3. HTTPS cannot be enforced through GitHub, because Cloudflare proxies the domain.**
`http://` and `https://` are different localStorage origins, and every save key is
origin-scoped, so anything built on the http origin vanishes when HTTPS is enforced. The
count in this line said **five** when it was written and is now **eight**, re-derived from
`save.ts` rather than re-listed by hand: `SAVE_KEYS` holds six (`tanks.progress.v1`,
`tanks.stats.v1`, `tanks.custom.v1`, `tanks.settings.v1`, `tanks.achievements.v1`,
`tanks.run.v1`), `SAVE_IMPORT_KEYS` adds `tanks.touch.v1` as a compatibility key, and
`tanks.versus.v1` is persisted by the versus setup store outside both lists (see the
game-data-plumbing topic's item 4). Settings and the campaign run are the additions that
matter most here -- they were not in the original five, and losing them is what an origin
change would actually cost a player. The
obvious fix does not work: `PUT /repos/AustinOrphan/tanks/pages -F https_enforced=true`
returns `"The certificate has not finished being issued"`. The reason is structural, not
transient — **all five** of the account's Pages sites report
`https_certificate.state: "bad_authz"` with the same `expires_at: 2026-07-24`, including
the apex, which already has `https_enforced: true` and serves fine. `austinorphan.com`
answers with `server: cloudflare` and a `cf-ray` header while `austinorphan.github.io`
answers `server: GitHub.com`, and the cert on the wire is a Cloudflare wildcard
(`SAN: *.austinorphan.com`) rather than the `[austinorphan.com, www.austinorphan.com]`
pair GitHub's record wants. GitHub's ACME challenge is answered by Cloudflare's edge, so
its authorization can never complete. The equivalent lever is **Cloudflare → SSL/TLS →
Edge Certificates → Always Use HTTPS**, which covers every project page on the zone at
once; the alternative is unproxying DNS, at the cost of the CDN.

**4. Copying `index.html` to `404.html` would break the site.** Pages serves a real 404 and
the game has no client-side router, so nothing needs the SPA fallback today. But that trick
is one file away and `base: './'` cannot survive it: `/tanks/foo/bar` would serve an
`index.html` whose `./assets/…` resolves to `/tanks/foo/assets/…`. This is *the* known
failure mode of a relative base.

**5. Untested claim, recorded rather than asserted:** CI and the deploy both build on the
Node 24 LTS line, but the deploy does not reuse CI's artifact. Whether two separate builds
produce byte-identical bundles is unmeasured. Nothing ships from the Node 22.13.0 floor
build, so there is no path from that build to the live site.

**6. No Open Graph or canonical tags** in `dist/index.html` (0 matches for
`og:|twitter:|rel="canonical"`), so sharing the link gives no preview card.

---
