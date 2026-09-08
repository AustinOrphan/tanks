# Issue #243 — developer-mode entry, indicator and exit

Captured from the production build (`npm run verify:build`), driven through the real
controls in Chromium at 1280x800. Every reading below is the script's own output, not a
description of the images.

| Shot | URL | What it shows |
| --- | --- | --- |
| `243-1-ordinary-main-menu` | `/` | **The control.** No badge, no menu entry. |
| `243-2-developer-main-menu` | `/?dev=1` | The DEV badge, and exactly one Developer Tools entry. |
| `243-3-developer-tools-pane` | `/?dev=1` | The shell: status, the non-privilege statement, Exit, Back. |
| `243-4-badge-during-gameplay` | `/?dev=1` | The badge persists into a match; the menu entry does not. |
| `243-5-reopened-from-the-badge` | `/?dev=1` | The badge reopens the shell mid-match. |
| `243-6-after-exit` | `/?ref=keep&dev=1&aimRay=1` → `/?ref=keep` | After Exit: developer parameters gone, `ref` kept, no developer UI. |

Measured during the run:

```
ordinary: badge visible = false      ordinary: entry visible = false
dev:      badge visible = true       dev:      entries       = 1
playing:  badge visible = true       playing:  entry visible = false
after exit, url = /?ref=keep         after exit: badge visible = false
page errors: none
```

The two readings that carry the design: `playing: entry visible = false` beside
`playing: badge visible = true` is why the issue needs both controls — the menu entry
lives in the Main Menu footer and obeys that footer's rule, so it cannot be the
"throughout menus and gameplay" indicator. And `after exit, url = /?ref=keep` is the
whole exit contract in one line: every developer parameter removed, the unrelated one
preserved.

The badge is bottom-left rather than in the topbar because the topbar is
gameplay-status-only since #226 and is hidden at the Main Menu.
