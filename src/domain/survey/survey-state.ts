// Survey-mode state machine (U37, FR-14 / FR-15 / FR-16, 教訓 5.2 / 5.7 / 5.8).
//
// Pure, framework-free domain logic: the survey interaction is an explicit state
// machine so every transition (and every temporary-state discard path) is
// testable in plain Node without React / Canvas / Zustand (spec §4.1 / §4.2).
// The owning UI unit (U20 shell) holds ONE instance of this state in its session
// store and routes pointer / button events through these pure transitions; the
// transitions return a NEW state (immutable, lesson 5.17) and never mutate input.
//
// Two state slots are kept DELIBERATELY separate (spec §4.2 / 教訓 5.2):
//   1. `lines` — the CONFIRMED survey lines (+ their markers). These persist
//      across mode toggles and are cleared ONLY by `clear`. They are a temporary,
//      NON-persisted UI display (FR-15): never written to the `.gimoza` schema.
//   2. `draft` — the in-progress draft (start point clicked, end not yet). This
//      is discarded on EVERY path: confirm, cancel, clear, tool switch, mode
//      switch / survey-mode exit. Confusing the two slots is the named pitfall
//      (spec §6 落とし穴) — mode exit discards `draft` only and KEEPS `lines`;
//      `clear` empties both.
//
// 教訓 5.18 (empty is a true value): "0 confirmed lines" and "no draft" are
// represented explicitly (`[]` and `null`), never conflated with a falsy
// short-circuit. Callers test `draft !== null` / `lines.length`.

import type { WorldCoordinate } from '../coordinate';

// --- Phase discriminant ------------------------------------------------------

/** The survey draft phase (the point-placing flow, spec §4.2). */
export const SURVEY_PHASE = {
  /** Survey mode active, no start point yet — the next click sets the start. */
  Idle: 'idle',
  /** Start point placed — hover previews, the next click confirms a line. */
  AwaitingEnd: 'awaitingEnd',
} as const;

export type SurveyPhase = (typeof SURVEY_PHASE)[keyof typeof SURVEY_PHASE];

// --- Confirmed survey line ---------------------------------------------------

/**
 * One confirmed survey line: its two clicked endpoints (continuous-scalar
 * longitudes, as clicked). Distances and the drawn great-circle polyline are
 * DERIVED on demand from these endpoints (教訓 5.3: derive display from the
 * stored truth, do not duplicate computed values into state) so a geoParams /
 * settings change re-derives without stale cached numbers.
 *
 * `id` is a monotone counter from the state machine; it is a transient UI id, NOT
 * a domain feature id, and is never persisted (FR-15 / spec §4.5).
 */
export interface SurveyLine {
  readonly id: number;
  readonly start: WorldCoordinate;
  readonly end: WorldCoordinate;
}

// --- In-progress draft -------------------------------------------------------

/**
 * The in-progress draft after the first click. `hover` is the live cursor world
 * point used for the preview line / preview distance / preview lat-lon; it is
 * `null` until the first hover after the click. The draft is a temporary slot
 * discarded on all paths (教訓 5.2).
 */
export interface SurveyDraft {
  readonly start: WorldCoordinate;
  /** Live hover point for the preview, or null before the first hover move. */
  readonly hover: WorldCoordinate | null;
}

// --- The whole survey state --------------------------------------------------

/**
 * The complete survey-mode state. `active` is the survey mode toggle (a separate
 * axis from the edit add/edit/view mode, spec §2.1). `phase` is derived-but-
 * stored for an explicit machine; it always equals `draft === null ? Idle :
 * AwaitingEnd` and is asserted so by tests (no drift).
 */
export interface SurveyState {
  /** Survey mode on/off (the補助モード toggle, FR-14). */
  readonly active: boolean;
  readonly phase: SurveyPhase;
  /** The in-progress draft, or null when idle (教訓 5.18: null is the真値). */
  readonly draft: SurveyDraft | null;
  /** Confirmed lines, oldest first. Empty array is a valid "no lines" (教訓 5.18). */
  readonly lines: readonly SurveyLine[];
  /** Monotone id source for confirmed lines (transient, non-persisted). */
  readonly nextLineId: number;
  /**
   * **直前に右クリックで消した 1 本**（増分 8C の手直し / 反証 #2）。状態行の［戻す］と、
   * 消した直後の Ctrl+Z がこれを元の位置へ戻す。覚えるのは最後の 1 本だけ（2 本の線のセット）。
   *
   * 捨てる契機（決めた範囲）: **線を増やす・減らす測量の操作**（点を置く・クリア）・
   * 別の線を消す（その線に置き換わる）・戻した。ストアの側では、地物の編集・取り消し／やり直し・
   * 道具の持ち替え・鍵の切り替え・読み込み／新規でも捨てる。
   *
   * **捨てないもの**: カーソルの移動（`updateHover`）、**下書きの取りやめ（Esc）と測るの入り切り
   * （`U`・レールの「📏 測る」）**（増分 8C の再手直し / 再検証 #1・#2）。どれも線を 1 本も増減させない
   * ので、覚えを捨てて守るもの（新しく測った線と戻す線の取り違え）が無い。逆に捨てると、始点を
   * 置いた途中で線を消す → Ctrl+Z が下書き中で届かない → 案内どおり Esc → もう一度 Ctrl+Z、という
   * いちばん自然な立て直しで、Ctrl+Z が関係のない地物の編集を取り消していた。
   * 保存はしない（線そのものと同じく一時的な表示）。
   */
  readonly removed: RemovedSurveyLine | null;
}

