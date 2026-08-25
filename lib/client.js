// dsh-split-view — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-split-view/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). Same bundle shape as dsh-dream-skin and
// the shipped ui-* packages: plain CJS factory, require() answered from the
// shell module table (platform seed words + registered client bundles).
//
// Architecture:
// - Top window (no ?dshPane parameter): shadows the 'root' slot (priority -1,
//   lowest renders) and draws a split container. Each cell is an iframe
//   loading the full DSH client at /?dshPane=<id>[&dshSession=<sid>|&dshNew=1].
// - Pane window (has ?dshPane): the pane agent pins the client to its assigned
//   session via ctx.sessions.open() at boot (or ctx.sessions.clear() for a
//   fresh pane), reports selection changes and focus to the parent, and
//   forwards the split keyboard shortcuts as postMessage commands.
// - Preferences (shortcuts, focus highlight color, title-bar visibility) are
//   owned by the top window (it draws everything they control) and persisted
//   in its localStorage; panes hold a mirror synced over postMessage and edit
//   through the plugin's settings section, which the shell only renders inside
//   panes (the top window shadows the AppFrame and has no settings modal).
//
// Why iframes: the DSH client runtime is a per-page singleton (module table,
// cordis tree, renderer BindingContext all single-instance), so N concurrent
// sessions need N full clients. The server sends no X-Frame-Options/CSP
// frame-ancestors, the client has no frame-hostile code, and the current
// session is memory-resident after boot (localStorage is a boot seed only,
// with no storage-event sync), so same-origin iframe clients stay isolated.

// One-time key migration for the dsh-multi-view -> dsh-split-view rename.
// `dsh-multi:*` was the live namespace before the rename; any `dsh-split:*`
// values still present predate it, so the migrated values win. Runs at bundle
// load (top level), before the factory reads any key, and is idempotent: once
// no `dsh-multi:*` keys remain it does nothing.
(() => {
	try {
		const moved = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && key.indexOf("dsh-multi:") === 0) moved.push(key);
		}
		for (const key of moved) {
			localStorage.setItem("dsh-split:" + key.slice("dsh-multi:".length), localStorage.getItem(key));
			localStorage.removeItem(key);
		}
	} catch (e) { /* storage unavailable (pre-boot); defaults apply */ }
})();

