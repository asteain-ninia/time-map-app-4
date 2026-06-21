// UI layer (U40 wiring): the LIVE right-click context-menu port (FR-96).
//
// ROOT FIX (bughunt2: FR-96 の右クリックメニューが NO-OP ポートに結線され、実アプリで
// 右クリックしても何も出ない). The U40 dispatcher routes EVERY right-button press to
// the `contextMenu` port (dispatch.ts:「Right button is always a context-menu
// request, never a pan」), but the composition root backed that port with
// {@link NOOP_CONTEXT_MENU_PORT} — `request(){}` — so the right-click 導線 was a
// dead end: the U20 {@link ContextMenu} component + the {@link CommandRegistry}
// path existed and were unit-tested, yet were never reached from real pointer
// input (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない状態を作らない」).
//
// This module is the missing 結線: a concrete {@link ContextMenuPort} that, on a
// right-button press, (1) promotes the hit feature into the LIVE selection through
// the SAME selection-write path a left click uses (so a menu command — e.g. 削除 —
// targets the right-clicked feature, 教訓 5.11), and (2) opens the {@link ContextMenu}
// at the cursor via an injected open-callback bridged to React state. It re-uses the
// EXISTING command-id menu mechanism (registry + permission gate) — it re-implements
// no menu rendering, positioning, or command body (単一真実源, 教訓 5.13 / 5.29).

import { HIT_KIND, type HitResult } from '../../domain/selection';
import type { ContextMenuPort } from './ports';
import type { ScreenPoint } from '../../render';

/**
 * What an open context-menu request carries to the React mount: where to anchor
 * the menu (VIEWPORT/client px — the {@link ContextMenu} uses `position: fixed`)
 * and the hit-test result that produced it (so the menu can target the hit
 * feature). The hit is already resolved by the dispatcher's live hit-tester
 * (single truth source — what is drawn == what is hit, 教訓 5.29).
 */
export interface ContextMenuRequest {
  /** Anchor in viewport/client pixels (the menu renders position:fixed). */
  readonly clientX: number;
  readonly clientY: number;
  /** What the right-click hit (feature body / vertex / empty). */
  readonly hit: HitResult;
}

/**
 * The dependencies the live context-menu port needs from the composition root.
 * All are read live per request (never a stale capture, 教訓 5.6).
 */
export interface LiveContextMenuPortDeps {
  /**
   * Convert a SURFACE-relative screen point (the dispatcher works in surface
   * space) back to VIEWPORT/client pixels for the position:fixed menu. Backed by
   * the SAME element rect the dispatcher's `toSurface` uses, so the menu opens
   * exactly under the cursor (no second transform, 教訓 5.29).
   */
  readonly surfaceToClient: (point: ScreenPoint) => { x: number; y: number };
  /**
   * Promote the right-clicked feature into the live selection so a chosen menu
   * command acts on it (教訓 5.11 — 右クリック対象がコマンドの対象になる). A
   * feature-body / vertex hit selects that feature; an empty hit leaves the
   * current selection untouched (a right-click on empty space offers only the
   * view-axis items, never silently clearing what was selected).
   */
  readonly promoteHit: (hit: HitResult) => void;
  /**
   * Open the menu in React (the bridge to component state). Called with the
   * resolved client anchor + hit; a no-op until the mount wires it.
   */
  readonly open: (request: ContextMenuRequest) => void;
}

/**
 * Build the LIVE {@link ContextMenuPort} the dispatcher requests on a right-button
 * press. The dispatcher hands a SURFACE point + hit; the port converts the point to
 * client space, promotes the hit feature into selection, then opens the menu. It
 * holds NO menu state — that lives in the React mount (technique 2.3: the live input
 * path stays off React re-render until an actual menu opens).
 */
export function createLiveContextMenuPort(
  deps: LiveContextMenuPortDeps,
): ContextMenuPort {
  return {
    request(point: ScreenPoint, hit: HitResult): void {
      // Promote the hit feature FIRST so the menu's command target is the
      // right-clicked feature (削除 etc.), exactly as a left click would select it
      // (単一の選択書き込み経路, 教訓 5.11). Empty space keeps the current selection.
      if (hit.kind !== HIT_KIND.Empty) {
        deps.promoteHit(hit);
      }
      const { x, y } = deps.surfaceToClient(point);
      deps.open({ clientX: x, clientY: y, hit });
    },
  };
}
