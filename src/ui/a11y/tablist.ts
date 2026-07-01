// UI layer (a11y): the ONE shared tablist arrow-key helper (第5次バグハント
// MEDIUM / a11y). The `role="tablist"` groups (Sidebar のセクションタブ / 設定ダイア
// ログの scope タブ) must support arrow-key traversal between tabs per the
// WAI-ARIA tablist pattern (Left/Up = 前, Right/Down = 次, ends wrap). This is the
// single真実源 for that key→index math (教訓 5.13): a component passes its ordered
// tab keys + the active key and gets back the key to activate, or null when the
// pressed key is not an arrow (so the component leaves the event alone).

/**
 * Resolve the tab to move to for an arrow key in a horizontal-or-vertical tablist.
 *
 * `ArrowLeft` / `ArrowUp` step to the previous tab; `ArrowRight` / `ArrowDown` to
 * the next; both WRAP at the ends. Returns the target key, or `null` when `key` is
 * not one of those arrows (the caller then does nothing / lets the event pass).
 */
export function nextTabForArrow<K>(
  order: readonly K[],
  active: K,
  key: string,
): K | null {
  const delta =
    key === 'ArrowLeft' || key === 'ArrowUp'
      ? -1
      : key === 'ArrowRight' || key === 'ArrowDown'
        ? 1
        : 0;
  if (delta === 0) return null;
  const i = order.indexOf(active);
  if (i === -1) return null;
  // Wrap with a positive modulo so -1 maps to the last tab.
  const n = order.length;
  const next = (((i + delta) % n) + n) % n;
  return order[next]!;
}