window.__ModuleLoader__.load({
	id: "dsh-split-view",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const runtime = require("@deepseek-ai/dsh-client-runtime/client");

		//#region constants
		const params = new URLSearchParams(window.location.search);
		/** Pane identity: present means this page load is a split pane, not the splitter. */
		const PANE_ID = params.get("dshPane");
		/** Session this pane must show (forced at boot through sessions.open). */
		const SEED_SESSION = params.get("dshSession");
		/** Fresh pane with an inherited workspace: create/connect its workspace session. */
		const INHERIT_WORKSPACE = params.get("dshWorkspace");
		/** Fresh pane with an inherited working directory (no workspace). */
		const INHERIT_CWD = params.get("dshCwd");
		/** Fresh pane: boot into the no-session empty state instead of the persisted seed. */
		const WANT_NEW = params.get("dshNew") === "1";
		/** localStorage key holding the persisted split layout. */
		const LAYOUT_KEY = "dsh-split:layout";
		/** postMessage envelope type shared by pane agents and the splitter. */
		const MSG_TYPE = "dsh-split";
		/** Smallest fraction a divider may leave on either side. */
		const MIN_FRACTION = 0.06;
		/** Veil fallback: show the pane even if its ready message never arrives. */
		const VEIL_TIMEOUT_MS = 4000;
		/** Max concurrently live panes. Each pane is a full DSH client holding 2
		 * WebSockets; the browser's per-origin connection budget sustains ~5 live
		 * clients, and the 6th boot hangs at "Loading plugins…" until a client is
		 * freed (reproduced 100%; freeing one revives it instantly). 127.0.0.1
		 * and localhost are DISTINCT origins backed by the same loopback server,
		 * and a client on origin B boots fine while origin A is saturated
		 * (verified) — so panes alternate origins: 4 on the top window's origin
		 * (top itself is a client there) + 5 on the alternate origin = 9 live.
		 * Beyond the caps the least-recently-used pane hibernates (iframe
		 * unloaded, connections freed) and wakes on click. */
		const MAX_LIVE_PANES_MULTI = 9;
		const MAX_LIVE_PANES_SINGLE = 4;
		/** Per-origin live-pane caps, indexed like the pool: the top window's own
		 * origin hosts one extra client (the top window), so it gets one less. */
		const ORIGIN_CAPS_MULTI = [4, 5];
		const ORIGIN_CAPS_SINGLE = [4];
		function originPool() {
			const loc = window.location;
			const port = loc.port ? ":" + loc.port : "";
			if (loc.hostname === "127.0.0.1") return [loc.origin, loc.protocol + "//localhost" + port];
			if (loc.hostname === "localhost") return [loc.origin, loc.protocol + "//127.0.0.1" + port];
			return [loc.origin];
		}
		function pickOrigin(draft, pool, caps) {
			if (pool.length < 2) return 0;
			const counts = new Array(pool.length).fill(0);
			collectLeaves(draft.tree, []).forEach((l) => {
				// Skip the focused leaf — it is the new pane being placed (still
				// without an origin) and must not count against the fill order.
				if (l.id === draft.focused) return;
				counts[typeof l.origin === "number" && l.origin < pool.length ? l.origin : 0]++;
			});
			// Fill the first origin (the top's own) up to its cap before using
			// the alternate one. Same-origin panes share localStorage with the
			// top and skip the cross-origin sync machinery entirely, so the
			// common 2-4 pane case never touches it. Once every origin is at
			// cap, fall back to the least-loaded (the extra pane goes dormant
			// through the LRU live set).
			for (let i = 0; i < pool.length; i++) {
				if (counts[i] < caps[i]) return i;
			}
			let best = 0;
			for (let i = 1; i < pool.length; i++) {
				if (counts[i] < counts[best]) best = i;
			}
			return best;
		}
				/** localStorage keys that must NOT cross the pane↔top boundary: the
 * per-client current session, and the plugin's own keys (they already have
 * dedicated channels). Everything else — dream-skin, trajectory toggles, any
 * third-party plugin's config — syncs generically. */
const STORAGE_SYNC_DENY = new Set(["dsh.sessions.current"]);
const STORAGE_SYNC_DENY_PREFIXES = ["dsh-split:", "dsh-multi:"];
function shouldSyncKey(key) {
	if (!key) return false;
	if (STORAGE_SYNC_DENY.has(key)) return false;
	return !STORAGE_SYNC_DENY_PREFIXES.some((p) => key.startsWith(p));
}
function collectSyncedStorage() {
	const values = {};
	try {
		for (let i = 0; i < window.localStorage.length; i++) {
			const key = window.localStorage.key(i);
			if (shouldSyncKey(key)) {
				const v = window.localStorage.getItem(key);
				if (v !== null) values[key] = v;
			}
		}
	} catch {
		// storage unavailable — nothing to sync
	}
	return values;
}
		/** The theme service restores its built-in preference from the host
		 * settings document asynchronously; that adoption can land AFTER a
		 * skin plugin (dream-skin etc.) restored its custom skin at boot and
		 * reset the theme to the default. Re-apply the persisted skin while the
		 * boot settles: through the theme service (so other plugins follow
		 * theme/change) and directly onto the DOM (the layout presenter can
		 * miss boot-time events — its listener registers during its own apply). */
		function reapplyBootSkin(ctx) {
			const applySnapshot = () => {
				try {
					const snapshot = ctx.theme.getTheme();
					const active = snapshot.active;
					if (!active) return;
					const scheme = active.colorScheme;
					document.documentElement.style.colorScheme = scheme;
					const body = document.body;
					if (!body) return;
					if (scheme === "dark") body.setAttribute("data-ds-dark-theme", "");
					else body.removeAttribute("data-ds-dark-theme");
					for (const [name, value] of Object.entries(active.tokens)) body.style.setProperty(name, value);
				} catch {
					// best-effort — never break the boot
				}
			};
			const reconcile = () => {
				try {
					const skinId = window.localStorage.getItem("dsh-dream-skin:skin");
					if (typeof skinId === "string" && skinId.length > 0) {
						if (skinId !== ctx.theme.getTheme().preference) ctx.theme.setTheme(skinId);
						applySnapshot();
					}
				} catch {
					// best-effort
				}
			};
			const deadline = Date.now() + 15000;
			ctx.on("theme/change", () => {
				if (Date.now() > deadline) return;
				reconcile();
			});
			// Deferred passes: events racing ahead of the presenter's listener
			// registration get lost, so reconcile again after the boot settles.
			for (const delay of [2000, 5000, 10000]) setTimeout(reconcile, delay);
		}
		//#endregion

		const newId = () => "p" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

		/** Panes may live on a different origin than their parent (origin pool),
		 * so target the parent's origin derived from the referrer; loopback-only
		 * chatter, "*" fallback when the referrer is unavailable. */
		const PARENT_ORIGIN = (() => {
			try {
				if (document.referrer) return new URL(document.referrer).origin;
			} catch {
				// fall through to the wildcard
			}
			return "*";
		})();

		function postToParent(data) {
			try {
				if (window.parent && window.parent !== window) {
					window.parent.postMessage(Object.assign({ type: MSG_TYPE }, data), PARENT_ORIGIN);
				}
			} catch {
				// pane-to-parent chatter must never break the page
			}
		}

		//#region layout tree (pure draft mutators for the snapshot store)
		function freshLeaf() {
			return { kind: "leaf", id: newId(), session: null };
		}
		function defaultLayout() {
			const leaf = freshLeaf();
			return { tree: leaf, focused: leaf.id, maximized: null };
		}
		function findNode(node, id) {
			if (node.id === id) return node;
			if (node.kind !== "branch") return null;
			for (const child of node.children) {
				const hit = findNode(child, id);
				if (hit) return hit;
			}
			return null;
		}
		function findParent(node, id) {
			if (node.kind !== "branch") return null;
			for (let i = 0; i < node.children.length; i++) {
				if (node.children[i].id === id) return { parent: node, index: i };
				const hit = findParent(node.children[i], id);
				if (hit) return hit;
			}
			return null;
		}
		function firstLeafId(node) {
			if (node.kind === "leaf") return node.id;
			return firstLeafId(node.children[0]);
		}
		function lastLeafId(node) {
			if (node.kind === "leaf") return node.id;
			return lastLeafId(node.children[node.children.length - 1]);
		}
		/** The pane spatially adjacent to a leaf within its own split group — the
		 * sibling it was split from / that was split from it. Prefers the NEXT
		 * sibling (the one created by splitting this pane), falling back to the
		 * previous. When the chosen sibling is itself a nested group, return the
		 * leaf nearest the closing pane (first leaf of the next sibling, last
		 * leaf of the previous). Returns null for an only child. */
		function neighborLeafId(parent, index) {
			const n = parent.children.length;
			if (index + 1 < n) return firstLeafId(parent.children[index + 1]);
			if (index - 1 >= 0) return lastLeafId(parent.children[index - 1]);
			return null;
		}
		function replaceNode(draft, id, replacement) {
			const hit = findParent(draft.tree, id);
			if (!hit) return false;
			hit.parent.children[hit.index] = replacement;
			return true;
		}
		function splitLeaf(draft, leafId, dir, inherit) {
			const leaf = findNode(draft.tree, leafId);
			if (!leaf || leaf.kind !== "leaf") return;
			// The new pane starts a FRESH session but inherits the split pane's
			// workspace (or working directory) — ghostty-style: no manual
			// workspace/mode re-selection, without duplicating the conversation.
			const newLeaf = {
				kind: "leaf",
				id: newId(),
				// A pre-created session (from the public `split()` service) pins the
				// pane straight to it; otherwise the pane creates its own.
				session: inherit && inherit.session ? inherit.session : null,
				...(inherit && inherit.workspace ? { workspace: inherit.workspace } : {}),
				...(inherit && inherit.cwd ? { cwd: inherit.cwd } : {})
			};
			const branch = {
				kind: "branch",
				id: newId(),
				// The layout engine speaks "h"/"v"; normalize caller-friendly names.
				dir: dir === "right" ? "h" : dir === "down" ? "v" : dir,
				fractions: [0.5, 0.5],
				children: [leaf, newLeaf]
			};
			if (draft.tree.id === leafId) draft.tree = branch;
			else if (!replaceNode(draft, leafId, branch)) return;
			draft.focused = branch.children[1].id;
		}
		/** Non-empty string or null — the shared option-field normalizer. */
		const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);

		/** Normalize the model option: "provider/model" shorthand or
		 * {provider, model, reasoningEffort?}. Anything else → null. */
		function normalizeModel(raw) {
			if (raw && typeof raw === "object") {
				const provider = str(raw.provider);
				const modelId = str(raw.model);
				if (provider === null || modelId === null) return null;
				const effort = str(raw.reasoningEffort);
				return { provider, model: modelId, ...(effort !== null ? { reasoningEffort: effort } : {}) };
			}
			if (typeof raw === "string" && raw.length > 0) {
				const slash = raw.indexOf("/");
				if (slash > 0) return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
			}
			return null;
		}
		/** Normalize the public service's session-bearing option payloads
		 * (split / newSession) into canonical nullable fields; omitted or
		 * unknown options fall back to null (the default). */
		function normalizeSplitOptions(options) {
			const o = options && typeof options === "object" ? options : {};
			const direction = o.direction === "down" ? "down" : "right";
			const workspaceId = str(o.workspaceId);
			const cwd = str(o.cwd);
			const prompt = str(o.prompt);
			const title = str(o.title);
			const mode = str(o.mode);
			const session = str(o.session);
			/** Pane the action anchors to (defaults to the focused pane). */
			const pane = str(o.pane);
			return { direction, workspaceId, cwd, prompt, title, mode, model: normalizeModel(o.model), session, pane };
		}
		function closeLeaf(draft, leafId) {
			if (draft.tree.kind === "leaf") {
				if (draft.tree.id !== leafId) return;
				const leaf = freshLeaf();
				draft.tree = leaf;
				draft.focused = leaf.id;
				draft.maximized = null;
				return;
			}
			const hit = findParent(draft.tree, leafId);
			if (!hit) return;
			const { parent, index } = hit;
			// Resolve the successor BEFORE splicing: the adjacent sibling in the
			// pane's own split group (the pane it was split from / that was split
			// from it), never the layout's first pane.
			const successor = neighborLeafId(parent, index);
			parent.children.splice(index, 1);
			parent.fractions.splice(index, 1);
			if (parent.children.length === 1) {
				// pull the surviving sibling up into the vacated branch slot
				const only = parent.children[0];
				if (draft.tree.id === parent.id) draft.tree = only;
				else replaceNode(draft, parent.id, only);
			} else {
				const sum = parent.fractions.reduce((a, b) => a + b, 0) || 1;
				parent.fractions = parent.fractions.map((f) => f / sum);
			}
			if (draft.focused === leafId) draft.focused = successor ?? firstLeafId(draft.tree);
			if (draft.maximized === leafId) draft.maximized = null;
		}
		function setLeafSession(draft, leafId, sessionId) {
			const leaf = findNode(draft.tree, leafId);
			if (leaf && leaf.kind === "leaf") leaf.session = sessionId;
		}
		function nudgeFractions(draft, branchId, index, delta) {
			const branch = findNode(draft.tree, branchId);
			if (!branch || branch.kind !== "branch") return;
			if (index < 0 || index + 1 >= branch.fractions.length) return;
			const a = branch.fractions[index];
			const b = branch.fractions[index + 1];
			const clamped = Math.max(MIN_FRACTION - a, Math.min(delta, b - MIN_FRACTION));
			branch.fractions[index] = a + clamped;
			branch.fractions[index + 1] = b - clamped;
		}
		/** Validate + normalize an externally supplied layout tree (the public
		 * applyLayout escape hatch): leaves and branches only, unique ids
		 * (regenerated when absent or colliding), branch dir folded to h/v,
		 * fractions positive and renormalized (even split when missing or
		 * malformed). Throws a dsh-split-view error on any malformed node. */
		function normalizeLayoutTree(raw) {
			const seen = new Set();
			const takeId = (node) => {
				let id = typeof node.id === "string" && node.id.length > 0 ? node.id : newId();
				if (seen.has(id)) id = newId();
				seen.add(id);
				return id;
			};
			const norm = (node) => {
				if (!node || typeof node !== "object") throw new Error("dsh-split-view: layout nodes must be objects");
				if (node.kind === "leaf" || node.kind === "pane") {
					const leaf = { kind: "leaf", id: takeId(node), session: str(node.session) };
					if (typeof node.origin === "number" && isFinite(node.origin) && node.origin >= 0) leaf.origin = Math.floor(node.origin);
					return leaf;
				}
				if (node.kind === "branch" || node.kind === "split" || node.kind === "group") {
					if (!Array.isArray(node.children) || node.children.length < 2) throw new Error("dsh-split-view: a branch needs at least 2 children");
					const children = node.children.map(norm);
					const dir = node.dir === "v" || node.dir === "down" || node.dir === "up" ? "v" : "h";
					let fractions = Array.isArray(node.fractions) && node.fractions.length === children.length && node.fractions.every((f) => typeof f === "number" && isFinite(f) && f > 0)
						? node.fractions.slice()
						: children.map(() => 1 / children.length);
					const sum = fractions.reduce((a, b) => a + b, 0) || 1;
					fractions = fractions.map((f) => f / sum);
					return { kind: "branch", id: takeId(node), dir, fractions, children };
				}
				throw new Error("dsh-split-view: unknown layout node kind: " + String(node.kind));
			};
			return norm(raw);
		}
		//#endregion

		//#region preferences (shortcuts, focus color, title bars)
		// User preferences. The TOP WINDOW is the source of truth — it draws the
		// title bars, the focus highlight and the splitter the shortcuts drive —
		// and persists them in its own localStorage (PREFS_KEY). The settings UI
		// only ever opens inside a pane (the top shadows the AppFrame, so its
		// settings modal is unreachable), so panes hold a mirror synced over
		// postMessage: prefs-pull at boot, prefs-push broadcast on every change,
		// prefs-set carries edits back to the top.
		//
		// Shortcut defaults are the browser-safe mnemonic bindings picked in
		// earlier rounds: ⌘/Ctrl alone collides with browser chrome (⌘W close
		// tab, ⌘D bookmark, ⌘V paste…); ⌘⇧Q locked the browser and ⌘⇧W is
		// taken by Feishu's global hotkey — X reads as ✕. Mod+Shift+letter is
		// the space a page can actually capture. ⌘⇧Enter keeps maximize/restore.
		// split-right sits on D so the whole chord is a one-left-hand press;
		// note ⌘⇧D is reserved by some browsers ("bookmark all tabs") but is
		// capturable in chrome-less shells such as the native WKWebView app.
		/** localStorage key holding user preferences (persisted by the top window). */
		const PREFS_KEY = "dsh-split:prefs";
		/** Locale namespace of the settings section and its rows. */
		const SETTINGS_NS = "settings.splitView";
		const ACTION_IDS = ["split-right", "split-down", "close", "maximize"];
		const DEFAULT_SHORTCUTS = Object.freeze({
			"split-right": "Mod+Shift+D",
			"split-down": "Mod+Shift+V",
			"close": "Mod+Shift+X",
			"maximize": "Mod+Shift+Enter"
		});
		const DEFAULT_PREFS = Object.freeze({
			shortcuts: DEFAULT_SHORTCUTS,
			/** Hex color (always stored lowercase), or "theme" to follow the
			 * current skin's brand color. */
			focusColor: "#4d6bfe",
			showTitleBar: true
		});
		const FOCUS_COLOR_PRESETS = ["#4D6BFE", "#4098ff", "#2dd4bf", "#34d399", "#a78bfa", "#e879f9", "#fb923c", "#f87171"];
		const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(((typeof navigator.platform === "string" ? navigator.platform : "") + " " + navigator.userAgent));
		/** Key values that never end a combo — pressing them means "still chording". */
		const MODIFIER_KEYS = new Set(["meta", "control", "shift", "alt", "capslock", "fn", "fnlock", "numlock", "scrolllock"]);

		function normEventKey(event) {
			if (typeof event.key !== "string" || event.key.length === 0) return null;
			if (event.key === " ") return "space";
			return event.key.toLowerCase();
		}

		/** Parse a serialized combo ("Mod+Shift+D"). Mod (matched as ⌘ OR Ctrl on
		 * every platform — the same unification the original fixed map used) is
		 * mandatory; returns {shift, alt, key} or null. */
		function parseCombo(text) {
			if (typeof text !== "string") return null;
			const parts = text.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
			let mod = false;
			const parsed = { shift: false, alt: false, key: null };
			for (const part of parts) {
				const token = part.toLowerCase();
				if (token === "mod" || token === "cmd" || token === "ctrl" || token === "cmdorctrl") mod = true;
				else if (token === "shift") parsed.shift = true;
				else if (token === "alt" || token === "option") parsed.alt = true;
				else if (parsed.key === null && !MODIFIER_KEYS.has(token)) parsed.key = token;
				else return null;
			}
			return mod && parsed.key !== null ? parsed : null;
		}

		function comboToText(parsed) {
			const parts = ["Mod"];
			if (parsed.shift) parts.push("Shift");
			if (parsed.alt) parts.push("Alt");
			const key = parsed.key;
			parts.push(key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
			return parts.join("+");
		}

		function combosEqual(a, b) {
			return a !== null && b !== null && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
		}

		/** Which split command a key event carries under the given shortcut map
		 * (null when it matches no binding). */
		function commandOfEvent(event, shortcuts) {
			if (!(event.metaKey || event.ctrlKey)) return null;
			const key = normEventKey(event);
			if (key === null || MODIFIER_KEYS.has(key)) return null;
			const map = shortcuts || DEFAULT_SHORTCUTS;
			for (const cmd of ACTION_IDS) {
				const combo = parseCombo(map[cmd]);
				if (combo && combo.shift === event.shiftKey && combo.alt === event.altKey && combo.key === key) return cmd;
			}
			return null;
		}

		/** Platform-aware label for tooltips and the settings row (⌘⇧D / Ctrl+Shift+D). */
		function comboLabel(text) {
			const parsed = parseCombo(text);
			if (!parsed) return "—";
			const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1);
			if (IS_MAC) return "⌘" + (parsed.shift ? "⇧" : "") + (parsed.alt ? "⌥" : "") + key;
			return "Ctrl+" + (parsed.shift ? "Shift+" : "") + (parsed.alt ? "Alt+" : "") + key;
		}

		/** Recording-time advisory. Returns a locale warning key (resolved under
		 * "shortcuts.*" by the caller) or null. Every combo is bindable — the
		 * caller always binds — the warning only tells the user the binding may
		 * be shadowed by the browser, the OS, or another action; the choice is
		 * theirs. */
		function recordedWarning(parsed, map, actionId) {
			// Bare ⌘/Ctrl+letter is usually browser-reserved (⌘W closes the
			// tab, ⌘D bookmarks…) — the page may never see those events.
			if (parsed.key.length === 1 && !parsed.shift && !parsed.alt) return "warn.letter";
			// Combinations with a painful history or a browser/system reservation
			// (⌘⇧Q locked the browser, ⌘⇧W closes all windows / is Feishu's
			// global hotkey, ⌘⇧T reopens tabs, ⌘⇧N opens private windows).
			if (parsed.shift && !parsed.alt && (parsed.key === "w" || parsed.key === "q" || parsed.key === "t" || parsed.key === "n")) return "warn.danger";
			for (const other of ACTION_IDS) {
				if (other === actionId) continue;
				if (combosEqual(parseCombo(map[other]), parsed)) return "warn.dup";
			}
			return null;
		}

		/** Merge anything storage (or a message) produced back into a guaranteed
		 * full, internally consistent prefs object. */
		function normalizePrefs(raw) {
			const source = raw && typeof raw === "object" ? raw : {};
			const rawShortcuts = source.shortcuts && typeof source.shortcuts === "object" ? source.shortcuts : {};
			const shortcuts = {};
			for (const cmd of ACTION_IDS) {
				let parsed = parseCombo(rawShortcuts[cmd]);
				if (!parsed) parsed = parseCombo(DEFAULT_SHORTCUTS[cmd]);
				shortcuts[cmd] = comboToText(parsed);
			}
			let focusColor = DEFAULT_PREFS.focusColor;
			if (source.focusColor === "theme") focusColor = "theme";
			else if (typeof source.focusColor === "string" && /^#[0-9a-fA-F]{6}$/.test(source.focusColor)) focusColor = source.focusColor.toLowerCase();
			return {
				shortcuts,
				focusColor,
				showTitleBar: source.showTitleBar === undefined ? DEFAULT_PREFS.showTitleBar : !!source.showTitleBar
			};
		}

		/** Apply a partial settings edit. Returns the merged prefs or null when
		 * nothing in the patch was valid — the top window is authoritative, so
		 * an all-invalid patch silently keeps the current state. */
		function patchPrefs(current, patch) {
			if (!patch || typeof patch !== "object") return null;
			const next = {
				shortcuts: Object.assign({}, current.shortcuts),
				focusColor: current.focusColor,
				showTitleBar: current.showTitleBar
			};
			let changed = false;
			if (patch.shortcuts && typeof patch.shortcuts === "object") {
				for (const cmd of ACTION_IDS) {
					const text = patch.shortcuts[cmd];
					if (text === undefined) continue;
					const parsed = parseCombo(text);
					if (!parsed) continue;
					const nextText = comboToText(parsed);
					if (next.shortcuts[cmd] !== nextText) {
						next.shortcuts[cmd] = nextText;
						changed = true;
					}
				}
			}
			if (patch.focusColor !== undefined) {
				const value = patch.focusColor;
				const valid = value === "theme" || (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value));
				if (valid) {
					const norm = value === "theme" ? "theme" : value.toLowerCase();
					if (norm !== next.focusColor) {
						next.focusColor = norm;
						changed = true;
					}
				}
			}
			if (patch.showTitleBar !== undefined) {
				const on = !!patch.showTitleBar;
				if (on !== next.showTitleBar) {
					next.showTitleBar = on;
					changed = true;
				}
			}
			return changed ? next : null;
		}
		//#endregion

		//#region settings locale
		const zh = {
			"nav": "分屏",
			"shortcuts.title": "快捷键",
			"shortcuts.split-right": "向右分屏",
			"shortcuts.split-down": "向下分屏",
			"shortcuts.close": "关闭面板",
			"shortcuts.maximize": "最大化 / 还原",
			"shortcuts.record": "按新的组合键…",
			"shortcuts.recordHint": "按 Esc 取消",
			"shortcuts.reset": "恢复默认",
			"shortcuts.err.noMod": "组合键需包含 ⌘ 或 Ctrl",
			"shortcuts.warn.letter": "已绑定。单个字母/数字不带 Shift 或 Alt 的组合（如 ⌘D）通常被浏览器保留，页面可能捕捉不到",
			"shortcuts.warn.danger": "已绑定。该组合可能被浏览器或系统全局热键占用（如 ⌘⇧W 会关掉所有窗口），没反应就换一个",
			"shortcuts.warn.dup": "已绑定。该组合与另一个动作的快捷键相同，按下时列表里靠前的动作响应",
			"color.title": "选中高亮色",
			"color.theme": "跟随主题",
			"color.pick": "自定义…",
			"color.hint": "聚焦面板的描边和标题栏染色。「跟随主题」随当前皮肤的品牌色变化，换皮肤后自动跟着变。",
			"titlebar.title": "标题栏",
			"titlebar.show": "显示面板标题栏",
			"titlebar.hint": "标题栏承载会话标题（点击标题文字可重命名；新会话显示文件夹名、不可重命名）、复制会话信息按钮和分屏、最大化、刷新、关闭五个按钮，双击标题栏空白处可放大/还原；隐藏后请用快捷键操作，点面板任意位置仍可聚焦。",
			"reset.title": "恢复默认",
			"reset.button": "恢复默认设置",
			"reset.hint": "把快捷键、选中高亮色、标题栏开关全部还原为默认值。",
			"reset.confirm": "确定把分屏设置全部恢复为默认值吗？"
		};

		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"nav": "Split View",
			"shortcuts.title": "Keyboard Shortcuts",
			"shortcuts.split-right": "Split right",
			"shortcuts.split-down": "Split down",
			"shortcuts.close": "Close pane",
			"shortcuts.maximize": "Maximize / restore",
			"shortcuts.record": "Press a new combo…",
			"shortcuts.recordHint": "Esc to cancel",
			"shortcuts.reset": "Reset to defaults",
			"shortcuts.err.noMod": "The combo needs ⌘ or Ctrl",
			"shortcuts.warn.letter": "Bound. A bare letter/digit without Shift or Alt (e.g. ⌘D) is usually kept by the browser, so the page may never see it",
			"shortcuts.warn.danger": "Bound. This combo may be taken by the browser or an OS global hotkey (e.g. ⌘⇧W closes all windows) — switch if it does nothing",
			"shortcuts.warn.dup": "Bound. This combo is shared with another action; the action listed earlier responds on keypress",
			"color.title": "Focus Highlight Color",
			"color.theme": "Follow theme",
			"color.pick": "Custom…",
			"color.hint": "The outline of the focused pane and its title-bar tint. “Follow theme” tracks the current skin's brand color.",
			"titlebar.title": "Title Bar",
			"titlebar.show": "Show pane title bars",
			"titlebar.hint": "The title bar carries the session title (click the title text to rename; blank new sessions show the folder name and cannot be renamed), a copy-session-info button and the split / maximize / reload / close buttons. Double-click the title bar to maximize/restore. With it hidden, use the keyboard shortcuts instead; clicking a pane still focuses it.",
			"reset.title": "Restore Defaults",
			"reset.button": "Restore default settings",
			"reset.hint": "Reset shortcuts, focus highlight color and the title-bar switch back to their defaults.",
			"reset.confirm": "Restore all split-view settings to their defaults?"
		};
		//#endregion

		//#region pane agent (runs inside ?dshPane loads)
		function applyPane(ctx) {
			// Prefs mirror of the top window (the source of truth — see the
			// preferences region header). Same-origin panes share the top's
			// localStorage and can seed directly; cross-origin panes stay on
			// defaults until the prefs-pull below is answered.
			const prefs = runtime.createSnapshotStore(normalizePrefs({}), {});
			try {
				const raw = window.localStorage.getItem(PREFS_KEY);
				if (raw !== null) prefs.set(normalizePrefs(JSON.parse(raw)));
			} catch {
				// storage unavailable or corrupt — defaults apply
			}
			const prefsChannel = {
				getPrefs: () => prefs.getSnapshot(),
				subscribe: (fn) => prefs.subscribe(fn),
				savePrefs: (patch) => {
					// Optimistic local echo keeps the row snappy; the top window
					// stays authoritative and broadcasts the canonical state back.
					const next = patchPrefs(prefs.getSnapshot(), patch);
					if (next) prefs.set(next);
					postToParent({ kind: "prefs-set", pane: PANE_ID, patch });
				}
			};
			applySettings(ctx, prefsChannel);
			ctx.effect(() => {
				const sessions = ctx.sessions;
				// Session seeding is gated on the list baseline: SessionManager.select
				// validates the id against the listed summaries and throws "unknown
				// session" while the session.list RPC is still in flight (observed in
				// the wild). Try once the list resolves; a still-unknown id then means
				// the session is genuinely gone (deleted/archived elsewhere) — give up
				// gracefully and let the pane fall back to adoption/empty state.
				let seeded = false;
				const seedInherited = () => {
					const opts = INHERIT_WORKSPACE ? { workspaceId: INHERIT_WORKSPACE } : { cwd: INHERIT_CWD };
					const fallback = () => {
						try {
							sessions.clear();
						} catch {
							// empty-state fallback is best-effort
						}
					};
					try {
						Promise.resolve(sessions.create(opts)).then((result) => {
							let target = result && result.ok && result.value ? result.value.sessionId : void 0;
							if (target === void 0 && INHERIT_WORKSPACE) {
								// create may report "workspace already attached" and the
								// runtime upserts that workspace's blank session — find it.
								const listSnap = sessions.list.getSnapshot();
								const blank = listSnap.ids.map((id) => listSnap.byId[id]).find((s) => s && s.blank);
								if (blank) target = blank.id;
							}
							if (target !== void 0) {
								try {
									sessions.open(target);
									return;
								} catch {
									// fall through to the empty state
								}
							}
							fallback();
						}).catch(fallback);
					} catch {
						fallback();
					}
				};
				const trySeed = () => {
					if (seeded) return;
					if (sessions.list.getSnapshot().phase === "pending") return;
					seeded = true;
					if (SEED_SESSION) {
						try {
							sessions.open(SEED_SESSION);
						} catch (error) {
							console.warn("dsh-split-view: pane session seed unavailable, pane falls back", error);
						}
						return;
					}
					if (INHERIT_WORKSPACE || INHERIT_CWD) {
						seedInherited();
						return;
					}
					if (WANT_NEW) {
						try {
							sessions.clear();
						} catch {
							// empty-state fallback is best-effort
						}
					}
				};
				trySeed();
				const offSeed = seeded ? () => {} : sessions.list.subscribe(trySeed);
				const report = () => {
					const listSnap = sessions.list.getSnapshot();
					const current = listSnap.current;
					const summary = current === null || current === void 0 ? void 0 : listSnap.byId[current];
					postToParent({
						kind: "session",
						pane: PANE_ID,
						sessionId: current ?? null,
						title: summary ? (summary.displayTitle ?? summary.title ?? null) : null,
						// Blank sessions (empty log) display the workspace folder name
						// as their title and must NOT be renamable from the title bar.
						blank: summary ? !!summary.blank : true,
						// Durable title (absent while the display title is the derived
						// folder-name fallback) — seeds the rename editor.
						realTitle: summary && typeof summary.title === "string" ? summary.title : null
					});
				};
				report();
				const offList = sessions.list.subscribe(report);
				const onActivity = () => postToParent({ kind: "focus", pane: PANE_ID });
				const onKey = (event) => {
					const cmd = commandOfEvent(event, prefs.getSnapshot().shortcuts);
					if (cmd === null) return;
					event.preventDefault();
					event.stopPropagation();
					postToParent({ kind: "cmd", cmd, pane: PANE_ID });
				};
				document.addEventListener("mousedown", onActivity, true);
				window.addEventListener("focus", onActivity);
				document.addEventListener("keydown", onKey, true);
				return () => {
					offSeed();
					offList();
					document.removeEventListener("mousedown", onActivity, true);
					window.removeEventListener("focus", onActivity);
					document.removeEventListener("keydown", onKey, true);
				};
			}, "split-view: pane agent");
						reapplyBootSkin(ctx);
			ctx.effect(() => {
			// Cross-origin storage sync: a pane on the alternate loopback origin
			// has its own storage-partitioned localStorage, so client-side
			// preferences (dream-skin skin/wallpaper, trajectory toggles, any
			// plugin's config) do not carry over. Pull the top's snapshot at
			// boot, then forward every later localStorage write back to the top
			// so it stays the source of truth. Same-origin panes share storage
			// and skip this entirely.
			let parentOrigin = null;
			try {
				if (document.referrer) parentOrigin = new URL(document.referrer).origin;
			} catch {
				// unparseable referrer — nothing to sync against
			}
			if (parentOrigin === null || parentOrigin === window.location.origin) return;
			// True once the boot pull has landed. Writes before that are boot
			// restores, not user intent, and must not overwrite the top.
			let synced = false;
			// Retry the boot pull a few times: if the first pull is lost (the top
			// side booting slow or a transient message drop), synced would stay
			// false forever and every later write would silently never forward.
			let pullTries = 0;
			let pullTimer = null;
			const sendPull = () => {
				if (synced || pullTries >= 5) return;
				pullTries += 1;
				postToParent({ kind: "storage-pull", pane: PANE_ID });
				pullTimer = setTimeout(sendPull, 2000);
			};
			const onStoragePush = (event) => {
				if (event.origin !== parentOrigin) return;
				const data = event.data;
				if (!data || data.type !== MSG_TYPE || data.kind !== "storage-push" || !data.values) return;
				window.removeEventListener("message", onStoragePush);
				try {
					for (const key of Object.keys(data.values)) {
						if (!shouldSyncKey(key)) continue;
						try {
							window.localStorage.setItem(key, data.values[key]);
						} catch {
							// quota — skip this key
						}
					}
					// Drop synced keys the top no longer has.
					const drop = [];
					for (let i = 0; i < window.localStorage.length; i++) {
						const key = window.localStorage.key(i);
						if (shouldSyncKey(key) && !(key in data.values)) drop.push(key);
					}
					for (const key of drop) {
						try {
							window.localStorage.removeItem(key);
						} catch {
							// best-effort
						}
					}
				} catch {
					// storage unavailable — the values cannot apply
				}
				// Re-apply the theme preference so theme-listening plugins
				// (dream-skin etc.) pick up the freshly written keys.
				try {
					const skinId = data.values["dsh-dream-skin:skin"];
					if (typeof skinId === "string" && skinId.length > 0 && skinId !== ctx.theme.getTheme().preference) ctx.theme.setTheme(skinId);
					const dispose = ctx.theme.overrideTokens("dsh-split-view:storage-sync", {});
					dispose();
				} catch {
					// theme re-apply is best-effort
				}
				if (pullTimer !== null) clearTimeout(pullTimer);
				synced = true;
			};
			window.addEventListener("message", onStoragePush);
			sendPull();
			// Intercept this pane's own localStorage writes and forward them to
			// the top (which mirrors them and serves them back on the next
			// reload). Only window.localStorage writes cross the boundary.
			const forwardWrite = (key, value) => {
				if (!synced || !shouldSyncKey(key)) return;
				postToParent({ kind: "storage-set", pane: PANE_ID, key, value });
			};
			const origSet = Storage.prototype.setItem;
			const origRemove = Storage.prototype.removeItem;
			const origClear = Storage.prototype.clear;
			const patchedSet = function (key, value) {
				origSet.call(this, key, value);
				if (this === window.localStorage) forwardWrite(key, String(value));
			};
			const patchedRemove = function (key) {
				origRemove.call(this, key);
				if (this === window.localStorage) forwardWrite(key, null);
			};
			const patchedClear = function () {
				const keys = [];
				for (let i = 0; i < this.length; i++) {
					const k = this.key(i);
					if (shouldSyncKey(k)) keys.push(k);
				}
				origClear.call(this);
				if (this === window.localStorage) {
					for (const k of keys) forwardWrite(k, null);
				}
			};
			Storage.prototype.setItem = patchedSet;
			Storage.prototype.removeItem = patchedRemove;
			Storage.prototype.clear = patchedClear;
			return () => {
				if (pullTimer !== null) clearTimeout(pullTimer);
				window.removeEventListener("message", onStoragePush);
				if (Storage.prototype.setItem === patchedSet) Storage.prototype.setItem = origSet;
				if (Storage.prototype.removeItem === patchedRemove) Storage.prototype.removeItem = origRemove;
				if (Storage.prototype.clear === patchedClear) Storage.prototype.clear = origClear;
			};
		}, "split-view: cross-origin storage sync");
			ctx.effect(() => {
				// Prefs sync with the top window: pull once at boot, then follow
				// prefs-push broadcasts (every top-side change, including edits
				// made in another pane's settings modal). Works for same- and
				// cross-origin panes alike — the channel is postMessage, not
				// storage events.
				let parentOrigin = null;
				try {
					if (document.referrer) parentOrigin = new URL(document.referrer).origin;
				} catch {
					// unparseable referrer — accept any origin (loopback-only server)
				}
				const onPrefs = (event) => {
					if (parentOrigin !== null && event.origin !== parentOrigin) return;
					const data = event.data;
					if (!data || data.type !== MSG_TYPE || data.kind !== "prefs-push" || !data.prefs) return;
					prefs.set(normalizePrefs(data.prefs));
				};
				window.addEventListener("message", onPrefs);
				postToParent({ kind: "prefs-pull", pane: PANE_ID });
				return () => window.removeEventListener("message", onPrefs);
			}, "split-view: prefs sync");
			ctx.effect(() => {
				// Top→pane control channel (public service `open` / `reload`):
				// swap the shown session or reload the pane live, without
				// touching the boot URL. Origin-gated like the other top
				// broadcasts (referrer-derived parent origin).
				let parentOrigin = null;
				try {
					if (document.referrer) parentOrigin = new URL(document.referrer).origin;
				} catch {
					// unparseable referrer — accept any origin (loopback-only server)
				}
				const onControl = (event) => {
					if (parentOrigin !== null && event.origin !== parentOrigin) return;
					const data = event.data;
					if (!data || data.type !== MSG_TYPE) return;
					if (data.kind === "open-session" && typeof data.sessionId === "string") {
						const target = data.sessionId;
						const openNow = () => {
							try {
								ctx.sessions.open(target);
								return true;
							} catch {
								return false;
							}
						};
						if (openNow()) return;
						// select validates against the list baseline; while the
						// list RPC is in flight every id fails, so retry once it
						// resolves (same gate as the boot seeding).
						if (ctx.sessions.list.getSnapshot().phase !== "pending") return;
						const off = ctx.sessions.list.subscribe(() => {
							if (ctx.sessions.list.getSnapshot().phase === "pending") return;
							off();
							try {
								ctx.sessions.open(target);
							} catch {
								// genuinely gone (deleted elsewhere) — keep the current session
							}
						});
					} else if (data.kind === "reload") {
						window.location.reload();
					}
				};
				window.addEventListener("message", onControl);
				return () => window.removeEventListener("message", onControl);
			}, "split-view: top control channel");
		}
		//#endregion

		//#region settings UI (settings.section + rows)
		// Follows the dsh-dream-skin pattern: one settings.section registration
		// (a category in the settings left nav) hosting rows through its own child
		// slot. The section only ever becomes visible inside panes — the top
		// window shadows the AppFrame, so its settings modal never opens — but it
		// registers in both modes; the row API object decides where edits land
		// (top: the authoritative persisted store; pane: the synced mirror plus a
		// prefs-set message to the top).
		const settingsStyles = {
			section: { display: "flex", flexDirection: "column", width: "100%" },
			group: {
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "16px 0"
			},
			title: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" },
			hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
			error: { color: "var(--dsw-alias-state-error-primary,#e5484d)", fontSize: "12px", lineHeight: "18px" },
			warning: { color: "var(--dsw-alias-state-warning-primary,#b8860b)", fontSize: "12px", lineHeight: "18px" },
			actionRow: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			kvRow: { display: "flex", alignItems: "center", gap: "10px" },
			kvLabel: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px" },
			button: {
				height: "32px",
				padding: "0 14px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-elevated-fill)",
				color: "var(--dsw-alias-label-primary)",
				cursor: "pointer",
				fontSize: "13px",
				font: "inherit",
				boxSizing: "border-box"
			},
			buttonDanger: { color: "var(--dsw-alias-state-error-primary,#e5484d)" },
			comboChip: {
				height: "28px",
				minWidth: "110px",
				padding: "0 10px",
				borderRadius: "7px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)",
				cursor: "pointer",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: "12px",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				boxSizing: "border-box"
			},
			comboChipRecording: {
				borderColor: "var(--dsw-alias-brand-primary,#4D6BFE)",
				color: "var(--dsw-alias-brand-primary,#4D6BFE)",
				background: "color-mix(in srgb, var(--dsw-alias-brand-primary,#4D6BFE) 10%, transparent)"
			},
			chipBtn: {
				height: "28px",
				padding: "0 12px",
				borderRadius: "7px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				fontSize: "12px",
				font: "inherit",
				boxSizing: "border-box"
			},
			chipBtnActive: {
				color: "var(--dsw-alias-brand-primary,#4D6BFE)",
				borderColor: "var(--dsw-alias-brand-primary,#4D6BFE)",
				background: "color-mix(in srgb, var(--dsw-alias-brand-primary,#4D6BFE) 10%, transparent)"
			},
			mono: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
			swatch: {
				width: "24px",
				height: "24px",
				borderRadius: "50%",
				border: "1px solid rgba(128,128,128,0.4)",
				cursor: "pointer",
				padding: 0,
				boxSizing: "border-box",
				flex: "none"
			},
			swatchActive: { outline: "2px solid var(--dsw-alias-label-primary)", outlineOffset: "1px" },
			switchTrack: {
				width: "36px",
				height: "22px",
				borderRadius: "11px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				cursor: "pointer",
				position: "relative",
				padding: 0,
				flex: "none",
				transition: "background .15s ease, border-color .15s ease"
			},
			switchTrackOn: { background: "var(--dsw-alias-brand-primary,#4D6BFE)", borderColor: "var(--dsw-alias-brand-primary,#4D6BFE)" },
			switchKnob: {
				position: "absolute",
				top: "2px",
				left: "2px",
				width: "16px",
				height: "16px",
				borderRadius: "50%",
				background: "#fff",
				boxShadow: "0 1px 2px rgba(0,0,0,.25)",
				transition: "left .15s ease",
				display: "block"
			},
			switchKnobOn: { left: "16px" }
		};

		/** Row store: one shared prefs snapshot for every row (the handle's
		 * identity keys the instance, so all rows read the same state). */
		function createPrefsRowStore() {
			return runtime.defineStore({
				init: () => ({ prefs: normalizePrefs({}), revision: -1 }),
				actions: {
					sync: (d, prefs, revision) => {
						if (revision <= d.revision) return;
						d.prefs = prefs;
						d.revision = revision;
					}
				}
			});
		}

		function SplitViewSection({ renderSlot }) {
			return React.createElement("div", { style: settingsStyles.section }, renderSlot("settings.splitView.item", {}));
		}

		/** Shortcut row: one recording chip per action. Click a chip, press the
		 * new combination (Esc cancels). Every combo is bindable; combos that
		 * the browser/OS is likely to keep, or that collide with another
		 * action, are accepted with an inline warning instead of rejected.
		 * Only a missing ⌘/Ctrl stays a hard error (the runtime never fires
		 * without it). */
		function ShortcutsRow({ t, useStore, setShortcut }) {
			const prefs = useStore((s) => s.prefs);
			const [recording, setRecording] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [warning, setWarning] = React.useState(null);
			const prefsRef = React.useRef(prefs);
			prefsRef.current = prefs;
			React.useEffect(() => {
				if (recording === null) return;
				const onKey = (event) => {
					event.preventDefault();
					event.stopPropagation();
					const key = normEventKey(event);
					if (key === "escape") {
						setRecording(null);
						setError(null);
						return;
					}
					if (key === null || MODIFIER_KEYS.has(key)) return;
					if (!(event.metaKey || event.ctrlKey)) {
						setError(t("shortcuts.err.noMod"));
						return;
					}
					const parsed = { shift: event.shiftKey, alt: event.altKey, key };
					setShortcut(recording, comboToText(parsed));
					setRecording(null);
					setError(null);
					const warnKey = recordedWarning(parsed, prefsRef.current.shortcuts, recording);
					setWarning(warnKey === null ? null : t("shortcuts." + warnKey));
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, [recording]);
			return React.createElement("div", { style: settingsStyles.group },
				React.createElement("div", { style: settingsStyles.title }, t("shortcuts.title")),
				ACTION_IDS.map((cmd) => React.createElement("div", { style: settingsStyles.kvRow, key: cmd },
					React.createElement("span", { style: Object.assign({}, settingsStyles.kvLabel, { width: "110px", flex: "none" }) }, t("shortcuts." + cmd)),
					React.createElement("button", {
						type: "button",
						style: recording === cmd
							? Object.assign({}, settingsStyles.comboChip, settingsStyles.comboChipRecording)
							: settingsStyles.comboChip,
						title: recording === cmd ? t("shortcuts.recordHint") : undefined,
						"aria-pressed": recording === cmd ? "true" : undefined,
						onClick: () => {
							setError(null);
							setWarning(null);
							setRecording(recording === cmd ? null : cmd);
						}
					}, recording === cmd ? t("shortcuts.record") : comboLabel(prefs.shortcuts[cmd]))
				)),
				React.createElement("div", { style: settingsStyles.actionRow },
					error !== null
						? React.createElement("span", { style: settingsStyles.error }, error)
						: warning !== null && recording === null ? React.createElement("span", { style: settingsStyles.warning }, warning) : null,
					recording !== null ? React.createElement("span", { style: settingsStyles.hint }, t("shortcuts.recordHint")) : null
				)
			);
		}

		/** Focus highlight color row: "follow theme", preset swatches, custom picker. */
		function FocusColorRow({ t, useStore, setFocusColor }) {
			const prefs = useStore((s) => s.prefs);
			const color = prefs.focusColor;
			const pickerRef = React.useRef(null);
			const active = color === "theme" ? null : color;
			return React.createElement("div", { style: settingsStyles.group },
				React.createElement("div", { style: settingsStyles.title }, t("color.title")),
				React.createElement("div", { style: settingsStyles.actionRow },
					React.createElement("button", {
						type: "button",
						style: color === "theme"
							? Object.assign({}, settingsStyles.chipBtn, settingsStyles.chipBtnActive)
							: settingsStyles.chipBtn,
						"aria-pressed": color === "theme" ? "true" : "false",
						onClick: () => setFocusColor("theme")
					}, t("color.theme")),
					FOCUS_COLOR_PRESETS.map((hex) => React.createElement("button", {
						key: hex,
						type: "button",
						title: hex,
						"aria-pressed": color === hex.toLowerCase() ? "true" : "false",
						style: Object.assign({}, settingsStyles.swatch, { background: hex }, color === hex.toLowerCase() ? settingsStyles.swatchActive : null),
						onClick: () => setFocusColor(hex)
					})),
					React.createElement("button", {
						type: "button",
						style: settingsStyles.button,
						onClick: () => { if (pickerRef.current) pickerRef.current.click(); }
					}, t("color.pick")),
					React.createElement("input", {
						ref: pickerRef,
						type: "color",
						value: active || "#4d6bfe",
						style: { display: "none" },
						onChange: (event) => setFocusColor(event.target.value)
					}),
					React.createElement("span", { style: settingsStyles.mono }, color === "theme" ? t("color.theme") : color)
				),
				React.createElement("div", { style: settingsStyles.hint }, t("color.hint"))
			);
		}

		/** Title bar visibility row. */
		function TitleBarRow({ t, useStore, setShowTitleBar }) {
			const prefs = useStore((s) => s.prefs);
			const show = prefs.showTitleBar;
			return React.createElement("div", { style: settingsStyles.group },
				React.createElement("div", { style: settingsStyles.title }, t("titlebar.title")),
				React.createElement("div", { style: settingsStyles.actionRow },
					React.createElement("button", {
						type: "button",
						role: "switch",
						"aria-checked": show ? "true" : "false",
						style: Object.assign({}, settingsStyles.switchTrack, show ? settingsStyles.switchTrackOn : null),
						onClick: () => setShowTitleBar(!show)
					}, React.createElement("span", {
						style: Object.assign({}, settingsStyles.switchKnob, show ? settingsStyles.switchKnobOn : null)
					})),
					React.createElement("span", { style: settingsStyles.kvLabel }, t("titlebar.show"))
				),
				React.createElement("div", { style: settingsStyles.hint }, t("titlebar.hint"))
			);
		}

		/** Restore-defaults row: one click (with confirm) back to factory state. */
		function ResetRow({ t, resetAll, useStore }) {
			const prefs = useStore((s) => s.prefs);
			const dirty = JSON.stringify(prefs) !== JSON.stringify(normalizePrefs({}));
			return React.createElement("div", { style: settingsStyles.group },
				React.createElement("div", { style: settingsStyles.title }, t("reset.title")),
				React.createElement("div", { style: settingsStyles.actionRow },
					React.createElement("button", {
						type: "button",
						style: Object.assign({}, settingsStyles.button, dirty ? settingsStyles.buttonDanger : { opacity: 0.55 }),
						onClick: () => {
							if (!dirty) return;
							let ok = true;
							try {
								ok = window.confirm(t("reset.confirm"));
							} catch {
								// confirm unavailable — reset directly
							}
							if (ok) resetAll();
						}
					}, t("reset.button"))
				),
				React.createElement("div", { style: settingsStyles.hint }, t("reset.hint"))
			);
		}

		/**
		 * Register the settings section + rows.
		 * @param ctx - client cordis context.
		 * @param api - prefs channel: getPrefs(), subscribe(fn), savePrefs(patch).
		 */
		function applySettings(ctx, api) {
			ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), "dsh-split-view: settings dictionaries");

			const rowStore = createPrefsRowStore();
			const rowActions = new Set();
			let revision = 0;
			const syncRows = () => {
				revision += 1;
				const prefs = api.getPrefs();
				for (const actions of rowActions) actions.sync(prefs, revision);
			};
			ctx.effect(() => api.subscribe(syncRows), "dsh-split-view: settings row sync");
			const bindRow = (actions) => {
				rowActions.add(actions);
				syncRows();
				return {
					setShortcut: (cmd, combo) => {
						const patch = { shortcuts: {} };
						patch.shortcuts[cmd] = combo;
						api.savePrefs(patch);
					},
					setFocusColor: (value) => api.savePrefs({ focusColor: value }),
					setShowTitleBar: (on) => api.savePrefs({ showTitleBar: !!on }),
					resetAll: () => api.savePrefs({
						shortcuts: Object.assign({}, DEFAULT_SHORTCUTS),
						focusColor: DEFAULT_PREFS.focusColor,
						showTitleBar: DEFAULT_PREFS.showTitleBar
					})
				};
			};

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "split-view",
				order: 30,
				label: () => ctx.locale.bind(SETTINGS_NS)("nav"),
				locale: SETTINGS_NS,
				children: { "settings.splitView.item": {
					kind: "list",
					scope: "root"
				} }
			}, SplitViewSection));

			ctx.slots.inject("settings.splitView.item", () => ctx.slots.register({
				name: "settings.splitView.item",
				id: "split-view-shortcuts",
				order: 10,
				store: rowStore,
				locale: SETTINGS_NS,
				inject: bindRow
			}, ShortcutsRow));

			ctx.slots.inject("settings.splitView.item", () => ctx.slots.register({
				name: "settings.splitView.item",
				id: "split-view-focus-color",
				order: 20,
				store: rowStore,
				locale: SETTINGS_NS,
				inject: bindRow
			}, FocusColorRow));

			ctx.slots.inject("settings.splitView.item", () => ctx.slots.register({
				name: "settings.splitView.item",
				id: "split-view-title-bar",
				order: 30,
				store: rowStore,
				locale: SETTINGS_NS,
				inject: bindRow
			}, TitleBarRow));

			ctx.slots.inject("settings.splitView.item", () => ctx.slots.register({
				name: "settings.splitView.item",
				id: "split-view-reset",
				order: 90,
				store: rowStore,
				locale: SETTINGS_NS,
				inject: bindRow
			}, ResetRow));

			// The shell's settings nav hard-codes the per-section icon by entry id
			// (models / agent-presets / plugins get distinct icons, everything else
			// falls back to the generic gear) and the settings.section contract
			// carries no icon option — so this section would draw the gear like any
			// unknown page. Patch the rendered nav instead: hide the gear on our
			// label-matched cell and append a split-view icon (additive only — the
			// React-managed nodes stay in place, so reconciliation never trips).
			// Runs per pane window: the top window shadows the AppFrame, so the
			// settings dialog only ever mounts here.
			ctx.effect(() => {
				const NAV_ICON = '<svg class="dsh-split-nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"></rect><line x1="8" y1="2.75" x2="8" y2="13.25"></line><line x1="8" y1="8" x2="14.25" y2="8"></line></svg>';
				const labels = new Set([zh.nav, en.nav]);
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-split-view-settings-icon");
				style.textContent = ".dsh-split-nav-icon{order:-1;flex:none;}";
				document.head.append(style);
				let queued = false;
				const patch = () => {
					queued = false;
					const cells = document.querySelectorAll('div[role="dialog"] nav button[type="button"]');
					for (const cell of cells) {
						const span = cell.querySelector("span");
						if (!span || !labels.has(span.textContent.trim())) continue;
						for (const gear of cell.querySelectorAll("svg:not(.dsh-split-nav-icon)")) gear.style.display = "none";
						if (cell.querySelector(".dsh-split-nav-icon") === null) cell.insertAdjacentHTML("beforeend", NAV_ICON);
					}
				};
				const schedule = () => {
					if (queued) return;
					queued = true;
					requestAnimationFrame(patch);
				};
				schedule();
				const observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
				return () => {
					observer.disconnect();
					style.remove();
				};
			}, "dsh-split-view: settings nav icon");
		}
		//#endregion

		//#region top window (the splitter)
		function useSnap(store, selector) {
			const sel = selector ?? ((value) => value);
			return React.useSyncExternalStore(store.subscribe, () => sel(store.getSnapshot()));
		}

		function Divider({ dir, rect, usable, hidden, onNudge }) {
			const onPointerDown = (event) => {
				event.preventDefault();
				const el = event.currentTarget;
				if (usable <= 0) return;
				let last = dir === "h" ? event.clientX : event.clientY;
				// Direct tracking while dragging: kill the layout transitions so
				// panes follow the pointer 1:1 instead of lagging behind it.
				document.body.classList.add("dsh-split-dragging");
				try {
					el.setPointerCapture(event.pointerId);
				} catch {
					// capture is a nicety; dragging still works without it
				}
				const move = (ev) => {
					const pos = dir === "h" ? ev.clientX : ev.clientY;
					const delta = (pos - last) / usable;
					last = pos;
					if (delta !== 0) onNudge(delta);
				};
				const up = () => {
					el.removeEventListener("pointermove", move);
					el.removeEventListener("pointerup", up);
					el.removeEventListener("pointercancel", up);
					document.body.classList.remove("dsh-split-dragging");
				};
				el.addEventListener("pointermove", move);
				el.addEventListener("pointerup", up);
				el.addEventListener("pointercancel", up);
			};
			return React.createElement("div", {
				className: "dsh-split-divider " + (dir === "h" ? "dsh-split-divider-v" : "dsh-split-divider-h") + (hidden ? " dsh-split-divider-hidden" : ""),
				style: { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
				onPointerDown
			});
		}

		// Boot gate: each pane boot bursts ~40 bundle fetches plus 2 WebSocket
		// handshakes at the origin. Simultaneous pane boots stampede shared
		// connection resources and intermittently hang boots in constrained
		// environments (observed: random stuck panes in a busy Chrome profile,
		// never reproducible in a clean Chromium). At most MAX_CONCURRENT_BOOT
		// iframes may load at once; a Pane acquires a slot before mounting its
		// iframe src and releases it when the agent reports ready, the fallback
		// fires, or the pane unmounts.
		const MAX_CONCURRENT_BOOT = 2;
		const bootGate = (() => {
			let active = 0;
			const waiters = [];
			const grant = () => {
				while (active < MAX_CONCURRENT_BOOT && waiters.length > 0) {
					active++;
					waiters.shift()();
				}
			};
			return {
				acquire(cb) {
					if (active < MAX_CONCURRENT_BOOT) {
						active++;
						cb();
					} else waiters.push(cb);
				},
				release() {
					if (active > 0) active--;
					grant();
				}
			};
		})();

		function Pane({ leaf, focused, ready, rect, hidden, dormant, onWake, base, title, info, maximized, actions, labels }) {
			const iframeRef = React.useRef(null);
			// The iframe URL is frozen per boot cycle: rebuilt when a boot starts
			// (so a woken pane re-enters the session it reported before
			// hibernation instead of re-running its birth URL), and never touched
			// while the iframe is live — a changed src would reload the pane.
			const srcRef = React.useRef(null);
			const srcCycleRef = React.useRef(-1);
			const [bootCycle, setBootCycle] = React.useState(0);
			const [booting, setBooting] = React.useState(false);
			const [fallback, setFallback] = React.useState(false);
			// Token-based gate release: each mount cycle owns one token, so an
			// unmount/remount cycle (React StrictMode double-invoke, key churn)
			// can neither leak a boot slot nor double-free one — the released
			// flag lives on the per-cycle token, and cleanup only frees a slot
			// the cycle actually consumed.
			const tokenRef = React.useRef(null);
			const releaseGate = () => {
				const token = tokenRef.current;
				if (token && token.acquired && !token.released) {
					token.released = true;
					bootGate.release();
				}
			};
			React.useEffect(() => {
				// Dormant panes hold no iframe: the effect's cleanup already freed
				// the boot slot, and unmounting the iframe closed its WebSockets —
				// that is exactly what hibernation is for.
				if (dormant) {
					setBooting(false);
					return;
				}
				setFallback(false);
				const token = { acquired: false, released: false };
				tokenRef.current = token;
				let cancelled = false;
				bootGate.acquire(() => {
					if (cancelled || token.released) {
						bootGate.release();
						return;
					}
					token.acquired = true;
					setBootCycle((c) => c + 1);
					setBooting(true);
				});
				return () => {
					cancelled = true;
					if (token.acquired && !token.released) {
						token.released = true;
						bootGate.release();
					}
				};
			}, [dormant]);
			// Ready report frees the gate immediately; otherwise the fallback
			// (started when the iframe actually begins loading) frees it and shows
			// the stale chip so a hung boot is visible and reloadable instead of
			// an unexplained spinner.
			React.useEffect(() => {
				if (ready) releaseGate();
			}, [ready]);
			React.useEffect(() => {
				if (!booting) return;
				const t = setTimeout(() => {
					setFallback(true);
					releaseGate();
				}, VEIL_TIMEOUT_MS);
				return () => clearTimeout(t);
			}, [booting]);
			// Pull the browser focus into the pane on boot/ready edges only.
			// Deliberately NOT keyed on `focused`: when the user clicks into a
			// not-yet-focused pane, the browser hands focus to the clicked
			// element (an input, say) by itself — a parent-side frame.focus()
			// fired on the same focused flip steals it back to the iframe
			// document body, so the first click never reaches the input and a
			// second click is needed. Layout actions that still need a focus
			// transfer (split/wake boots land here via booting/ready; the
			// close-survivor is handled explicitly by actions.close).
			React.useEffect(() => {
				if (!focused || dormant) return;
				const frame = iframeRef.current;
				if (!frame) return;
				try {
					frame.focus();
					if (frame.contentWindow) frame.contentWindow.focus();
				} catch {
					// focus is best-effort
				}
			}, [booting, ready]);
			const stale = fallback && !ready;
			const reloadPane = () => {
				const frame = iframeRef.current;
				if (!frame) return;
				setFallback(false);
				try {
					frame.contentWindow.location.reload();
				} catch {
					frame.src = srcRef.current;
				}
			};
			//#region title-bar interactions (maximize on dblclick, session-id copy, inline rename)
			const sessionId = typeof leaf.session === "string" && leaf.session.length > 0 ? leaf.session : null;
			// Renamable only once the session has content: blank sessions display
			// the workspace folder name as a placeholder title, which must not be
			// edited (it re-derives from the workspace).
			const canEdit = sessionId !== null && info !== null && info.blank === false;
			const realTitle = info !== null && typeof info.realTitle === "string" ? info.realTitle : null;
			const [editing, setEditing] = React.useState(false);
			const [draft, setDraft] = React.useState("");
			const [copied, setCopied] = React.useState(false);
			// Single-click opens the rename editor only after the double-click
			// window passes — a double-click on the title bar maximizes instead
			// and cancels the pending editor. Any follow-up mousedown anywhere
			// cancels it too, so "click title, then click into the pane" never
			// pops the editor 250ms later.
			const editTimer = React.useRef(null);
			const editCancelRef = React.useRef(null);
			const clearEditTimer = () => {
				if (editTimer.current !== null) {
					clearTimeout(editTimer.current);
					editTimer.current = null;
				}
				if (editCancelRef.current !== null) {
					window.removeEventListener("mousedown", editCancelRef.current, true);
					editCancelRef.current = null;
				}
			};
			React.useEffect(() => clearEditTimer, []);
			React.useEffect(() => {
				if (!copied) return;
				const t = setTimeout(() => setCopied(false), 1200);
				return () => clearTimeout(t);
			}, [copied]);
			// A pane can change identity (session replaced) or become un-editable
			// while the editor is open — drop the editor instead of renaming the
			// wrong session.
			React.useEffect(() => {
				if (editing && !canEdit) {
					clearEditTimer();
					setEditing(false);
				}
			}, [editing, canEdit]);
			const onTitleClick = () => {
				if (!canEdit || editing) return;
				clearEditTimer();
				editTimer.current = setTimeout(() => {
					editTimer.current = null;
					// Focus already moved into a pane iframe while waiting — the
					// original click was not an edit intent.
					const active = document.activeElement;
					if (active && active.tagName === "IFRAME") {
						clearEditTimer();
						return;
					}
					setDraft(realTitle ?? "");
					setEditing(true);
				}, 250);
				editCancelRef.current = () => clearEditTimer();
				window.addEventListener("mousedown", editCancelRef.current, true);
			};
			const exitEdit = () => {
				clearEditTimer();
				setEditing(false);
			};
			const commitEdit = () => {
				clearEditTimer();
				setEditing(false);
				const next = draft.trim();
				if (sessionId === null || next.length === 0) return;
				if (next === (realTitle ?? "")) return;
				actions.rename(leaf.id, next);
			};
			const onTitleBarDoubleClick = (event) => {
				clearEditTimer();
				const target = event.target;
				// Interactive islands keep their own double-click semantics: the
				// action buttons and the rename editor (word-selection in the input).
				if (target && target.closest && target.closest(".dsh-split-tb-actions, .dsh-split-title-edit")) return;
				actions.maximize(leaf.id);
			};
			const copySessionId = () => {
				if (sessionId === null) return;
				const text = "会话 id： " + sessionId + "\n会话标题： " + (typeof title === "string" ? title : "");
				const done = () => setCopied(true);
				const fallback = () => {
					try {
						const ta = document.createElement("textarea");
						ta.value = text;
						ta.setAttribute("readonly", "");
						ta.style.position = "fixed";
						ta.style.left = "-9999px";
						document.body.appendChild(ta);
						ta.select();
						document.execCommand("copy");
						ta.remove();
						done();
					} catch {
						// clipboard unavailable — no feedback
					}
				};
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text).then(done, fallback);
					} else fallback();
				} catch {
					fallback();
				}
			};
			//#endregion
			// Geometry comes from the layout engine; hidden panes (maximized
			// away) keep their home rect and fade out, so restore is instant,
			// never reloads, and animates smoothly.
			const paneStyle = rect
				? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
				: { display: "none" };
			if (booting && srcCycleRef.current !== bootCycle) {
				srcCycleRef.current = bootCycle;
				const q = new URLSearchParams();
				q.set("dshPane", leaf.id);
				if (leaf.session) q.set("dshSession", leaf.session);
				else if (leaf.workspace) q.set("dshWorkspace", leaf.workspace);
				else if (leaf.cwd) q.set("dshCwd", leaf.cwd);
				else q.set("dshNew", "1");
				srcRef.current = base + "/?" + q.toString();
			}
			return React.createElement("div", {
				className: "dsh-split-pane" + (focused ? " dsh-split-pane-focused" : "") + (hidden ? " dsh-split-pane-hidden" : ""),
				style: paneStyle,
				"data-leaf": leaf.id
			},
			React.createElement("div", {
				className: "dsh-split-titlebar" + (focused ? " dsh-split-titlebar-focused" : ""),
				onMouseDown: () => actions.focus(leaf.id),
				onDoubleClick: onTitleBarDoubleClick
			},
			editing
				? React.createElement("span", { className: "dsh-split-title-edit" },
					React.createElement("input", {
						className: "dsh-split-title-input",
						value: draft,
						autoFocus: true,
						placeholder: "输入会话名称…",
						onFocus: (e) => e.target.select(),
						onChange: (e) => setDraft(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitEdit();
							} else if (e.key === "Escape") {
								e.preventDefault();
								exitEdit();
							}
						},
						onBlur: () => exitEdit()
					}),
					React.createElement("button", {
						className: "dsh-split-tb-btn dsh-split-title-confirm",
						title: "确认重命名（Enter）",
						// keep the input focused so its blur (cancel) never races the click
						onMouseDown: (e) => e.preventDefault(),
						onClick: (e) => {
							e.stopPropagation();
							commitEdit();
						}
					}, iconCheck()))
				: React.createElement("span", {
					className: "dsh-split-title" + (canEdit ? " dsh-split-title-editable" : ""),
					onClick: onTitleClick,
					title: canEdit ? (typeof title === "string" && title.length > 0 ? title + " · 点击重命名" : "点击重命名") : undefined
				}, title || (dormant ? "已休眠" : "…")),
			!editing && sessionId !== null ? React.createElement("button", {
				className: "dsh-split-tb-btn" + (copied ? " dsh-split-tb-btn-ok" : ""),
				title: copied ? "已复制会话信息" : "复制会话信息",
				onClick: (e) => {
					e.stopPropagation();
					copySessionId();
				}
			}, copied ? iconCheck() : iconCopy()) : null,
			React.createElement("span", { className: "dsh-split-tb-actions" },
			tbButton(iconSplitRight(), "向右分屏（" + labels.splitRight + "）", () => actions.split(leaf.id, "right")),
			tbButton(iconSplitDown(), "向下分屏（" + labels.splitDown + "）", () => actions.split(leaf.id, "down")),
			tbButton(maximized ? iconShrink() : iconExpand(), maximized ? "还原（" + labels.maximize + "）" : "放大（" + labels.maximize + "）", () => actions.maximize(leaf.id)),
			tbButton(iconRefresh(), dormant ? "唤醒该面板" : "刷新该面板", dormant ? onWake : reloadPane),
			tbButton(iconClose(), "关闭面板（" + labels.close + "）", () => actions.close(leaf.id), true))),
			React.createElement("div", { className: "dsh-split-pane-body" },
			dormant ? React.createElement("button", {
				className: "dsh-split-dormant",
				title: "该面板已休眠以释放连接资源，点击唤醒",
				onClick: onWake
			},
			React.createElement("div", { className: "dsh-split-dormant-icon" }, "😴"),
			React.createElement("div", null, "已休眠 · 点击唤醒")) : React.createElement(React.Fragment, null,
			!ready ? React.createElement("div", { className: "dsh-split-veil" },
				React.createElement("div", { className: "dsh-split-spinner" }),
				React.createElement("div", { className: "dsh-split-veil-hint" }, booting ? "启动中…" : "等待启动…")
			) : null,
			stale ? React.createElement("button", {
				className: "dsh-split-stale",
				title: "该面板未在预期时间内就绪，点击重载",
				onClick: reloadPane
			}, "⚠ 未就绪 · 重载") : null,
			booting ? React.createElement("iframe", {
				ref: iframeRef,
				className: "dsh-split-iframe",
				src: srcRef.current,
				title: "session pane " + leaf.id
			}) : null)));
		}
		/** Small icon button for the per-pane title bar. */
		function tbButton(icon, title, onClick, danger) {
			return React.createElement("button", {
				className: "dsh-split-tb-btn" + (danger ? " dsh-split-tb-btn-danger" : ""),
				title,
				onClick
			}, icon);
		}
		/** Crisp stroke icons on a 16-grid, inheriting currentColor. */
		function svgIcon() {
			const children = Array.prototype.slice.call(arguments);
			return React.createElement.apply(React, ["svg", {
				width: "13",
				height: "13",
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			}].concat(children));
		}
		const iconSplitRight = () => svgIcon(
			React.createElement("rect", { x: "1.75", y: "3", width: "12.5", height: "10", rx: "1.5" }),
			React.createElement("path", { d: "M8 3 V13" }),
			React.createElement("path", { d: "M9.9 8 H12.3" }),
			React.createElement("path", { d: "M11.2 6.9 L12.3 8 L11.2 9.1" })
		);
		const iconSplitDown = () => svgIcon(
			React.createElement("rect", { x: "1.75", y: "3", width: "12.5", height: "10", rx: "1.5" }),
			React.createElement("path", { d: "M1.75 8 H14.25" }),
			React.createElement("path", { d: "M8 9.3 V11.7" }),
			React.createElement("path", { d: "M6.9 10.6 L8 11.7 L9.1 10.6" })
		);
		/** Maximize = video-player fullscreen mark: diagonal two-way corner arrows. */
		const iconExpand = () => svgIcon(
			React.createElement("polyline", { points: "10 2 14 2 14 6" }),
			React.createElement("polyline", { points: "6 14 2 14 2 10" }),
			React.createElement("line", { x1: "14", y1: "2", x2: "9.3", y2: "6.7" }),
			React.createElement("line", { x1: "2", y1: "14", x2: "6.7", y2: "9.3" })
		);
		const iconShrink = () => svgIcon(
			React.createElement("polyline", { points: "2.7 9.3 6.7 9.3 6.7 13.3" }),
			React.createElement("polyline", { points: "13.3 6.7 9.3 6.7 9.3 2.7" }),
			React.createElement("line", { x1: "9.3", y1: "6.7", x2: "14", y2: "2" }),
			React.createElement("line", { x1: "2", y1: "14", x2: "6.7", y2: "9.3" })
		);
		const iconRefresh = () => svgIcon(
			React.createElement("polyline", { points: "15.3 2.7 15.3 6.7 11.3 6.7" }),
			React.createElement("path", { d: "M13.66 10a6 6 0 1 1-1.41-6.24L15.33 6.67" })
		);
		const iconClose = () => svgIcon(
			React.createElement("line", { x1: "4.5", y1: "4.5", x2: "11.5", y2: "11.5" }),
			React.createElement("line", { x1: "11.5", y1: "4.5", x2: "4.5", y2: "11.5" })
		);
		const iconCopy = () => svgIcon(
			React.createElement("rect", { x: "5.5", y: "5.5", width: "8.5", height: "8.5", rx: "1.5" }),
			React.createElement("path", { d: "M10.5 3.25 V3 A1.25 1.25 0 0 0 9.25 1.75 H3 A1.25 1.25 0 0 0 1.75 3 V9.25 A1.25 1.25 0 0 0 3 10.5 H3.25" })
		);
		const iconCheck = () => svgIcon(
			React.createElement("polyline", { points: "2.75 8.5 6.25 12 13.25 4.25" })
		);

		//#region layout geometry
		const DIVIDER_PX = 5;

		function collectLeaves(node, out) {
			if (node.kind === "leaf") {
				out.push(node);
				return out;
			}
			node.children.forEach((child) => collectLeaves(child, out));
			return out;
		}

		/** The LRU live set with PER-ORIGIN caps, shared by the renderer and
		 * the public service (both must agree on which panes are dormant).
		 * Focused/maximized lead the candidate order so they win a slot first;
		 * the rest follow focus recency, then tree order. A candidate whose
		 * origin is already at cap is skipped (it hibernates), so no origin
		 * ever exceeds the browser's live-client budget. */
		function computeLiveSet(snap, order, pool, caps, maxLive) {
			const allLeaves = collectLeaves(snap.tree, []);
			const leafById = new Map(allLeaves.map((l) => [l.id, l]));
			const candidates = [];
			if (snap.focused) candidates.push(snap.focused);
			if (snap.maximized) candidates.push(snap.maximized);
			for (let i = order.length - 1; i >= 0; i--) candidates.push(order[i]);
			for (const l of allLeaves) candidates.push(l.id);
			const set = new Set();
			const perOrigin = new Array(pool.length).fill(0);
			for (const id of candidates) {
				if (set.size >= maxLive) break;
				if (set.has(id)) continue;
				const leaf = leafById.get(id);
				if (!leaf) continue;
				const o = typeof leaf.origin === "number" && leaf.origin < pool.length ? leaf.origin : 0;
				if (perOrigin[o] >= caps[o]) continue;
				set.add(id);
				perOrigin[o]++;
			}
			return set;
		}

		// Geometry engine: pixel rects for every leaf and divider from the layout
		// tree. Panes and dividers render as absolutely-positioned siblings under
		// one stable container, keyed by leaf id at a constant tree position, so
		// structural changes (split/close/maximize) only move rects — React never
		// remounts a Pane and its iframe survives: split/close resize instead of
		// reloading, and maximize restore is instant.
		function computeLayout(node, x, y, w, h, out) {
			if (w <= 0 || h <= 0) return;
			if (node.kind === "leaf") {
				out.panes.push({ id: node.id, x, y, w, h });
				return;
			}
			const horizontal = node.dir === "h";
			const span = horizontal ? w : h;
			const usable = Math.max(0, span - (node.children.length - 1) * DIVIDER_PX);
			let offset = 0;
			node.children.forEach((child, i) => {
				if (i > 0) {
					const pos = offset - DIVIDER_PX;
					out.dividers.push(horizontal
						? { key: node.id + "-d" + i, dir: node.dir, branchId: node.id, index: i - 1, usable, x: x + pos, y, w: DIVIDER_PX, h }
						: { key: node.id + "-d" + i, dir: node.dir, branchId: node.id, index: i - 1, usable, x, y: y + pos, w, h: DIVIDER_PX });
				}
				const size = Math.max(0, usable * node.fractions[i]);
				if (horizontal) computeLayout(child, x + offset, y, size, h, out);
				else computeLayout(child, x, y + offset, w, size, out);
				offset += size + DIVIDER_PX;
			});
		}
		//#endregion

		function SplitterRoot({ layout, panesReady, liveOrder, actions, handleCommand, pool, caps, maxLive, paneTitles, paneInfo, prefs }) {
			const snap = useSnap(layout);
			const readyMap = useSnap(panesReady);
			const order = useSnap(liveOrder);
			const titles = useSnap(paneTitles);
			const infoMap = useSnap(paneInfo);
			const prefsSnap = useSnap(prefs);
			// Preferences → render state: the focus color rides one CSS custom
			// property (the ::after outline and the title-bar tint read it);
			// "theme" delegates to the skin's brand token.
			const focusVar = prefsSnap.focusColor === "theme" ? "var(--dsw-alias-brand-primary,#4D6BFE)" : prefsSnap.focusColor;
			const labels = {
				splitRight: comboLabel(prefsSnap.shortcuts["split-right"]),
				splitDown: comboLabel(prefsSnap.shortcuts["split-down"]),
				close: comboLabel(prefsSnap.shortcuts["close"]),
				maximize: comboLabel(prefsSnap.shortcuts["maximize"])
			};
			const bodyRef = React.useRef(null);
			const [size, setSize] = React.useState(null);
			React.useEffect(() => {
				const el = bodyRef.current;
				if (!el) return;
				const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
				measure();
				const observer = new ResizeObserver(measure);
				observer.observe(el);
				return () => observer.disconnect();
			}, []);
			const maximizedTarget = snap.maximized ? findNode(snap.tree, snap.maximized) : null;
			// Geometry: home rects come from the full tree so panes hidden by
			// maximize keep their place (fade out/in instead of popping); the
			// maximized pane gets the whole body rect. Everything animates via
			// CSS transitions; divider drags disable them for direct tracking.
			const home = { panes: [], dividers: [] };
			if (size) computeLayout(snap.tree, 0, 0, size.w, size.h, home);
			const rectById = {};
			home.panes.forEach((p) => {
				rectById[p.id] = p;
			});
			const maximizedRect = size && maximizedTarget ? { x: 0, y: 0, w: size.w, h: size.h } : null;
			const allLeaves = collectLeaves(snap.tree, []);
			// Which panes are live vs hibernating (shared with the public
			// service — one computation, no drift).
			const liveSet = computeLiveSet(snap, order, pool, caps, maxLive);
			return React.createElement("div", {
				className: "dsh-split-root" + (prefsSnap.showTitleBar ? "" : " dsh-split-no-titlebar"),
				style: { "--dsh-split-focus": focusVar }
			},
			React.createElement("div", { className: "dsh-split-body", ref: bodyRef },
			allLeaves.map((leaf) => React.createElement(Pane, {
				key: leaf.id,
				leaf: leaf,
				focused: snap.focused === leaf.id,
				ready: readyMap[leaf.id] === true,
				rect: maximizedRect && snap.maximized === leaf.id ? maximizedRect : rectById[leaf.id] ?? null,
				hidden: maximizedTarget !== null && snap.maximized !== leaf.id,
				dormant: !liveSet.has(leaf.id),
				onWake: () => actions.wake(leaf.id),
				base: pool[typeof leaf.origin === "number" && leaf.origin < pool.length ? leaf.origin : 0],
				title: titles[leaf.id] ?? null,
				info: infoMap[leaf.id] ?? null,
				maximized: snap.maximized === leaf.id,
				actions: actions,
				labels: labels
			})),
			home.dividers.map((d) => React.createElement(Divider, {
				key: d.key,
				dir: d.dir,
				rect: d,
				usable: d.usable,
				hidden: maximizedTarget !== null,
				onNudge: (delta) => actions.nudge(d.branchId, d.index, delta)
			}))));
		}

		const CSS = `
.dsh-split-root{position:fixed;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);}
.dsh-split-body{flex:1 1 auto;min-height:0;position:relative;overflow:hidden;}
.dsh-split-pane{position:absolute;display:flex;flex-direction:column;transition:left .18s cubic-bezier(.4,0,.2,1),top .18s cubic-bezier(.4,0,.2,1),width .18s cubic-bezier(.4,0,.2,1),height .18s cubic-bezier(.4,0,.2,1),opacity .16s ease;}
.dsh-split-pane-hidden{opacity:0;pointer-events:none;}
.dsh-split-pane-focused::after{content:"";position:absolute;inset:0;border:2px solid var(--dsh-split-focus,#4D6BFE);pointer-events:none;z-index:12;}
.dsh-split-no-titlebar .dsh-split-titlebar{display:none;}
.dsh-split-titlebar{flex:0 0 34px;display:flex;align-items:center;gap:8px;padding:0 6px 0 10px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-2,#f7f7f9),var(--dsw-alias-bg-layer-1,#f1f1f4));border-bottom:1px solid var(--dsw-alias-border-l1,#e2e2e8);user-select:none;cursor:default;min-width:0;}
.dsh-split-titlebar-focused{background:linear-gradient(180deg,color-mix(in srgb,var(--dsh-split-focus,#4D6BFE) 13%,var(--dsw-alias-bg-layer-2,#f7f7f9)),color-mix(in srgb,var(--dsh-split-focus,#4D6BFE) 8%,var(--dsw-alias-bg-layer-1,#f1f1f4)));border-bottom-color:color-mix(in srgb,var(--dsh-split-focus,#4D6BFE) 35%,var(--dsw-alias-border-l1,#e2e2e8));}
.dsh-split-title{flex:0 1 auto;min-width:88px;max-width:60%;font:500 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.01em;color:var(--dsw-alias-label-secondary,#6b6b72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dsh-split-titlebar-focused .dsh-split-title{color:var(--dsh-split-focus,#4D6BFE);font-weight:600;}
.dsh-split-title-editable{cursor:text;}
.dsh-split-title-editable:hover{color:var(--dsw-alias-label-primary,#3c3c43);}
.dsh-split-titlebar-focused .dsh-split-title-editable:hover{color:var(--dsh-split-focus,#4D6BFE);}
.dsh-split-title-edit{flex:1 1 auto;min-width:0;position:relative;display:inline-flex;align-items:center;}
.dsh-split-title-input{flex:1 1 auto;min-width:0;width:100%;height:22px;padding:0 26px 0 7px;border-radius:6px;border:1px solid var(--dsh-split-focus,#4D6BFE);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#2b2b31);font:500 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none;box-sizing:border-box;}
.dsh-split-tb-btn.dsh-split-title-confirm{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:20px;height:20px;color:var(--dsh-split-focus,#4D6BFE);}
.dsh-split-tb-btn.dsh-split-tb-btn-ok,.dsh-split-tb-btn.dsh-split-tb-btn-ok:hover{color:#2fa36b;background:color-mix(in srgb,#2fa36b 12%,transparent);}
.dsh-split-tb-actions{flex:0 0 auto;margin-left:auto;display:flex;align-items:center;gap:1px;padding-left:6px;border-left:1px solid var(--dsw-alias-border-l1,#e5e5ea);}
.dsh-split-tb-btn{border:0;background:transparent;width:24px;height:24px;border-radius:6px;color:var(--dsw-alias-label-secondary,#6b6b72);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;transition:background .12s ease,color .12s ease,transform .05s ease;}
.dsh-split-tb-btn svg{display:block;}
.dsh-split-tb-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4D6BFE) 12%,transparent);color:var(--dsw-alias-brand-primary,#4D6BFE);}
.dsh-split-tb-btn:active{transform:scale(.9);}
.dsh-split-tb-btn-danger:hover{background:color-mix(in srgb,#e5484d 13%,transparent);color:#e5484d;}
.dsh-split-pane-body{flex:1 1 auto;position:relative;min-height:0;min-width:0;}
.dsh-split-iframe{position:absolute;inset:0;border:0;width:100%;height:100%;display:block;background:var(--dsw-alias-bg-base,#fff);}
.dsh-split-divider{position:absolute;background:transparent;z-index:5;transition:left .18s cubic-bezier(.4,0,.2,1),top .18s cubic-bezier(.4,0,.2,1),width .18s cubic-bezier(.4,0,.2,1),height .18s cubic-bezier(.4,0,.2,1),opacity .16s ease,background .12s;}
.dsh-split-divider-hidden{opacity:0;pointer-events:none;}
.dsh-split-dragging .dsh-split-pane,.dsh-split-dragging .dsh-split-divider{transition:none;}
.dsh-split-divider::before{content:"";position:absolute;pointer-events:none;}
.dsh-split-divider-v{cursor:col-resize;}
.dsh-split-divider-v::before{top:0;bottom:0;left:2px;width:1px;background:var(--dsw-alias-border-l1,#e5e5e5);}
.dsh-split-divider-h{cursor:row-resize;}
.dsh-split-divider-h::before{left:0;right:0;top:2px;height:1px;background:var(--dsw-alias-border-l1,#e5e5e5);}
.dsh-split-divider:hover,.dsh-split-divider:active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4098ff) 18%,transparent);}
.dsh-split-divider:hover::before,.dsh-split-divider:active::before{background:var(--dsw-alias-brand-primary,#4098ff);}
.dsh-split-stale{position:absolute;top:6px;right:6px;z-index:3;font:11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--dsw-alias-label-primary,#333);background:var(--dsw-alias-bg-layer-1,#fafafa);border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:6px;padding:3px 8px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15);}
.dsh-split-stale:hover{border-color:var(--dsw-alias-brand-primary,#4098ff);color:var(--dsw-alias-brand-primary,#4098ff);}
.dsh-split-dormant{position:absolute;inset:0;border:0;display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-1,#fafafa);color:var(--dsw-alias-label-secondary,#888);font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;transition:background .15s,color .15s;}
.dsh-split-dormant:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4D6BFE) 7%,var(--dsw-alias-bg-layer-1,#fafafa));color:var(--dsw-alias-brand-primary,#4D6BFE);}
.dsh-split-dormant-icon{font-size:22px;line-height:1;}
.dsh-split-veil{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base,#fff);z-index:2;}
.dsh-split-veil-hint{font-size:12px;color:var(--dsw-alias-text-l3,#999);user-select:none;}
.dsh-split-spinner{width:22px;height:22px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2,#ddd);border-top-color:var(--dsw-alias-brand-primary,#4098ff);animation:dsh-split-spin .9s linear infinite;}
@keyframes dsh-split-spin{to{transform:rotate(360deg)}}
`;

		function applyTop(ctx) {
			const layout = runtime.createSnapshotStore(defaultLayout(), { persist: { name: LAYOUT_KEY } });
			// User preferences — the top window is the source of truth (it draws
			// everything the prefs control). The store rehydrates from
			// localStorage; normalize immediately so a partial/corrupt shape from
			// an older version can never reach the renderer or the key handler.
			const prefs = runtime.createSnapshotStore(normalizePrefs({}), { persist: { name: PREFS_KEY } });
			prefs.set(normalizePrefs(prefs.getSnapshot()));
			// Every pane WindowProxy ever heard from (any message registers it)
			// receives prefs broadcasts; dead frames no-op inside the try/catch.
			// Entries accumulate across pane reload cycles — cheap, and a stale
			// WindowProxy just swallows its postMessage.
			const panePeers = new Map();
			// Pane address book for the public service's top→pane control
			// messages (open-session / reload): leafId -> {source, origin},
			// refreshed by every well-formed pane message the bus receives.
			const paneWindows = new Map();
			const postToPane = (leafId, data) => {
				const win = paneWindows.get(leafId);
				if (!win) return false;
				try {
					win.source.postMessage(Object.assign({ type: MSG_TYPE }, data), win.origin);
					return true;
				} catch {
					// pane went away mid-flight — the layout-side update stands
					return false;
				}
			};
			prefs.subscribe(() => {
				const snap = prefs.getSnapshot();
				for (const peer of panePeers) {
					try {
						peer[0].postMessage({ type: MSG_TYPE, kind: "prefs-push", prefs: snap }, peer[1]);
					} catch {
						// pane is gone — nothing to sync
					}
				}
			});
			// Settings rows registered at the top talk straight to this store
			// (the top's settings modal is unreachable today — no AppFrame — but
			// keep the path honest in case the root shadow ever changes).
			applySettings(ctx, {
				getPrefs: () => prefs.getSnapshot(),
				subscribe: (fn) => prefs.subscribe(fn),
				savePrefs: (patch) => {
					const next = patchPrefs(prefs.getSnapshot(), patch);
					if (next) prefs.set(next);
				}
			});
			const panesReady = runtime.createSnapshotStore({});
			// Origin pool: panes alternate between the two loopback origins so
			// more clients fit inside the browser's per-origin budget.
			const pool = originPool();
			const caps = pool.length > 1 ? ORIGIN_CAPS_MULTI : ORIGIN_CAPS_SINGLE;
			const maxLive = pool.length > 1 ? MAX_LIVE_PANES_MULTI : MAX_LIVE_PANES_SINGLE;
			const allowedOrigins = new Set(pool);
			// Per-pane session titles reported by the pane agents (transient UI
			// state — never persisted with the layout).
			const paneTitles = runtime.createSnapshotStore({});
			// Per-pane session facts reported alongside the title: blank (empty-log
			// sessions show the folder name and are not renamable) and realTitle
			// (the durable title that seeds the rename editor).
			const paneInfo = runtime.createSnapshotStore({});
			// leafId -> {until, title}. While set, inbound pane title reports are
			// ignored so a stale in-flight report cannot overwrite a rename the top
			// window just applied; a report matching the rename (or the deadline)
			// lifts the suppression.
			const titleSuppress = new Map();
			// Focus-recency order for the LRU live set (most recent last).
			const liveOrder = runtime.createSnapshotStore([]);
			const touchLive = (leafId) => liveOrder.update((d) => {
				const i = d.indexOf(leafId);
				if (i >= 0) d.splice(i, 1);
				d.push(leafId);
			});
			/** Transfer the browser focus to a pane's iframe (DOM lookup). Only
			 * for layout actions the top window itself initiates — never for user
			 * clicks, which the browser focuses naturally. */
			const focusPane = (leafId) => {
				if (!leafId) return;
				const frame = document.querySelector('.dsh-split-pane[data-leaf="' + leafId + '"] iframe');
				if (!frame) return;
				try {
					frame.focus();
					if (frame.contentWindow) frame.contentWindow.focus();
				} catch {
					// focus is best-effort
				}
			};
			const actions = {
				split: (leafId, dir) => {
					// The new pane gets a FRESH session in the split pane's workspace
					// (or cwd): resolve the source's binding from the live list.
					const snapNow = layout.getSnapshot();
					const leaf = findNode(snapNow.tree, leafId);
					let inherit = null;
					if (leaf && leaf.kind === "leaf" && leaf.session) {
						const summary = ctx.sessions.list.getSnapshot().byId[leaf.session];
						if (summary && summary.cwd) inherit = { cwd: summary.cwd };
						const workspaces = ctx.get("workspaces");
						if (workspaces) {
							try {
								const items = workspaces.list.getSnapshot().items;
								const ws = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(leaf.session));
								if (ws && ws.workspaceId) inherit = { workspace: ws.workspaceId };
							} catch {
								// cwd inheritance is the fallback anyway
							}
						}
					}
					layout.update((d) => {
						splitLeaf(d, leafId, dir, inherit);
						// Give the new pane the least-loaded origin so the live
						// clients spread across the pool's per-origin budgets.
						const newLeaf = findNode(d.tree, d.focused);
						if (newLeaf && newLeaf.kind === "leaf") newLeaf.origin = pickOrigin(d, pool, caps);
					});
					touchLive(layout.getSnapshot().focused);
				},
				close: (leafId) => {
					// The survivor only needs a programmatic focus transfer when
					// the closed pane was the focused one (its iframe just went
					// away, taking the browser focus with it).
					const wasFocused = layout.getSnapshot().focused === leafId;
					layout.update((d) => closeLeaf(d, leafId));
					liveOrder.update((d) => {
						const i = d.indexOf(leafId);
						if (i >= 0) d.splice(i, 1);
					});
					if (wasFocused) focusPane(layout.getSnapshot().focused);
				},
				wake: (leafId) => {
					panesReady.update((d) => {
						d[leafId] = false;
					});
					touchLive(leafId);
					layout.update((d) => {
						d.focused = leafId;
					});
				},
				focus: (leafId) => layout.update((d) => {
					d.focused = leafId;
				}),
				session: (leafId, sessionId) => layout.update((d) => setLeafSession(d, leafId, sessionId)),
				nudge: (branchId, index, delta) => layout.update((d) => nudgeFractions(d, branchId, index, delta)),
				maximize: (leafId) => layout.update((d) => {
					d.maximized = d.maximized === leafId ? null : leafId;
				}),
				// Rename the pane's session from the title bar. The top window runs a
				// full client of its own, so it resolves the session binding directly
				// and issues the rename RPC; the pane re-reports the new title once
				// the backend settles it. Blank sessions (workspace-folder placeholder
				// title) are refused here as well as in the editor UI.
				rename: (leafId, nextTitle) => {
					const snapNow = layout.getSnapshot();
					const leaf = findNode(snapNow.tree, leafId);
					if (!leaf || leaf.kind !== "leaf" || !leaf.session) return;
					const info = paneInfo.getSnapshot()[leafId];
					if (info && info.blank) return;
					let session = null;
					try {
						const binding = ctx.sessions.binding(leaf.session);
						session = binding && binding.session;
					} catch {
						session = null;
					}
					if (!session) return;
					const prevTitle = paneTitles.getSnapshot()[leafId] ?? null;
					paneTitles.update((d) => {
						d[leafId] = nextTitle;
					});
					titleSuppress.set(leafId, { until: Date.now() + 5000, title: nextTitle });
					Promise.resolve(session.rename(nextTitle)).then((result) => {
						if (!result || result.ok !== true) {
							titleSuppress.delete(leafId);
							paneTitles.update((d) => {
								d[leafId] = prevTitle;
							});
						}
					}).catch(() => {
						titleSuppress.delete(leafId);
						paneTitles.update((d) => {
							d[leafId] = prevTitle;
						});
					});
				}
			};
			// ── Public service ────────────────────────────────────────────────
			// Other plugins reach this through `inject: ["dsh-split-view"]` or
			// `ctx.get("dsh-split-view")`. It is provided ONLY in the top window
			// (panes run their own cordis trees), and shaped like this:
			//
			// - Pane addressing is one optional id everywhere: omitted/null
			//   targets the focused pane; unknown ids throw. Payload verbs take
			//   the target through `{pane}`; target-only verbs take the paneId
			//   positionally.
			// - Session verbs resolve the pane's session and execute it in the
			//   top window's own client (sessions.binding → SessionFace). The
			//   session is backend-hosted — the pane is just its display — so
			//   the pane picks the turn up through the host stream, dormant
			//   panes included. Only "which session a pane shows" (open /
			//   newSession / reload) crosses the postMessage boundary.
			// - Mutators are async, queries are sync snapshots, subscribe()
			//   streams the merged pane state, and failures throw
			//   Error("dsh-split-view: …").
			const fail = (message) => {
				throw new Error("dsh-split-view: " + message);
			};
			/** Resolve an optional pane target: absent → focused pane; explicit
			 * ids must name a leaf and are validated loud. */
			const resolvePane = (paneId) => {
				const snap = layout.getSnapshot();
				const id = paneId === void 0 || paneId === null ? snap.focused : paneId;
				const node = typeof id === "string" && id.length > 0 ? findNode(snap.tree, id) : null;
				if (!node || node.kind !== "leaf") fail("no such pane: " + String(id));
				return id;
			};
			const paneOfOptions = (options) => (options && typeof options === "object" ? options.pane : void 0);
			/** The session the pane currently shows (its last report), or a loud
			 * error when the pane has none yet. */
			const paneSession = (leafId) => {
				const leaf = findNode(layout.getSnapshot().tree, leafId);
				const sid = leaf && typeof leaf.session === "string" && leaf.session.length > 0 ? leaf.session : null;
				if (sid === null) fail("the pane has no session yet (it may still be booting — pass prompt to split(), or retry once the pane reports its session)");
				return sid;
			};
			const bindSession = (sessionId) => {
				let binding = null;
				try {
					binding = ctx.sessions.binding(sessionId);
				} catch {
					binding = null;
				}
				if (!binding || !binding.session) fail("cannot bind session " + sessionId);
				return binding.session;
			};
			const bindPaneSession = (leafId) => {
				const sid = paneSession(leafId);
				return { sid, session: bindSession(sid) };
			};
			const liveSetOf = () => computeLiveSet(layout.getSnapshot(), liveOrder.getSnapshot(), pool, caps, maxLive);
			/** Public pane descriptors: one entry per leaf, render-state included. */
			const describePanes = () => {
				const snap = layout.getSnapshot();
				const live = computeLiveSet(snap, liveOrder.getSnapshot(), pool, caps, maxLive);
				const titles = paneTitles.getSnapshot();
				const readyMap = panesReady.getSnapshot();
				return collectLeaves(snap.tree, []).map((leaf) => ({
					id: leaf.id,
					session: typeof leaf.session === "string" ? leaf.session : null,
					title: titles[leaf.id] ?? null,
					focused: snap.focused === leaf.id,
					maximized: snap.maximized === leaf.id,
					ready: readyMap[leaf.id] === true,
					dormant: !live.has(leaf.id)
				}));
			};
			const assertRpc = (result, what) => {
				if (result && result.ok === false) {
					const e = result.error;
					fail(what + " failed: " + (e ? (e.message || e.code) : "unknown"));
				}
				return result;
			};
			/** Run the mode/model/title/prompt configuration pass on an already
			 * created session (the fixed order split() has always used).
			 * `strict` decides whether an unresolvable binding throws or is
			 * skipped — split() keeps its historic tolerance, newSession() does
			 * not. */
			const configureSession = async (sessionId, opts, strict) => {
				let binding = null;
				try {
					binding = ctx.sessions.binding(sessionId);
				} catch {
					binding = null;
				}
				const session = binding && binding.session;
				if (!session) {
					if (strict) fail("cannot bind session " + sessionId);
					return;
				}
				if (opts.mode !== null) {
					const res = await session.api.agentPresets.select({ sessionId, agentPreset: opts.mode });
					if (res && res.result && res.result.ok === false) {
						const e = res.result.error;
						fail("preset select failed: " + (e ? (e.message || e.code) : "unknown"));
					}
				}
				if (opts.model !== null) {
					const res = await session.api.sessions.selectModel({
						sessionId,
						provider: opts.model.provider,
						model: opts.model.model,
						...(opts.model.reasoningEffort !== void 0 ? { reasoningEffort: opts.model.reasoningEffort } : {})
					});
					if (res && res.result && res.result.ok === false) {
						const e = res.result.error;
						fail("model select failed: " + (e ? (e.message || e.code) : "unknown"));
					}
				}
				if (opts.title !== null) await session.rename(opts.title);
				if (opts.prompt !== null) assertRpc(await session.prompt([{ type: "text", text: opts.prompt }], "queue"), "prompt");
			};
			const createConfiguredSession = async (opts, strict) => {
				const createOpts = opts.workspaceId !== null ? { workspaceId: opts.workspaceId } : opts.cwd !== null ? { cwd: opts.cwd } : {};
				const sessionId = await ctx.sessions.create(createOpts);
				await configureSession(sessionId, opts, strict);
				return sessionId;
			};
			/** Point a pane at a session: update the layout seed (persistence +
			 * dormant-boot truth), then swap the shown session live when the
			 * pane is up, or pull it into the live set when it is hibernating. */
			const repointPane = (leafId, sessionId) => {
				layout.update((d) => {
					const leaf = findNode(d.tree, leafId);
					if (leaf && leaf.kind === "leaf") {
						leaf.session = sessionId;
						delete leaf.workspace;
						delete leaf.cwd;
					}
				});
				if (liveSetOf().has(leafId)) postToPane(leafId, { kind: "open-session", sessionId });
				else touchLive(leafId);
			};
			/**
			 * Split a pane and open the new pane in a fresh session (or pin an
			 * existing one via options.session). Every option is optional and
			 * defaults to a plain new session in the default working directory.
			 * @param {object} [options]
			 * @param {string} [options.pane] pane to split from (defaults to the focused pane)
			 * @param {"right"|"down"} [options.direction="right"]
			 * @param {string} [options.prompt] first user message (sent as turn one)
			 * @param {string} [options.title] session title (renamed after create)
			 * @param {string|{provider:string,model:string,reasoningEffort?:string}} [options.model]
			 * @param {string} [options.workspaceId]
			 * @param {string} [options.cwd]
			 * @param {string} [options.mode] agent-preset id
			 * @param {string} [options.session] pin an EXISTING session into the new pane (skips create/configure)
			 * @returns {Promise<{paneId: string|null, leafId: string|null, sessionId: string|null}>}
			 */
			const splitImpl = async (options) => {
				const opts = normalizeSplitOptions(options);
				const snap = layout.getSnapshot();
				let target;
				if (opts.pane !== null) {
					const anchor = findNode(snap.tree, opts.pane);
					if (!anchor || anchor.kind !== "leaf") fail("no such pane: " + opts.pane);
					target = opts.pane;
				} else {
					target = snap.focused;
				}
				if (!target) fail("no focused pane to split");
				let sessionId = null;
				let seed = null;
				if (opts.session !== null) {
					// Pin an existing session into the new pane (e.g. an
					// agent-teams member child session): no create/configure,
					// the pane seeds straight from the given session id.
					sessionId = opts.session;
					seed = { session: opts.session };
				}
				const wantsCustom = sessionId === null && (opts.workspaceId !== null || opts.cwd !== null || opts.prompt !== null || opts.title !== null || opts.model !== null || opts.mode !== null);
				if (wantsCustom) {
					sessionId = await createConfiguredSession(opts, false);
					seed = { session: sessionId };
				}
				let newLeafId = null;
				layout.update((d) => {
					splitLeaf(d, target, opts.direction, seed);
					const newLeaf = findNode(d.tree, d.focused);
					if (newLeaf && newLeaf.kind === "leaf") {
						newLeaf.origin = pickOrigin(d, pool, caps);
						newLeafId = newLeaf.id;
					}
				});
				touchLive(layout.getSnapshot().focused);
				// `leafId` keeps the pre-rename field for existing callers.
				return { paneId: newLeafId, leafId: newLeafId, sessionId };
			};
			const api = {
				/** Service-surface generation: feature-detect new members with this. */
				version: 2,

				// ── Introspection (sync snapshots; tolerant — unknown ids → null) ──
				/** Every pane, tree order: {id, session, title, focused, maximized, ready, dormant}. */
				panes: () => describePanes(),
				/** One pane's descriptor (focused pane when omitted), or null. */
				pane: (paneId) => {
					const snap = layout.getSnapshot();
					const id = paneId === void 0 || paneId === null ? snap.focused : paneId;
					if (typeof id !== "string" || !findNode(snap.tree, id)) return null;
					return describePanes().find((p) => p.id === id) ?? null;
				},
				/** The focused pane id, or null. */
				focused: () => layout.getSnapshot().focused ?? null,
				/** Deep copy of the raw layout state {tree, focused, maximized} —
				 * the input shape applyLayout() accepts. */
				layout: () => JSON.parse(JSON.stringify(layout.getSnapshot())),

				// ── Pane lifecycle (paneId optional → focused pane) ──
				split: splitImpl,
				/** Close a pane; the adjacent sibling inherits the space and focus. */
				close: async (paneId) => {
					const id = resolvePane(paneId);
					actions.close(id);
					return { closed: id, focused: layout.getSnapshot().focused ?? null };
				},
				/** Focus a pane (layout focus + browser focus transfer). */
				focus: async (paneId) => {
					const id = resolvePane(paneId);
					actions.focus(id);
					touchLive(id);
					focusPane(id);
					return { focused: id };
				},
				/** Maximize a pane: maximize(paneId?, true/false) sets explicitly,
				 * maximize(paneId?) toggles. */
				maximize: async (paneId, on) => {
					const id = resolvePane(paneId);
					layout.update((d) => {
						if (on === true) d.maximized = id;
						else if (on === false) d.maximized = null;
						else d.maximized = d.maximized === id ? null : id;
					});
					return { maximized: layout.getSnapshot().maximized ?? null };
				},
				/** Restore from maximize. */
				restore: async () => {
					layout.update((d) => {
						d.maximized = null;
					});
					return { maximized: null };
				},
				/** Wake a hibernating pane (boots its iframe back into the live set). */
				wake: async (paneId) => {
					const id = resolvePane(paneId);
					actions.wake(id);
					return { paneId: id };
				},
				/** Reload a pane's client (live panes reload in place; hibernating
				 * ones wake, which boots them). */
				reload: async (paneId) => {
					const id = resolvePane(paneId);
					if (!liveSetOf().has(id) || !postToPane(id, { kind: "reload" })) actions.wake(id);
					return { paneId: id };
				},
				/** Replace the whole layout tree (validated): the escape hatch
				 * for moves, resizes and rearrangements the verb API does not
				 * cover. Reused leaf ids keep their panes (iframes survive);
				 * new ids boot fresh panes. See layout() for the shape. */
				applyLayout: async (tree) => {
					const norm = normalizeLayoutTree(tree);
					layout.update((d) => {
						d.tree = norm;
						d.focused = firstLeafId(norm);
						d.maximized = null;
						for (const leaf of collectLeaves(d.tree, [])) {
							if (!(typeof leaf.origin === "number" && leaf.origin < pool.length)) leaf.origin = pickOrigin(d, pool, caps);
						}
					});
					return { panes: describePanes() };
				},

				// ── Pane × session ──
				/**
				 * Show an existing session in a pane — live swap when the pane is
				 * up, boot seed when it is hibernating.
				 * @param {string} sessionId
				 * @param {{pane?: string}} [options]
				 */
				open: async (sessionId, options) => {
					if (typeof sessionId !== "string" || sessionId.length === 0) fail("open needs a session id");
					const id = resolvePane(paneOfOptions(options));
					const listSnap = ctx.sessions.list.getSnapshot();
					// Skip validation while the list baseline is in flight: the
					// pane agent gates its seed the same way and falls back
					// gracefully.
					if (listSnap.phase !== "pending" && !listSnap.byId[sessionId]) fail("unknown session: " + sessionId);
					repointPane(id, sessionId);
					return { paneId: id, sessionId };
				},
				/**
				 * Create a fresh session and show it in a pane (replaces the
				 * pane's current session). Same session options as split().
				 * @param {{pane?: string, workspaceId?: string, cwd?: string, title?: string, model?: string|object, mode?: string, prompt?: string}} [options]
				 */
				newSession: async (options) => {
					const o = options && typeof options === "object" ? options : {};
					const id = resolvePane(o.pane);
					const opts = normalizeSplitOptions(o);
					const sessionId = await createConfiguredSession(opts, true);
					repointPane(id, sessionId);
					return { paneId: id, sessionId };
				},
				/**
				 * Send a user message to the session a pane shows. Executes in
				 * the top window's client — the pane renders the turn through
				 * the host stream, whether live or hibernating.
				 * @param {string|Array<{type: string, text?: string}>} content text or prompt content parts
				 * @param {{pane?: string, mode?: "queue"|"steer"}} [options] queue (default) appends a turn; steer interrupts the running one
				 */
				send: async (content, options) => {
					const id = resolvePane(paneOfOptions(options));
					const blocks = typeof content === "string"
						? (content.length > 0 ? [{ type: "text", text: content }] : null)
						: (Array.isArray(content) && content.length > 0 ? content : null);
					if (blocks === null) fail("send needs a non-empty string or content-part array");
					const mode = options && options.mode === "steer" ? "steer" : "queue";
					const { sid, session } = bindPaneSession(id);
					assertRpc(await session.prompt(blocks, mode), "prompt");
					return { paneId: id, sessionId: sid };
				},
				/** Rename the session a pane shows (blank sessions are refused,
				 * like the title-bar editor). */
				rename: async (title, options) => {
					const id = resolvePane(paneOfOptions(options));
					const next = typeof title === "string" ? title.trim() : "";
					if (next.length === 0) fail("rename needs a non-empty title");
					const sid = paneSession(id);
					const info = paneInfo.getSnapshot()[id];
					if (info && info.blank) fail("blank sessions are not renamable (their title is the workspace folder name)");
					bindSession(sid);
					actions.rename(id, next);
					return { paneId: id, sessionId: sid, title: next };
				},
				/** Change the model and/or agent preset of the session a pane
				 * shows. @param {{model?: string|object, mode?: string}} patch */
				configure: async (patch, options) => {
					const id = resolvePane(paneOfOptions(options));
					const p = patch && typeof patch === "object" ? patch : {};
					const mode = str(p.mode);
					const model = normalizeModel(p.model);
					if (mode === null && model === null) fail("configure needs a mode and/or a model");
					const { sid, session } = bindPaneSession(id);
					if (mode !== null) {
						const res = await session.api.agentPresets.select({ sessionId: sid, agentPreset: mode });
						if (res && res.result && res.result.ok === false) {
							const e = res.result.error;
							fail("preset select failed: " + (e ? (e.message || e.code) : "unknown"));
						}
					}
					if (model !== null) {
						const res = await session.api.sessions.selectModel({
							sessionId: sid,
							provider: model.provider,
							model: model.model,
							...(model.reasoningEffort !== void 0 ? { reasoningEffort: model.reasoningEffort } : {})
						});
						if (res && res.result && res.result.ok === false) {
							const e = res.result.error;
							fail("model select failed: " + (e ? (e.message || e.code) : "unknown"));
						}
					}
					return { paneId: id, sessionId: sid };
				},
				/** Cancel the running turn of the session a pane shows. */
				cancel: async (paneId) => {
					const id = resolvePane(paneId);
					const { sid, session } = bindPaneSession(id);
					assertRpc(await session.cancel(), "cancel");
					return { paneId: id, sessionId: sid };
				},

				// ── Observation ──
				/**
				 * Subscribe to pane-state changes (structure, focus, sessions,
				 * titles, ready/dormant). The listener receives the same shape
				 * panes() describes, wrapped as {panes, focused, maximized};
				 * duplicate states are coalesced. Returns the unsubscribe fn.
				 */
				subscribe: (listener) => {
					if (typeof listener !== "function") fail("subscribe needs a listener function");
					let last = null;
					const emit = () => {
						const snap = layout.getSnapshot();
						const state = {
							panes: describePanes(),
							focused: snap.focused ?? null,
							maximized: snap.maximized ?? null
						};
						const key = JSON.stringify(state);
						if (key === last) return;
						last = key;
						try {
							listener(state);
						} catch {
							// listener errors must not break the store bus
						}
					};
					const offs = [
						layout.subscribe(emit),
						panesReady.subscribe(emit),
						liveOrder.subscribe(emit),
						paneTitles.subscribe(emit)
					];
					return () => {
						for (const off of offs) {
							try {
								off();
							} catch {
								// already disposed
							}
						}
					};
				}
			};
			ctx.provide("dsh-split-view", api);
			// Dev hook: with localStorage `dsh-split:debug` set, mirror the
			// service on window.__dshSplitView so the API can be exercised from
			// devtools. Off by default — other plugins keep using ctx.get/inject.
			try {
				if (window.localStorage.getItem("dsh-split:debug")) window.__dshSplitView = api;
			} catch {
				// storage unavailable — the hook stays off
			}
			// TEMP(agent-team-demo): auto-pin agent-teams member sessions into panes
			// on top-level boot. Remove once the dedicated dsh-agent-team plugin lands.
			(() => {
				if (window.__dshMemberDemoScheduled) return;
				window.__dshMemberDemoScheduled = true;
				const KEY = "dsh-split:memberPanes";
				const TRACE = "dsh-split:demoTrace";
				const trace = (m) => { try { localStorage.setItem(TRACE, (localStorage.getItem(TRACE) || "").slice(-400) + "\n" + new Date().toISOString().slice(11,19) + " " + m); } catch (e) {} };
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const run = async () => {
					try {
						trace("start iframes=" + document.querySelectorAll("iframe").length);
						const res = await fetch("/plugins/dsh-agent-teams/state", { cache: "no-store" });
						if (!res.ok) { trace("state route not ok: " + res.status); return; }
						const data = await res.json();
						const teams = (data && data.teams) || [];
						trace("fetched teams=" + teams.length);
						const pinned = new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
						let changed = false;
						for (const team of teams) {
							for (const m of team.members || []) {
								if (!m || !m.id || pinned.has(m.id)) continue;
								trace("split before " + m.id.slice(0, 8));
								try {
									const out = await splitImpl({ session: m.id, direction: "right" });
									trace("split after leaf=" + (out && out.leafId));
									if (out && out.leafId) { pinned.add(m.id); changed = true; await sleep(1200); }
								} catch (e) { trace("split err: " + (e && e.message)); }
							}
						}
						if (changed) localStorage.setItem(KEY, JSON.stringify([...pinned]));
						trace("done iframes=" + document.querySelectorAll("iframe").length);
					} catch (e) { trace("outer err: " + (e && e.message)); }
				};
				// TEMP(agent-team-demo): 6s delay lets boot/layout restore settle first.
				setTimeout(run, 6000);
			})();
			const handleCommand = (cmd, paneId) => {
				const snap = layout.getSnapshot();
				const target = paneId && findNode(snap.tree, paneId) ? paneId : snap.focused;
				if (!target) return;
				if (cmd === "split-right") actions.split(target, "h");
				else if (cmd === "split-down") actions.split(target, "v");
				else if (cmd === "close") actions.close(target);
				else if (cmd === "maximize") actions.maximize(target);
			};
			ctx.effect(() => {
				const onMessage = (event) => {
					// Panes may live on the alternate loopback origin (origin pool).
					if (!allowedOrigins.has(event.origin)) return;
					const data = event.data;
					if (!data || data.type !== MSG_TYPE || typeof data.pane !== "string") return;
					// Any well-formed pane message registers the sender as a prefs
					// broadcast peer (window-level, cross-origin safe).
					panePeers.set(event.source, event.origin);
					// …and refreshes the pane address book (top→pane control channel).
					paneWindows.set(data.pane, { source: event.source, origin: event.origin });
					if (data.kind === "session") {
						actions.session(data.pane, typeof data.sessionId === "string" ? data.sessionId : null);
						paneInfo.update((d) => {
							d[data.pane] = {
								blank: data.blank === true,
								realTitle: typeof data.realTitle === "string" ? data.realTitle : null
							};
						});
						// A rename just applied at the top suppresses stale title reports
						// until the pane catches up (its report matches the new title)
						// or the suppression window expires.
						const sup = titleSuppress.get(data.pane);
						if (sup !== void 0) {
							if ((typeof data.title === "string" && data.title === sup.title) || Date.now() >= sup.until) titleSuppress.delete(data.pane);
						}
						if (!titleSuppress.has(data.pane)) {
							paneTitles.update((d) => {
								d[data.pane] = typeof data.title === "string" && data.title.length > 0 ? data.title : null;
							});
						}
						panesReady.update((d) => {
							d[data.pane] = true;
						});
						touchLive(data.pane);
					} else if (data.kind === "focus") {
						actions.focus(data.pane);
						panesReady.update((d) => {
							d[data.pane] = true;
						});
						touchLive(data.pane);
					} else if (data.kind === "cmd" && typeof data.cmd === "string") {
						handleCommand(data.cmd, data.pane);
					} else if (data.kind === "prefs-pull") {
						// Pane boot asking for the current preferences.
						try {
							event.source.postMessage({ type: MSG_TYPE, kind: "prefs-push", prefs: prefs.getSnapshot() }, event.origin);
						} catch {
							// pane may already be gone
						}
					} else if (data.kind === "prefs-set" && data.patch && typeof data.patch === "object") {
						// Settings edit from a pane's settings modal — validate and
						// merge here (the top is authoritative); the store's
						// subscriber broadcasts the canonical state to every pane.
						const next = patchPrefs(prefs.getSnapshot(), data.patch);
						if (next) prefs.set(next);
					} else if (data.kind === "storage-pull") {
						// Cross-origin pane asking for the top's client-side config
						// snapshot — answer with every non-per-client key.
						try {
							event.source.postMessage({ type: MSG_TYPE, kind: "storage-push", values: collectSyncedStorage() }, event.origin);
						} catch {
							// pane may already be gone
						}
					} else if (data.kind === "storage-set" && typeof data.key === "string") {
						// A cross-origin pane wrote to its localStorage — mirror the
						// write in the top so it survives the next reload.
						if (!shouldSyncKey(data.key)) return;
						try {
							if (data.value === null || data.value === void 0) window.localStorage.removeItem(data.key);
							else window.localStorage.setItem(data.key, String(data.value));
						} catch {
							// storage unavailable — the write cannot persist
						}
					}
				};
				const onKey = (event) => {
					const cmd = commandOfEvent(event, prefs.getSnapshot().shortcuts);
					if (cmd === null) return;
					event.preventDefault();
					handleCommand(cmd, null);
				};
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-split-view");
				style.textContent = CSS;
				document.head.append(style);
				window.addEventListener("message", onMessage);
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("message", onMessage);
					window.removeEventListener("keydown", onKey);
					style.remove();
				};
			}, "split-view: top bus + styles");
			// Shadow the AppFrame root entry (priority 0) — lowest priority renders.
			// The AppFrame subtree (sidebar/conversation/details/shell.overlay) stays
			// registered but unrendered; every pane iframe runs its own full AppFrame.
			reapplyBootSkin(ctx);
			ctx.slots.inject("root", () => ctx.slots.register({
				name: "root",
				priority: -1
			}, () => React.createElement(SplitterRoot, { layout, panesReady, liveOrder, actions, handleCommand, pool, caps, maxLive, paneTitles, paneInfo, prefs })));
		}
		//#endregion

		/** Cordis fiber inject — slots for the root shadow and the settings
		 * section, sessions for pane seeding, theme for the cross-origin settings
		 * re-apply, locale for the settings rows' dictionaries. */
		const inject = ["slots", "sessions", "theme", "locale"];
		/**
		 * Client plugin body: exactly one of the two modes runs per page load,
		 * selected by the ?dshPane parameter.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			if (PANE_ID) applyPane(ctx);
			else applyTop(ctx);
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