/** 右クリックで消した線と、消す前に並んでいた位置（{@link SurveyState.removed}）。 */
export interface RemovedSurveyLine {
  readonly line: SurveyLine;
  /** `lines` の中の位置（戻すときに同じ位置へ入れる。描く順・凡例の並びを変えないため）。 */
  readonly index: number;
}

/** The initial survey state: mode off, nothing drafted, no lines. */
export function initialSurveyState(): SurveyState {
  return {
    active: false,
    phase: SURVEY_PHASE.Idle,
    draft: null,
    lines: [],
    nextLineId: 1,
    removed: null,
  };
}

/**
 * 消した線の覚えを捨てる（増分 8C の手直し）。**覚えが無ければ同じ参照を返す** ――
 * 地物の編集のたびに測量の層を描き直さないため（測量の描画は `survey` の参照で動く）。
 */
export function forgetRemovedSurveyLine(state: SurveyState): SurveyState {
  return state.removed === null ? state : { ...state, removed: null };
}

// --- Internal: discard ONLY the transient draft (keep confirmed lines) -------
//
// The single helper every "discard the in-progress draft" path funnels through
// (教訓 5.2 全経路で破棄 + 単一真実源). It resets phase to Idle and draft to null
// but never touches `lines` (those survive until `clear`).

function withDraftDiscarded(state: SurveyState): SurveyState {
  if (state.draft === null && state.phase === SURVEY_PHASE.Idle) {
    return state;
  }
  return { ...state, phase: SURVEY_PHASE.Idle, draft: null };
}

// --- Mode toggle -------------------------------------------------------------

/**
 * Enable survey mode. Entering the mode starts from a clean draft (idle) but
 * KEEPS any previously confirmed lines (they persist across mode toggles,
 * FR-15). Idempotent.
 */
export function enableSurveyMode(state: SurveyState): SurveyState {
  // 消した線の覚えは捨てない（線を増減させない。`SurveyState.removed`）。
  return { ...withDraftDiscarded(state), active: true };
}

/**
 * Disable survey mode (exit). Per the named pitfall (spec §6 / 教訓 5.2): mode
 * exit discards the in-progress DRAFT ONLY and KEEPS the confirmed lines, which
 * stay visible until an explicit `clear`. This is distinct from `clear`, which
 * empties both. Idempotent.
 */
export function disableSurveyMode(state: SurveyState): SurveyState {
  // 消した線の覚えは捨てない（線を増減させない。`SurveyState.removed`）。
  return { ...withDraftDiscarded(state), active: false };
}

// --- Pointer transitions -----------------------------------------------------

/**
 * Handle a confirming click at `point` (a click = press/release at the same
 * place; drag is routed to pan by the input layer, 教訓 5.8 — this function is
 * only ever called for a genuine click). The completion trigger (教訓 5.7):
 *   - Idle  -> AwaitingEnd: the click sets the start point.
 *   - AwaitingEnd -> a NEW confirmed line is appended and the draft is discarded,
 *     returning to Idle ready for the next survey (spec §4.2).
 *
 * A click while survey mode is OFF is a no-op (the survey machine ignores map
 * clicks unless active).
 */
export function clickPoint(state: SurveyState, point: WorldCoordinate): SurveyState {
  if (!state.active) {
    return state;
  }
  // 点を置くのは測量の操作なので、消した線の覚えを捨てる（増分 8C の手直し）。
  if (state.draft === null) {
    // First click: start the draft.
    return {
      ...state,
      phase: SURVEY_PHASE.AwaitingEnd,
      draft: { start: point, hover: point },
      removed: null,
    };
  }
  // Second click: confirm a line, then discard the draft (back to Idle).
  const line: SurveyLine = {
    id: state.nextLineId,
    start: state.draft.start,
    end: point,
  };
  return {
    ...state,
    phase: SURVEY_PHASE.Idle,
    draft: null,
    lines: [...state.lines, line],
    nextLineId: state.nextLineId + 1,
    removed: null,
  };
}

