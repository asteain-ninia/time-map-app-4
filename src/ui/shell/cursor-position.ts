// UI layer (U20 / shell): the live cursor world position behind the status bar.
//
// FR-111 のステータスバーに「地図上のマウス位置の経緯度」を LIVE 表示するための、
// React の外に置いた極小 pub/sub。MapSizeStore (map-resize.ts) と同じ設計理由:
// pointermove は 60Hz で来るので、位置を React state に置くとシェル全体が毎フレーム
// 再レンダーする (技術方針 2.3 / NFR 5.1)。ここに値を置き、購読するのは読み出し
// コンポーネント 1 個だけにすることで、再レンダーはその 1 ノードに閉じる。
//
// 整形は行わない: 数値→文字列は測量モード (U37 / FR-16) の
// `formatLatDecimal` / `formatLonDecimal` に委譲する。この unit は新しい座標整形を
// 一切定義しない (単一真実源 — 経緯度の表記規約は coords-format.ts だけが持つ)。

import type { WorldCoordinate } from '../../domain/coordinate';
import { formatLatDecimal, formatLonDecimal } from '../../domain/survey/coords-format';
import { clampLat } from '../../render';

/**
 * Throttle interval for the status-bar readout (ms). ~20 updates/s: still reads as a
 * LIVE readout to the eye, while capping the React work a 60Hz pointermove can cause
 * to a third of the input rate (per-frame 負荷を増やさない). The throttle is TRAILING,
 * so the final position of a burst always lands (the readout never freezes mid-move).
 */
export const CURSOR_READOUT_INTERVAL_MS = 50;

/** The cursor's world position, or `null` when the cursor is not over the map. */
export type CursorWorldPosition = WorldCoordinate | null;

export type CursorPositionListener = (position: CursorWorldPosition) => void;

/**
 * A tiny pub/sub for the cursor's world position. The map input path pushes; the
 * status-bar readout subscribes. Notifies ONLY on an actual change and keeps the
 * snapshot IDENTITY stable while unchanged, so it is safe to feed straight into
 * `useSyncExternalStore` (an unstable snapshot would loop React forever).
 */
export class CursorPositionStore {
  private position: CursorWorldPosition = null;
  private readonly listeners = new Set<CursorPositionListener>();

  get(): CursorWorldPosition {
    return this.position;
  }

  /** Set the cursor world position; notifies only when lon/lat actually changed. */
  set(position: WorldCoordinate): void {
    const current = this.position;
    if (current !== null && current.lon === position.lon && current.lat === position.lat) {
      return;
    }
    this.position = { lon: position.lon, lat: position.lat };
    this.emit();
  }

  /** Cursor left the map: back to「位置不明」. Notifies only when it was known. */
  clear(): void {
    if (this.position === null) return;
    this.position = null;
    this.emit();
  }

  /** Subscribe. Returns unsubscribe. (No immediate call — see `get` for the snapshot.) */
  subscribe(listener: CursorPositionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.position);
  }
}

/**
 * The status-bar text for a cursor position, or `null` when there is nothing to show
 * (地図外 = 非表示, and a 病的 non-finite coordinate is likewise not shown rather than
 * rendered as a broken label, spec §4.6 / FR-117).
 *
 * 表示は 十進 (FR-16 の二形式のうち、ステータスバーの一行に収まる方) で、緯度→経度の
 * 並びは測量パネルと同じ。文字列そのものは coords-format の関数が作る — ここは
 * 「出すか出さないか」と連結だけを決める (新しい整形関数を作らない)。
 *
 * OUT-OF-WORLD LATITUDE も非表示 (review fix): longitude is periodic and is folded by
 * `formatLonDecimal`, but latitude is NOT (FR-05) — and `screenToWorld` does not clamp
 * it, so screen rows ABOVE the north pole / BELOW the south pole unproject to |lat| > 90
 * (pan to centerLat 89 at 100 px/deg and the top of a 600px map is lat 92). 北緯 92° is
 * not a place; an always-on readout must not assert one. The world bound itself is the
 * render layer's single {@link clampLat} boundary — we only decide 出す/出さない with it
 * (clamping instead would paint a whole off-world band as「北緯 90.000000°」, equally
 * false). The poles themselves (±90) ARE the world and stay shown.
 */
export function cursorCoordinateText(position: CursorWorldPosition): string | null {
  if (position === null) return null;
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon)) return null;
  if (clampLat(position.lat) !== position.lat) return null;
  return `${formatLatDecimal(position.lat)} ${formatLonDecimal(position.lon)}`;
}
