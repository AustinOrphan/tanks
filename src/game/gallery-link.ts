/**
 * The gallery workbench's page link (issue #730).
 *
 * ITS OWN MODULE for the reason `canvas-still.ts` is (issue #946): `loop.ts` needs this one
 * helper to build `galleryWorkbench.linkFor`, and taking it from `gallery-selection.ts` kept
 * that whole grammar -- and the customization catalogs it reads -- in the graph every ordinary
 * page load walks. Rolldown reported it as `INEFFECTIVE_DYNAMIC_IMPORT` when `route-ui.ts`
 * started importing the same module lazily. Nothing here imports anything, so this file is a
 * leaf and stays eager for free.
 */

/**
 * A page search carrying `value` as its `gallery` parameter, with the developer gate on and
 * every other parameter kept in place. `:` and `,` are left literal -- both are legal in a
 * query -- so the link reads the way the grammar above is written.
 *
 * @param search a `location.search`, with or without the leading `?`.
 */
export function gallerySearch(search: string, value: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete('gallery');
  if (params.get('dev') !== '1') {
    params.delete('dev');
    params.set('dev', '1');
  }
  const rest = params.toString();
  const encoded = encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2C/gi, ',');
  return `?${rest === '' ? '' : `${rest}&`}gallery=${encoded}`;
}
