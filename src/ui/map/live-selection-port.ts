// HB-15 — the LIVE {@link SelectionPort}: a map click → the U22 selection truth.
//
// WHY THIS FILE EXISTS (教訓 5.7 / 5.29): the composition root drove the map pointer
// dispatcher with NOOP_SELECTION_PORT, so an edit-mode click never reached the U22
// single selection truth (store.selection). This adapter is that wire.
//
// SINGLE TRUTH SOURCE (教訓 5.29 — do NOT re-implement selection rules): the adapter
// drives U22's OWN pure {@link reduceSelection} with a PointerDown(hit) → PointerUp
// sequence and writes the resulting {@link SelectionState} back through the store's
// {@link restoreSelection}. So the exact U22 semantics apply unchanged:
//   - a FEATURE BODY click → that feature becomes the sole active feature AND any
//     vertex selection is cleared (reducer onPointerDown body branch — Codex P1: the
//     earlier setActiveFeature-only path wrongly LEFT a stale vertex set);
//   - a VERTEX click → plain = replace the set with it, Shift = toggle it (FR-80, the
//     modifiers are now honoured — Codex: the earlier path dropped Shift);
//   - an EMPTY-space click → clears the whole selection (active + vertex set);
//   - an EMPTY-space DRAG → a rubber-band RECTANGLE select of the vertices inside it
//     (FR-80 must, 教訓 5.7 配線欠落): plain replaces the set, Shift adds to it. The
//     vertices inside are resolved through an injected {@link RectangleResolver} (the
//     live drawn-vertex lookup), so the reducer never reaches into geometry itself.
// The press-time WORLD point is captured so the release finalizes against the same
// coordinate the press recorded. A NON-empty press (vertex / feature-body / edge handle)
// stays CLICK-ONLY here (wasDrag ⇒ no selection change): a drag of such a handle is a
// U24 edit-session gesture owned by the edit-session adapter, so this port must not
// double-drive it — only an EMPTY-space press ever enters the rubber-band path.

import {
  HIT_KIND,
  SELECTION_EVENT,
  reduceSelection,
  type RectangleResolver,
  type SelectionState,
} from '../../domain/selection';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { HitResult } from '../../domain/selection';
import type { ScreenPoint } from '../../render';
import type { PointerModifiers, SelectionPort } from './ports';

/**
 * The store seam this adapter needs: read the current U22 selection truth and write
 * a new one (both already exist on the session store). Kept as a structural slice so
 * the adapter is unit-testable with a fake and never depends on the whole store shape
 * (教訓 5.34 契約越し). The adapter NEVER mutates selection any other way.
 */
export interface SelectionStoreSeam {
  /** The current U22 selection truth (store.getState().selection). */
  getSelection(): SelectionState;
  /** Write a whole U22 selection value back (store.restoreSelection). */
  restoreSelection(selection: SelectionState): void;
}

/** Project a surface screen point to a world coordinate (the renderer inverse). */
export type ScreenToWorld = (point: ScreenPoint) => WorldCoordinate;

/**
 * Build a {@link SelectionPort} backed by U22's reducer over the live store. The
 * dispatcher calls start → (move…) → end; the release drives {@link reduceSelection}
 * and persists the result:
 *   - a NON-empty press (vertex / body / edge) is CLICK-ONLY — a drag selects nothing
 *     (that gesture is owned by the pan / U24 edit-session path);
 *   - an EMPTY-space press drives PointerDown(Empty) → PointerUp(at): a click (at ===
 *     origin) clears the selection, a DRAG (at = the release world point) rubber-band
 *     RECTANGLE-selects via the injected {@link RectangleResolver} (FR-80, plain =
 *     replace / Shift = add).
 *
 * `rectangle` is the live drawn-vertex lookup U22 asks for the vertices inside a
 * rubber-band; when omitted the port uses no resolver (an empty-drag then resolves to
 * "nothing inside" — a plain drag clears, a shift drag leaves the set), which keeps the
 * click-only unit tests / callers that never rubber-band unchanged.
 */
export function createLiveSelectionPort(
  seam: SelectionStoreSeam,
  screenToWorld: ScreenToWorld,
  rectangle?: RectangleResolver,
): SelectionPort {
  // The press captured on the most recent press (null = idle / already applied).
  let pressed: {
    readonly hit: HitResult;
    readonly at: WorldCoordinate;
    readonly shift: boolean;
  } | null = null;

  return {
    start(hit: HitResult, point: ScreenPoint, modifiers: PointerModifiers): void {
      pressed = { hit, at: screenToWorld(point), shift: modifiers.shift };
    },
    move(): void {
      // No live preview here (drag editing is owned by the edit-session adapter);
      // the selection is finalized on the click release via the U22 reducer.
    },
    end(point: ScreenPoint, wasDrag: boolean): void {
      const press = pressed;
      pressed = null;
      if (press === null) return;
      // A NON-empty press (vertex / feature-body / edge handle) is CLICK-ONLY here: a
      // drag of such a handle is a U24 edit-session gesture owned by the edit-session
      // adapter (教訓 5.30 single click/drag verdict), so this port must not double-drive
      // it. Only an EMPTY-space press can rubber-band, so a non-empty drag selects nothing.
      const isEmptyPress = press.hit.kind === HIT_KIND.Empty;
      if (wasDrag && !isEmptyPress) return;
      // The RELEASE world point for the PointerUp `at`. For a rubber-band (empty-space
      // DRAG) it is the drag's opposite corner (the reducer sees origin ≠ at → rectangle);
      // for a click (no drag) it is the SAME press point (origin === at → the body/vertex/
      // empty click rules apply verbatim). Using the press point for a click keeps a
      // sub-threshold jitter from spuriously opening a tiny rubber-band.
      const releaseAt: WorldCoordinate = wasDrag ? screenToWorld(point) : press.at;
      // Drive U22's OWN reducer (単一の真実源, 教訓 5.29): PointerDown(hit) records the
      // press (empty → rectangle draft; vertex/body → click/arm), then PointerUp finalizes.
      const base = seam.getSelection();
      const down = reduceSelection(base, {
        kind: SELECTION_EVENT.PointerDown,
        at: press.at,
        hit: press.hit,
        shiftHeld: press.shift,
      });
      // PointerUp: a rubber-band resolves the vertices inside through the injected
      // resolver (FR-80 range select); a click never reaches the rectangle branch.
      const up = reduceSelection(
        down.state,
        { kind: SELECTION_EVENT.PointerUp, at: releaseAt },
        rectangle === undefined ? {} : { rectangle },
      );
      seam.restoreSelection(up.state);
    },
    cancel(): void {
      // Abandoned gesture: drop the captured press, change nothing (教訓 5.2).
      pressed = null;
    },
  };
}