/**
 * Update the live hover point used for the preview (preview line / distance /
 * lat-lon). Only meaningful while a draft exists; a hover with no draft (or with
 * survey mode off) is ignored. Hover updates are high-frequency and must NOT ride
 * the React render path (spec §4.1 / NFR 5.1) — the owning unit keeps this in the
 * Zustand session store and the Canvas subscribes.
 */
export function updateHover(state: SurveyState, point: WorldCoordinate): SurveyState {
  if (!state.active || state.draft === null) {
    return state;
  }
  return { ...state, draft: { start: state.draft.start, hover: point } };
}

// --- Cancel / tool-switch (draft-only discard paths) -------------------------

/**
 * Cancel the in-progress measurement (Escape, spec §4.2). Discards the draft
 * only; confirmed lines remain. No-op when idle.
 */
export function cancelDraft(state: SurveyState): SurveyState {
  // **消した線の覚えは捨てない**（増分 8C の再手直し / 再検証 #1）。始点を置いた途中は Ctrl+Z が
  // 届かないので、案内どおり Esc で下書きをやめてから Ctrl+Z で線を戻す流れを残す。
  return withDraftDiscarded(state);
}

/**
 * Run the reset契約 on a tool / sub-tool switch within survey mode (教訓 5.2).
 * Same as cancel: draft only is discarded, confirmed lines remain. 道具の持ち替えなので、
 * 消した線の覚えも捨てる（増分 8C の手直し）。
 */
export function discardOnToolSwitch(state: SurveyState): SurveyState {
  return forgetRemovedSurveyLine(withDraftDiscarded(state));
}

// --- Clear (empties BOTH slots) ---------------------------------------------

/**
 * Clear ALL survey results: every confirmed line AND every marker AND the
 * in-progress draft (FR-15 クリアボタン). This is the only path that empties
 * `lines`. The completion trigger for clear must be wired from the UI clear
 * button (教訓 5.7). The id counter is NOT reset — transient ids stay unique for
 * the session even after a clear (avoids id reuse confusing any in-flight
 * subscriber).
 */
export function clearSurvey(state: SurveyState): SurveyState {
  return {
    ...state,
    phase: SURVEY_PHASE.Idle,
    draft: null,
    lines: [],
    removed: null,
  };
}

// --- Remove ONE confirmed line (増分 8C / 設計書 §E.1 V15) ------------------

/**
 * 確定した線を **1 本だけ**消す（増分 8C の中身 1 / 設計書 §E.1 の V15）。
 *
 * 1 回の測量は正距円筒の線と大円の線の 2 本を描くが、どちらも同じ `SurveyLine`
 * （同じ id）から描いているので、ここで 1 件消せば **2 本が一緒に**消える。
 *
 * - 消すのは `lines` の中の 1 件だけ。測っている途中の `draft` には触らない
 *   （右クリックで線を消しても、始点を押した途中の測量は続けられる）。
 * - `nextLineId` は戻さない（`clearSurvey` と同じ理由: 一度使った id を再び使うと、
 *   開いたままのメニューが握っている古い id が別の線を指してしまう）。
 * - **その id の線が無ければ同じ参照をそのまま返す**（教訓 5.24: 何も変わらない確定は
 *   何もしない）。メニューを開いてから［測量結果をクリア］を押した、など、凍結した
 *   id が押すときにはもう無い場合がこれに当たる。
 * - 消した線は `removed` に覚える（増分 8C の手直し / 反証 #2）。前に覚えていた線は捨てる
 *   （戻せるのは直前に消した 1 本だけ）。
 */
export function removeSurveyLine(state: SurveyState, id: number): SurveyState {
  const index = state.lines.findIndex((line) => line.id === id);
  if (index < 0) {
    return state;
  }
  return {
    ...state,
    lines: [...state.lines.slice(0, index), ...state.lines.slice(index + 1)],
    removed: { line: state.lines[index]!, index },
  };
}

/**
 * 直前に消した線を **元の位置へ戻す**（増分 8C の手直し / 反証 #2。状態行の［戻す］と、
 * 消した直後の Ctrl+Z）。覚えが無ければ同じ参照を返す。
 *
 * - 戻すのは同じ id の同じ線（id は使い回さないので、ほかの線と衝突しない）。
 * - 位置は消す前の位置。その後に線が減っていても末尾を越えない。
 * - 測っている途中の始点には触らない（消すときと同じ）。
 * - 戻したら覚えを捨てる（2 回押しても 2 本にならない）。
 */
export function restoreRemovedSurveyLine(state: SurveyState): SurveyState {
  const removed = state.removed;
  if (removed === null) return state;
  if (state.lines.some((line) => line.id === removed.line.id)) {
    // 念のため（id は使い回さないので起きない）。重ねて入れない。
    return { ...state, removed: null };
  }
  const at = Math.min(removed.index, state.lines.length);
  return {
    ...state,
    lines: [...state.lines.slice(0, at), removed.line, ...state.lines.slice(at)],
    removed: null,
  };
}
