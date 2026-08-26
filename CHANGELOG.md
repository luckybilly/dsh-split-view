# Changelog

## 0.2.4 — 2026-08-26

- Settings: version footer at the bottom of the split-view section — current version, a live latest-version badge (queried from npmmirror/npmjs directly in the browser), and an upgrade entry that copies the install command when a newer version exists.

## 0.2.3 — 2026-08-26

- Ship the demo assets (demo.gif, demo2.png, demo3.png) inside the package so the README images render on npmjs.com. Package size grows from 48KB to about 8.9MB.

## 0.2.2 — 2026-08-26

- Removed a temporary agent-teams demo block that accidentally shipped in 0.2.1: it polled the dsh-agent-teams state route on boot and auto-split member sessions into panes. No pane opens by itself anymore.

## 0.2.1 — 2026-08-25

- Default "split right" shortcut changed from ⇧⌘H to ⇧⌘D (reachable with the left hand alone).
- Shortcut recording now warns instead of rejecting: combos taken by the browser or OS, and combos that collide with another action, still bind — you get an inline warning and keep full control.
- Settings: removed the hint paragraph under the shortcuts section.
- README: added a demo GIF and screenshots.

## 0.2.0 — 2026-08-25

- First public release.
- Splits the DSH main window into panes: a geometry engine over a stable flat layer, so layout changes move panes without reloading them.
- Each pane is a full DSH client in an iframe, pinned to its own session; new panes inherit the source pane's workspace.
- Dual-origin pool (127.0.0.1 + localhost) for up to 9 live panes; surplus panes hibernate LRU-style and wake on click.
- Per-pane title bar: live session title, split / maximize / reload / close buttons, click to rename, one-click copy of session info.
- Settings page: custom shortcut recording, focus highlight color, title-bar toggle, restore defaults; settings sync across panes on different origins.
- Service API for other plugins: pane lifecycle, pane×session operations, queries and subscriptions (see api.md).
