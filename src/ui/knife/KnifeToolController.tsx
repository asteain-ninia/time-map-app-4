// U26 — the knife-tool INTEGRATION component (FR-90 / FR-92 / FR-93 / FR-94,
// 教訓 5.2 / 5.7 / 5.8 / 5.11 / 5.14).
//
// This is the layer-crossing wiring the spec's 実装方針 demands: the pure
// {@link useKnifeTool} hook + the pure {@link buildKnifePrimitives} render-batch
// builder are USELESS until the UI calls them. This component is that call site —
// the消費する ui コンシューマ the integration lens flagged as missing. It binds to the
// single-truth session store (U16), and:
//   - starts / discards a knife session from the toolbar tool + mode (教訓 5.2 全
//     経路): selecting `edit.knife` in 編集モード starts; leaving the tool / mode
//     funnels through `resetForSwitch` so no一時状態 leaks (受け入れ基準 8);
//   - turns map-input pointer events into target selection (SelectingTarget) or cut
//     points (DrawingCut), with the固定円ヒット優先 designed alongside the visual
//     overlay (教訓 5.14): a click while drawing first asks "inside the固定円?" and
//     routes to閉線確定 vs頂点追加 accordingly;
//   - wires every COMPLETE trigger (confirmCut / confirmInheritor / save) to the
//     hook (教訓 5.7); 確定 assembles the proposal and runs U13 (FR-94);
//   - wires Escape→cancel and Ctrl+Z→undo (FR-78);
//   - feeds `buildKnifePrimitives(state)` to the injected render sink on every state
//     change so the overlay / target emphasis / cut preview / 固定円 are drawn (FR-90
//     / FR-92), and re-uses U23's property form for非継承側プロパティ入力 (FR-93).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { BasicAttributes, ColorInfo } from '../../domain/attributes';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import type { FeatureId } from '../../domain/ids';
import {
  KNIFE_PHASE,
  smallerSide as domainSmallerSide,
  shouldCloseOnCircleClick,
  type InheritanceSide,
  type SplitSnapshot,
} from '../../domain/knife/index';

import { buildKnifePrimitives, DEFAULT_KNIFE_STYLE, type KnifeStyle } from '../../render/knife-batch';
import type { DrawPrimitive } from '../../render/map-renderer';

import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import { AddPropertyForm } from '../add/AddPropertyForm';
import type { AddProperties } from '../../domain/add/index';

import { InheritorModal } from './InheritorModal';
import { KNIFE_STRINGS } from './strings';
import {
  KNIFE_FLOW,
  useKnifeTool,
  type ResolveAnchorTime,
  type ResolveFeature,
  type ResolveVertexStore,
  type StartSplitProcess,
} from './useKnifeTool';
import { type SplitIdPorts } from '../../domain/knife/index';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** The render sink the provisional knife primitives are pushed into (U17). */
export interface KnifeDrawSink {
  drawKnife(primitives: readonly DrawPrimitive[]): void;
}

/** Convert a pointer event's client position to a world coordinate (U17). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/** Resolve the feature id under a click (host hit-test; U22/U10). null = miss. */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

/** The fixed-circle screen radius in world degrees at the current zoom (FR-17). */
export type CircleWorldRadius = () => number;

