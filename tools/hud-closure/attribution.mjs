/**
 * Which pane of `createHud` each owner belongs to (issue #767).
 *
 * DATA, NOT FLAGS. The attribution is a heuristic, and #556's measured account said so. Keeping
 * it here means that moving an owner between panes is a diff a reviewer reads. Rerunning with
 * different options would not leave that record.
 *
 * HOW IT IS READ (`closure.mjs`):
 *  1. A name that a correction lists exactly goes where the correction says.
 *  2. Otherwise the name is lowercased, and the FIRST pane whose noun it contains owns it. Order
 *     matters: "controller" is checked before "selftest", so `showControllerSelfTest` needs a
 *     correction to reach Developer Tools.
 *  3. A statement with no name belongs to a pane when every pane-owned name it references is that
 *     pane's. Otherwise it is shared.
 *
 * Pure data. It imports nothing.
 */

/** The noun table from the #556 account (2026-09-15), in its order. */
export const PANES = Object.freeze([
  Object.freeze({
    pane: 'Controllers',
    nouns: Object.freeze(['controller', 'assignment', 'detectedpads', 'reassignslot', 'unsupported',
      'slotsource', 'candidatelabel', 'samesource']),
  }),
  Object.freeze({
    pane: 'Developer Tools',
    nouns: Object.freeze(['devtools', 'devcfg', 'devaction', 'devexport', 'devbadge', 'developer',
      'diag', 'export', 'selftest', 'gallery', 'legal', 'namespace', 'prodsave']),
  }),
  Object.freeze({
    pane: 'Versus Setup',
    nouns: Object.freeze(['versus', 'schematic', 'arenalabel', 'teamsofferedat']),
  }),
  Object.freeze({
    pane: 'Customize',
    nouns: Object.freeze(['customize', 'preview', 'swatch', 'skin', 'accent', 'hull']),
  }),
  Object.freeze({
    pane: 'Records',
    nouns: Object.freeze(['records', 'stats', 'achievement', 'earned', 'pct']),
  }),
  Object.freeze({
    pane: 'Settings',
    nouns: Object.freeze(['settings', 'scheme', 'firemode', 'haptics', 'rumble', 'quality', 'motion',
      'mute', 'volume', 'armedreset', 'disarmreset', 'dangerclick', 'relevance']),
  }),
]);

/** The label for an owner no pane claims. */
export const SHARED = 'shared';

/**
 * Exact-name corrections. `source` says who made each one, and `why` says what the heuristic got
 * wrong.
 *
 * The account described its corrections in prose ("the gameplay stock strip and outcome copy").
 * The names in the account's rows are this tool's reading of that prose, checked against the
 * source at `43adf28`.
 */
export const CORRECTIONS = Object.freeze([
  Object.freeze({
    source: '#556 account',
    pane: SHARED,
    why: 'Frame-wide state and gameplay copy whose names happen to contain a pane noun.',
    names: Object.freeze(['reducedMotion', 'currentModality', 'versusStocksEl', 'versusStocksVisible',
      'renderVersusStocks', 'versusResultsEl', 'renderVersusResultsLine', 'versusOutcomeTitle']),
  }),
  Object.freeze({
    source: '#556 account',
    pane: 'Settings',
    why: 'The two reset controls moved to Settings -> Data (issue #226), and rumble is a Settings control, although the names say "stats" and "controller".',
    names: Object.freeze(['resetStatsBtn', 'resetProgressBtn', 'handleResetStats', 'handleResetProgress',
      'resetStatsCbs', 'resetProgressCbs', 'onResetStats', 'onResetProgress', 'setControllerRumble',
      'onControllerRumbleChange']),
  }),
  Object.freeze({
    source: '#556 account',
    pane: 'Developer Tools',
    why: 'The controller self-test is a Developer Tools pane (issue #599), although its names say "controller".',
    names: Object.freeze(['showControllerSelfTest', 'onControllerSelfTestOpen', 'onControllerSelfTestClose',
      'setPadDiagnostics']),
  }),
  Object.freeze({
    source: '#767',
    pane: 'Settings',
    why: 'The Controller Layout pane (issue #754) opens from Settings and landed after the account. Five of these names contain "controller", and the rest match no noun.',
    names: Object.freeze(['layoutView', 'layoutBodyEl', 'layoutBackBtn', 'layoutOpenCbs',
      'layoutCloseCbs', 'layoutRequestCbs', 'layoutOpen', 'LAYOUT_SURFACE', 'showControllerLayout',
      'cancelLayoutCapture', 'layoutBody', 'handleSettingsLayoutOpen', 'handleLayoutBack',
      'setControllerLayout', 'onControllerLayoutRequest', 'onControllerLayoutOpen',
      'onControllerLayoutClose']),
  }),
  Object.freeze({
    source: '#767',
    pane: SHARED,
    why: '`recordStockLosses` is gameplay stock-strip code (issue #753): "records" matches inside the name. `setReducedMotion` is the member that writes the shared `reducedMotion`, and a setter stays with its binding.',
    names: Object.freeze(['recordStockLosses', 'setReducedMotion']),
  }),
  Object.freeze({
    source: '#767',
    pane: 'Records',
    why: 'The Achievements tab of Records. Its names abbreviate "achievement" to "ach", which no noun matches.',
    names: Object.freeze(['achView', 'achListEl', 'achCountEl', 'achBackBtn', 'ACH_SURFACE', 'handleAchBack']),
  }),
]);
