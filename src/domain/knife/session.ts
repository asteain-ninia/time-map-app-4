// U26 — the knife-tool session state machine (FR-90 / FR-92 / FR-93 / FR-94,
// 教訓5.2 / 5.7 / 5.8).
//
// Pure, framework-free domain logic: the knife interaction is an EXPLICIT
// discriminated state machine so every transition AND every一時状態破棄 path is
// testable in plain Node without React / Canvas / Zustand (spec §実装方針 1). The
// owning UI unit holds ONE instance in its session store and routes pointer / key
// / tool / mode events through these pure transitions; each returns a NEW state
// (immutable; 教訓5.17) and never mutates input.
//
// 不正状態を表現不能に (技術方針 2.1): the phase discriminant means "分断線入力中"
// cannot exist without a selected target, "継承先選択中" cannot exist without a
// validated split, etc. 一時状態 (オーバーレイ・分断線ドラフト・固定円・選択中継承先・
// プレビュー) is破棄される through the SINGLE `idle()` reset that every exit path —
// 開始・確定・キャンセル・ツール切替・モード切替 — funnels through (教訓5.2 全経路で破棄).

import type { FeatureId } from '../ids';
import {
  KNIFE_LINE_KIND,
  MIN_POINTS_TO_CLOSE,
  createOpenKnifeLine,
  shouldCloseOnCircleClick,
  withAppendedPoint,
  withoutLastPoint,
  type KnifeLine,
} from './knife-line';
import type { SplitResult } from './split-geometry';
import type { WorldCoordinate } from '../coordinate';

export const KNIFE_PHASE = {
  /** Knife inactive — overlay not shown (the tool is off / 起動前). */
  Inactive: 'inactive',
  /** オーバーレイ表示。クリックで末端地物を 1 件選ぶ。対象未選択では次へ進めない (FR-90). */
  SelectingTarget: 'selecting-target',
  /** 対象選択済み。分断線頂点列を蓄積。固定円・ガイド文表示 (FR-90 / FR-92). */
  DrawingCut: 'drawing-cut',
  /** 分割成立後。継承先選択モーダル (小さい方プレビュー) 表示 (FR-93). */
  ChoosingInheritor: 'choosing-inheritor',
  /** 非継承側プロパティ入力 (U23 追加入力フロー再利用; FR-93). */
  EnteringProperties: 'entering-properties',
} as const;

export type KnifePhase = (typeof KNIFE_PHASE)[keyof typeof KNIFE_PHASE];

export interface InactiveState {
  readonly phase: typeof KNIFE_PHASE.Inactive;
}

export interface SelectingTargetState {
  readonly phase: typeof KNIFE_PHASE.SelectingTarget;
}

export interface DrawingCutState {
  readonly phase: typeof KNIFE_PHASE.DrawingCut;
  readonly targetId: FeatureId;
  readonly line: KnifeLine;
}

export interface ChoosingInheritorState {
  readonly phase: typeof KNIFE_PHASE.ChoosingInheritor;
  readonly targetId: FeatureId;
  readonly line: KnifeLine;
  readonly result: SplitResult;
  /**
   * The currently-highlighted piece, as an INDEX into `result.pieces` (HB3-5/19
   * n-way). Seeded to the SMALLEST piece (`smallestPieceIndex`; FR-93 / 教訓5.4).
   */
  readonly selectedIndex: number;
}

export interface EnteringPropertiesState {
  readonly phase: typeof KNIFE_PHASE.EnteringProperties;
  readonly targetId: FeatureId;
  readonly line: KnifeLine;
  readonly result: SplitResult;
  /**
   * The confirmed継承先 piece INDEX (into `result.pieces`); EVERY other piece becomes a
   * 非継承側 new feature sharing the ONE U23 default being authored (HB3-5/19 n-way).
   */
  readonly inheritIndex: number;
}

export type KnifeState =
  | InactiveState
  | SelectingTargetState
  | DrawingCutState
  | ChoosingInheritorState
  | EnteringPropertiesState;

// --- Reset / start (the SINGLE discard funnel; 教訓5.2) ----------------------

/** The inactive state: every一時状態 dropped. Every exit path returns this. */
export function idle(): KnifeState {
  return { phase: KNIFE_PHASE.Inactive };
}

/** 起動: overlay on, awaiting a target click. Starting also discards any prior一時状態. */
export function startKnife(): KnifeState {
  return { phase: KNIFE_PHASE.SelectingTarget };
}

/**
 * Cancel / ツール切替 / モード切替: drop EVERYTHING and return to inactive (教訓5.2
 * 全経路で破棄). The same funnel for every abort path so一時状態 never leaks into the
 * next operation (受け入れ基準8).
 */
export function cancelKnife(): KnifeState {
  return idle();
}

// --- SelectingTarget transitions --------------------------------------------

/**
 * Select the target末端地物 by id (FR-90). The caller has already verified the
 * clicked feature is a LEAF (集約地物は対象外; FR-44 / 教訓5.25) — only leaf ids reach
 * here. Begins分断線入力 with an empty OPEN line. No-op unless in SelectingTarget.
 */
export function selectTarget(state: KnifeState, targetId: FeatureId): KnifeState {
  if (state.phase !== KNIFE_PHASE.SelectingTarget) return state;
  return {
    phase: KNIFE_PHASE.DrawingCut,
    targetId,
    line: createOpenKnifeLine([]),
  };
}

// --- DrawingCut transitions -------------------------------------------------

