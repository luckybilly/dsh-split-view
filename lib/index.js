/**
 * dsh-split-view — host half.
 *
 * The host side is intentionally a no-op loader entry: the whole feature
 * lives in the browser half (`./client`), which DSH's dsh-client-modules
 * picks up through the package's `dsh.client` declaration — the same shape
 * as the shipped ui-* packages.
 *
 * Layout state persists in the browser's localStorage (key `dsh-split:layout`),
 * matching the boundary used by dsh-dream-skin: the Host settings wire only
 * exposes allowlisted namespaces, and per-browser visual/layout preferences
 * are process-local by design.
 */

/** Host loader entry for the browser implementation exported from `./client`. */
export function apply() {}
