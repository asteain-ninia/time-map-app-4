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
//   - an EMPTY-space click → clears the whole selection (active + vertex set).
// The selection is decided on RELEASE for a CLICK only (wasDrag === false); a drag is
// a pan / edit gesture owned elsewhere, so the reducer's release sees origin === at
// (a click) and never a rubber-band/move. The press-time WORLD point is captured so
// the release finalizes against the same coordinate the press recorded.

import {
  SELECTION_EVENT,
  reduceSelection,
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
 * dispatcher calls start → (move…) → end; a CLICK release drives PointerDown(hit) →
 * PointerUp(at) through {@link reduceSelection} and persists the result. A DRAG
 * release selects nothing (it is owned by the pan / edit-session path).
 */
export function createLiveSelectionPort(
  seam: SelectionStoreSeam,
  screenToWorld: ScreenToWorld,
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
    end(_point: ScreenPoint, wasDrag: boolean): void {
      const press = pressed;
      pressed = null;
      if (press === null) return;
      // Only a CLICK selects (教訓 5.30 single click/drag verdict); a drag is a
      // pan / edit gesture and leaves the selection untouched.
      if (wasDrag) return;
      // Drive U22's reducer: PointerDown(hit) then PointerUp at the SAME point (a
      // click, origin === at), so the body/vertex/empty rules apply verbatim
      // (単一の真実源, 教訓 5.29). The rectangle resolver is the empty one — a click
      // never resolves a rubber-band.
      const base = seam.getSelection();
      const down = reduceSelection(base, {
        kind: SELECTION_EVENT.PointerDown,
        at: press.at,
        hit: press.hit,
        shiftHeld: press.shift,
      });
      // PointerUp at the SAME point (a click, origin === at) finalizes via the empty
      // rectangle resolver (the reducer default) — a click never resolves a band.
      const up = reduceSelection(down.state, {
        kind: SELECTION_EVENT.PointerUp,
        at: press.at,
      });
      seam.restoreSelection(up.state);
    },
    cancel(): void {
      // Abandoned gesture: drop the captured press, change nothing (教訓 5.2).
      pressed = null;
    },
  };
}