/**
 * クリックで分断線頂点を追加 (FR-90). No-op unless in DrawingCut. A CLOSED line is
 * already complete (FR-92): appending to it would yield a 'closed' polygon with an
 * extra tail vertex — an inconsistent KnifeLine the geometry layer would have to
 * defensively reject — so closing is terminal here and this is a no-op (技術方針2.1
 * 不正状態を表現不能に).
 */
export function placeCutPoint(state: KnifeState, point: WorldCoordinate): KnifeState {
  if (state.phase !== KNIFE_PHASE.DrawingCut) return state;
  if (state.line.kind === KNIFE_LINE_KIND.Closed) return state;
  return { ...state, line: withAppendedPoint(state.line, point) };
}

/**
 * 最後に置いた頂点を 1 つ取り消す (FR-78 共通機能). No-op unless in DrawingCut. If undo
 * drops a CLOSED line below the minimum needed to be closed (MIN_POINTS_TO_CLOSE),
 * the polygon can no longer exist, so the line reverts to OPEN — a 'closed' line
 * with <3 vertices is an unrepresentable inconsistent state (技術方針2.1).
 */
export function undoLastCutPoint(state: KnifeState): KnifeState {
  if (state.phase !== KNIFE_PHASE.DrawingCut) return state;
  const reduced = withoutLastPoint(state.line);
  if (
    reduced.kind === KNIFE_LINE_KIND.Closed &&
    reduced.points.length < MIN_POINTS_TO_CLOSE
  ) {
    return { ...state, line: createOpenKnifeLine(reduced.points) };
  }
  return { ...state, line: reduced };
}

/**
 * A click landing INSIDE the固定円 (FR-92). With ≥3 points it CLOSES the cut line
 * (閉線分割); otherwise the click is treated as a normal頂点追加 (2 点以下では閉じない
 * / 円外クリックは頂点追加 — 受け入れ基準3). The circle hit test (screen-fixed size,
 * FR-17) is the render/UI layer's job; this transition takes its boolean verdict.
 */
export function clickInsideCircle(
  state: KnifeState,
  point: WorldCoordinate,
  insideCircle: boolean,
): KnifeState {
  if (state.phase !== KNIFE_PHASE.DrawingCut) return state;
  // An already-CLOSED line is terminal (FR-92): neither re-close nor append (技術
  // 方針2.1 — no tail vertex on a closed polygon).
  if (state.line.kind === KNIFE_LINE_KIND.Closed) return state;
  if (shouldCloseOnCircleClick(state.line.points.length, insideCircle)) {
    return { ...state, line: { kind: KNIFE_LINE_KIND.Closed, points: state.line.points } };
  }
  // Not closeable (or outside the circle): a normal vertex placement.
  return { ...state, line: withAppendedPoint(state.line, point) };
}

/**
 * 分割成立 (検証通過) — advance to継承先選択 with the computed result. `smallestIndex` is
 * the SMALLEST piece's index (`smallestPieceIndex`), seeded as the highlighted choice
 * (FR-93 小さい方 / 教訓5.4 UI 文脈優先 — HB3-5/19 generalized to n-way). Confirming the
 * cut is the完了トリガー the UI must call (教訓5.7). No-op unless in DrawingCut.
 */
export function confirmCut(
  state: KnifeState,
  result: SplitResult,
  smallestIndex: number,
): KnifeState {
  if (state.phase !== KNIFE_PHASE.DrawingCut) return state;
  return {
    phase: KNIFE_PHASE.ChoosingInheritor,
    targetId: state.targetId,
    line: state.line,
    result,
    selectedIndex: smallestIndex,
  };
}

// --- ChoosingInheritor transitions ------------------------------------------

/**
 * Highlight a継承先 piece by INDEX (FR-93 ボタン選択時ハイライト; HB3-5/19 n-way). No-op
 * unless in ChoosingInheritor.
 */
export function selectInheritor(state: KnifeState, index: number): KnifeState {
  if (state.phase !== KNIFE_PHASE.ChoosingInheritor) return state;
  return { ...state, selectedIndex: index };
}

/**
 * 確定ボタン: confirm the highlighted継承先 and advance to非継承側プロパティ入力 (FR-93).
 * The完了トリガー the UI must call (教訓5.7). No-op unless in ChoosingInheritor.
 */
export function confirmInheritor(state: KnifeState): KnifeState {
  if (state.phase !== KNIFE_PHASE.ChoosingInheritor) return state;
  return {
    phase: KNIFE_PHASE.EnteringProperties,
    targetId: state.targetId,
    line: state.line,
    result: state.result,
    inheritIndex: state.selectedIndex,
  };
}

/** Step BACK from継承先選択 to分断線入力 (re-draw). 一時 result is dropped (教訓5.2). */
export function backToDrawing(state: KnifeState): KnifeState {
  if (
    state.phase !== KNIFE_PHASE.ChoosingInheritor &&
    state.phase !== KNIFE_PHASE.EnteringProperties
  ) {
    return state;
  }
  return {
    phase: KNIFE_PHASE.DrawingCut,
    targetId: state.targetId,
    line: state.line,
  };
}

// --- Derived helpers --------------------------------------------------------

/** True iff in a phase where the map-wide オーバーレイ is shown (FR-90). */
export function isOverlayVisible(state: KnifeState): boolean {
  return (
    state.phase === KNIFE_PHASE.SelectingTarget ||
    state.phase === KNIFE_PHASE.DrawingCut
  );
}

/** True iff the固定円 should be shown (≥1 cut point placed while drawing; FR-92). */
export function isFixedCircleVisible(state: KnifeState): boolean {
  return state.phase === KNIFE_PHASE.DrawingCut && state.line.points.length >= 1;
}
