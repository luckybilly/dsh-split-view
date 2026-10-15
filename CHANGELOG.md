# Changelog

## 0.2.6 — 2026-10-15

- Compat: DSH 0.2.0 removed `ctx.sessions.open()`, `ctx.sessions.clear()` and `SessionListState.current`, and added a peer-dependency gate that rejected the whole bundle (`skipping profile bundle "dsh-split-view"` in the boot log, no split buttons in the UI). 0.2.5 was therefore unusable on 0.2.x, which `npm dist-tag latest` for `@deepseek-ai/dsh` had already become. One build now spans both host generations.
  - Pane navigation goes through `ctx.uiWorkspace.openSession()` on 0.2.x and keeps `sessions.open()` / `sessions.clear()` on 0.1.x. The service is reached with `ctx.get()` rather than a fiber `inject` entry: `uiWorkspace` does not exist on 0.1.0-rc.6, and declaring it would block the fiber there and silently disable the plugin for that whole range.
  - Navigation by retaining a `mainView` reference directly — the literal reading of the new `sessions.retain(target, { source })` API — is deliberately not used. `dsh-client-ui-workspace` owns the single `mainView` reference that a dozen call sites across eight client packages read to derive the current session, so a plugin-held second reference is never released by the host and makes that derivation resolve a session the pane is not showing.
  - Pane title bar reads the shown session from `SessionSummary.retainedBy.mainView` on 0.2.x (the derivation the official layout uses) and from `list.current` on 0.1.x.
  - Boot seeding waits for the navigation service before navigating and re-asserts on a bounded schedule, since the service mounts after the client tree comes up while the session-list baseline can resolve first.
  - `peerDependencies` for the five `@deepseek-ai/dsh-client-*` packages widened to `^0.1.0-rc.6 || ^0.2.0-rc.2`.
- Behavior note: a fresh pane (`dshNew=1`) lands on its workspace's blank session on 0.2.x instead of the strict no-session view. 0.2.x restores the persisted selection whenever no main-view reference exists, so a blank session is that platform's own fresh-start state; on neither generation does a fresh pane show the previous session now.
- Fixed: the settings version footer reported 0.2.4 in the 0.2.5 release, which also made the "new version available" badge fire on an up-to-date install.

Thanks to @ztllll for reporting the 0.2.0 breakage and the `mainView` retention lead (#1).

## 0.2.5 — 2026-09-18

- Compat: DSH ≥0.1.2-alpha.1 split `dsh-client-runtime` into `dsh-client-modules` / `dsh-client-store` / `dsh-client-locale` and froze the platform module table to the new seed names, so the old static `require("@deepseek-ai/dsh-client-runtime/client")` misses the module table on new hosts ("Failed to load plugins"). Client bundle now falls back across both seeds (`dsh-client-store` first, legacy second), keeping one build working on both host generations — same technique as dsh-dream-skin 9.x (upstream issues #41/#43).

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