export interface KnifeToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U13 process-start adapter (host-bound; spec §依存 U13). */
  readonly startProcess: StartSplitProcess<S>;
  /** Injected id minting (NFR 5.8). */
  readonly ids: SplitIdPorts;
  /** Resolve a clicked feature id → domain Feature (LEAF gate is in the hook). */
  readonly resolveFeature: ResolveFeature;
  /** Resolve the live vertex store for geometry. */
  readonly resolveStore: ResolveVertexStore;
  /** The anchor time the split confirms at (UI 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host hit-test). */
  readonly featureAtPoint: FeatureAtPoint;
  /** The selected target leaf's resolved shape (for render emphasis). */
  readonly targetShape: GeoMultiPolygon | undefined;
  /** The provisional-knife render sink (U17). */
  readonly drawSink: KnifeDrawSink;
  /** The current camera zoom (CSS px/deg) for the固定円 radius. */
  readonly zoom: number;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection. */
  readonly onCommitted?: ((result: ProcessResult<S>, snapshot: SplitSnapshot) => void) | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<SplitSnapshot>) => void)
    | undefined;
  /** A sensible color for the非継承側 new feature when the form omits it (FR-97). */
  readonly defaultColor: ColorInfo;
  /** Provisional draw style override. */
  readonly style?: KnifeStyle | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function KnifeToolController<S>(props: KnifeToolControllerProps<S>): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    resolveFeature,
    resolveStore,
    anchorTime,
    screenToWorld,
    featureAtPoint,
    targetShape,
    drawSink,
    zoom,
    onConflicts,
    defaultColor,
    style,
  } = props;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;

  const knife = useKnifeTool<S>({
    resolveFeature,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    ...(onConflicts ? { onConflicts } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the knife is "active" iff edit.knife is the tool in
  // 編集モード. When that CHANGES, funnel through start / resetForSwitch so no
  // transient state leaks across the transition. One effect keyed on the boolean.
  const isKnifeActive = mode === EDIT_MODE.Edit && activeTool === TOOL_ID.EditKnife;
  const prevActiveRef = useRef<boolean>(false);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (isKnifeActive === prev) return;
    prevActiveRef.current = isKnifeActive;
    if (isKnifeActive) {
      knife.start();
    } else {
      knife.resetForSwitch();
    }
    // Key on the active boolean only (start/reset fire exactly on a transition).
  }, [isKnifeActive]);

  // --- Feed the provisional knife primitives to the render sink on every state
  // change (FR-90 / FR-92). An idle state yields [] so the overlay / circle vanish
  // on reset (教訓 5.2) with no clearing code.
  useEffect(() => {
    drawSink.drawKnife(
      buildKnifePrimitives({ state: knife.state, targetShape, zoom }, style),
    );
  }, [knife.state, targetShape, zoom, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo (FR-78). Active while a session runs.
  useEffect(() => {
    if (knife.flow === KNIFE_FLOW.Idle) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        knife.cancel();
        return;
      }
      if (
        knife.state.phase === KNIFE_PHASE.DrawingCut &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        e.preventDefault();
        knife.undoCutPoint();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [knife.flow, knife.state.phase, knife.cancel, knife.undoCutPoint]);

  // --- Map-input handler with the固定円ヒット優先 (教訓 5.14). A click while:
  //   - SelectingTarget → resolve the feature under it and select (LEAF gate in hook);
  //   - DrawingCut → if ≥1 point placed AND the click is INSIDE the固定円 (within the
  //     screen-fixed radius of the FIRST point) route to clickInsideCircle (閉線確定 at
  //     ≥3 pts), else add a vertex. The overlay never steals this — the input layer
  //     sits above the map and forwards here while a knife session runs.
  const circleWorldRadius = useMemo(
    () => (zoom > 0 ? DEFAULT_KNIFE_STYLE.circleRadiusPx / zoom : Infinity),
    [zoom],
  );

  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const world = screenToWorld(e.clientX, e.clientY);
      const s = knife.state;
      if (s.phase === KNIFE_PHASE.SelectingTarget) {
        const fid = featureAtPoint(world);
        if (fid !== null) knife.selectTarget(fid);
        return;
      }
      if (s.phase === KNIFE_PHASE.DrawingCut) {
        const first = s.line.points[0];
        // Euclidean degree distance: the固定円 is a screen-space radius mapped to
        // world degrees via the equirectangular transform (same zoom for lon/lat).
        const within =
          first !== undefined &&
          Math.hypot(first.lon - world.lon, first.lat - world.lat) <= circleWorldRadius;
        const insideCircle =
          within && shouldCloseOnCircleClick(s.line.points.length, true);
        if (first !== undefined && insideCircle) {
          knife.clickInsideCircle(world, true);
        } else {
          knife.placeCutPoint(world);
        }
      }
    },
    [knife, screenToWorld, featureAtPoint, circleWorldRadius],
  );

  return (
    <KnifeToolChrome
      knife={knife}
      defaultColor={defaultColor}
      onMapPointerDown={onMapPointerDown}
    />
  );
}

// --- The provisional-knife chrome (guide + triggers + modal + property form) --

interface KnifeToolChromeProps<S> {
  readonly knife: ReturnType<typeof useKnifeTool<S>>;
  readonly defaultColor: ColorInfo;
  readonly onMapPointerDown: (e: { clientX: number; clientY: number; button?: number }) => void;
}

function KnifeToolChrome<S>(props: KnifeToolChromeProps<S>): JSX.Element | null {
  const { knife, defaultColor } = props;

  if (knife.flow === KNIFE_FLOW.Idle) return null;

  const drawing = knife.state.phase === KNIFE_PHASE.DrawingCut;
  const choosing = knife.state.phase === KNIFE_PHASE.ChoosingInheritor;
  const entering = knife.state.phase === KNIFE_PHASE.EnteringProperties;

  return (
    <div className="knife-tool" data-testid="knife-tool" data-flow={knife.flow}>
      {/* The map input bridge: a transparent layer ABOVE the map (教訓 5.14) ONLY
          while selecting / drawing, so it never steals input otherwise. The
          overlay drawn underneath does NOT capture clicks — this layer does, and
          forwards them to the hook with the固定円ヒット優先. */}
      {(knife.flow === KNIFE_FLOW.SelectingTarget || knife.flow === KNIFE_FLOW.DrawingCut) && (
        <div
          className="knife-tool__input"
          data-testid="knife-input-layer"
          onPointerDown={(e) =>
            props.onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
          }
        />
      )}

      {/* The per-phase Japanese guide (FR-92). */}
      <p className="knife-tool__guide" data-testid="knife-guide" role="status">
        {knife.guide}
      </p>

      {/* 判断用メッセージ (分割可能検証拒否) — kept until a meaningful event (教訓 5.12). */}
      {knife.message !== null && (
        <p className="knife-tool__message" data-testid="knife-message" role="alert">
          {knife.message}
        </p>
      )}

      {/* DrawingCut controls: confirm cut / undo vertex / cancel (教訓 5.7). */}
      {drawing && (
        <div className="knife-tool__controls" data-testid="knife-controls">
          <button
            type="button"
            data-testid="knife-confirm-cut"
            onClick={() => knife.confirmCut()}
          >
            分断線を確定
          </button>
          <button
            type="button"
            data-testid="knife-undo"
            disabled={
              knife.state.phase !== KNIFE_PHASE.DrawingCut ||
              knife.state.line.points.length === 0
            }
            onClick={() => knife.undoCutPoint()}
          >
            {KNIFE_STRINGS.undoVertex}
          </button>
          <button type="button" data-testid="knife-cancel" onClick={() => knife.cancel()}>
            {KNIFE_STRINGS.cancel}
          </button>
          {/* Live cut-point count for integration tests. */}
          <span data-testid="knife-cut-count" hidden>
            {knife.state.phase === KNIFE_PHASE.DrawingCut
              ? knife.state.line.points.length
              : 0}
          </span>
        </div>
      )}

      {/* 継承先選択モーダル (FR-93). */}
      {choosing && knife.state.phase === KNIFE_PHASE.ChoosingInheritor && (
        <InheritorModal
          sideA={knife.state.result.sideA.area}
          sideB={knife.state.result.sideB.area}
          smallerSide={domainSmallerSide(knife.state.result) as InheritanceSide}
          selected={knife.state.selected}
          onSelect={(side) => knife.selectInheritor(side)}
          onConfirm={() => knife.confirmInheritor()}
          onCancel={() => knife.cancel()}
        />
      )}

      {/* 非継承側プロパティ入力 — re-uses U23's add form (FR-93 / 教訓 5.30). */}
      {entering && (
        <NonInheritedForm
          defaultColor={defaultColor}
          onSave={(attributes, color) => knife.save({ attributes, color })}
          onCancel={() => knife.cancel()}
        />
      )}

      {knife.flow === KNIFE_FLOW.ConflictPaused && (
        <p data-testid="knife-conflict-paused" role="status">
          {KNIFE_STRINGS.conflictPaused}
        </p>
      )}

      {knife.flow === KNIFE_FLOW.Rejected && knife.message !== null && (
        <div data-testid="knife-rejected">
          <p role="alert">{knife.message}</p>
          <button type="button" data-testid="knife-rejected-dismiss" onClick={() => knife.cancel()}>
            {KNIFE_STRINGS.cancel}
          </button>
        </div>
      )}
    </div>
  );
}

// --- 非継承側プロパティ入力 (re-uses U23's AddPropertyForm shape; FR-93) --------
//
// The spec mandates RE-USING U23's面情報追加入力フロー (FR-93 / 教訓 5.30 過少共有).
// U23's AddPropertyForm is a face-add form that emits `AddProperties` (attributes
// + color). For the非継承側 we drive the SAME form (no parent selector — the parent
// is initially inherited from the original by the domain assembler) and forward its
// result as {@link NonInheritedProperties}. Importing the U23 component keeps the
// single form implementation shared rather than duplicated (過少共有の戒め).

function NonInheritedForm(props: {
  readonly defaultColor: ColorInfo;
  readonly onSave: (attributes: BasicAttributes, color: ColorInfo) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { onSave, onCancel } = props;
  return (
    <div className="knife-tool__props" data-testid="knife-props">
      <h3>{KNIFE_STRINGS.newFeatureProps}</h3>
      <AddPropertyForm
        showParent={false}
        parentCandidates={[]}
        onChooseParent={() => {
          /* parent is inherited from the original by the domain assembler (FR-44) */
        }}
        onSave={(p: AddProperties) => onSave(p.attributes, p.color)}
        onCancel={onCancel}
      />
    </div>
  );
}

/** A no-op draw sink (for hosts that have not mounted a renderer yet). */
export const NO_KNIFE_DRAW_SINK: KnifeDrawSink = {
  drawKnife() {
    /* nothing to draw into yet */
  },
};
