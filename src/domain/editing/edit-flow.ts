// U24 — the confirm-time (RELEASE) edit flow: assemble the complete-state edit
// proposal and drive U13 (FR-59 / FR-61〜63, 教訓5.7 完了トリガー / 5.24 no-op).
//
// LAYER: pure `domain` logic. This module is the調停: on a confirming release it
// (1) runs the no-op guard (教訓5.24 — zero move / no change ⇒ do nothing, no
// ghost undo), (2) decides whether a still-standing snap candidate becomes a
// share pair to forward to U11 (受け入れ基準12 — only a candidate that survives to
// release counts; a lapsed one is dropped), and (3) hands ONE EditProposal to
// U13's startProcess (the SINGLE confirm path; we never re-implement the fixed
// pipeline here, spec §依存 U13 / 教訓5.26).
//
// The proposal carries the COMPLETE target state (FR-59 一体編集): even an
// attribute-only edit is the whole feature snapshot, never a partial confirm. The
// snapshot is opaque to U13; this unit provides a concrete {@link FeatureSnapshot}
// the U13 ports apply.

import { startProcess } from '../consistency/orchestrator';
import {
  createEditProposal,
  type ConsistencyPorts,
  type EditProposal,
  type ProcessResult,
} from '../consistency/types';
import type { TimePoint } from '../time/time-point';
import type { FeatureId, VertexId } from '../ids';
import type { Feature } from '../feature';
import type { Vertex } from '../vertex';
import type { WorldCoordinate } from '../coordinate';
import { coordinatesEqual } from '../coordinate';
import { isWorldLatitude } from '../geo/latitude';
import { longEdgeStartIndexes, MAX_EDGE_LON_SPAN_DEG } from '../geo/long-edge';
import { dragDelta, isNoOp, type DragSession } from './drag-session';
import type { SnapDecision } from './snap';

/**
 * The concrete complete-state snapshot U24 confirms (FR-59). It is the whole
 * after-state for the touched feature: its full record plus any vertex bodies the
 * edit created / moved (the U13 ports merge them into app state). For a deletion
 * the feature is absent and `deletedFeatureId` is set (片落とし禁止: this is the
 * one indivisible proposal that includes the deletion).
 */
export interface FeatureSnapshot {
  /** The feature's complete after-state, or undefined when it is being deleted. */
  readonly feature?: Feature;
  /** Vertex bodies created or moved by this edit (id → new body). */
  readonly vertices: readonly Vertex[];
  /** Set when the edit deletes the feature entirely (line<2 / leaf no-territory / point). */
  readonly deletedFeatureId?: FeatureId;
  /**
   * A decided shared-vertex pair to share at confirm (FR-31). Present ONLY when a
   * snap candidate survived to release; U13/U11 execute the share + its FR-32
   * validation — U24 does not (受け入れ基準12). Absent ⇒ a plain move.
   */
  readonly sharePair?: { readonly dragged: VertexId; readonly target: VertexId };
}

function buildSnapshot(input: BuildSnapshotInput): FeatureSnapshot {
  const base: {
    feature?: Feature;
    vertices: readonly Vertex[];
    deletedFeatureId?: FeatureId;
    sharePair?: { dragged: VertexId; target: VertexId };
  } = { vertices: input.vertices };
  if (input.feature !== undefined) base.feature = input.feature;
  if (input.deletedFeatureId !== undefined) base.deletedFeatureId = input.deletedFeatureId;
  if (input.sharePair !== undefined) base.sharePair = input.sharePair;
  return base;
}

interface BuildSnapshotInput {
  readonly feature?: Feature | undefined;
  readonly vertices: readonly Vertex[];
  readonly deletedFeatureId?: FeatureId | undefined;
  /**
   * Accepts an explicit `undefined` (the return shape of
   * {@link decideSharePairAtRelease}) so callers can forward a possibly-absent
   * share pair without conditional spreading; {@link buildSnapshot} drops the key
   * when undefined to honour exactOptionalPropertyTypes on {@link FeatureSnapshot}.
   */
  readonly sharePair?: { readonly dragged: VertexId; readonly target: VertexId } | undefined;
}

// --- snap → share-pair decision at release (受け入れ基準12) -------------------

/**
 * Decide the share pair from the session's LIVE snap candidate at release. A
 * candidate that is still standing AND the session is dragging a vertex with a
 * known id becomes a share pair forwarded to U11; otherwise undefined (a lapsed /
 * never-standing candidate is dropped — "snapped but released away ⇒ no share",
 * FR-31). U24 only DECIDES the pair; U11 validates (FR-32) and shares.
 */
export function decideSharePairAtRelease(
  session: DragSession,
): { readonly dragged: VertexId; readonly target: VertexId } | undefined {
  const snap: SnapDecision | null = session.snap;
  if (snap === null) return undefined;
  const dragged = session.draggedVertexId;
  if (dragged === undefined) return undefined; // feature-move has no single vertex.
  if (dragged === snap.vertexId) return undefined; // never share with itself.
  return { dragged, target: snap.vertexId };
}

// --- attribute-only no-op (教訓5.24 baseline same source as form sync) --------

/**
 * True iff a feature's after-state is structurally identical to its baseline,
 * used by the attribute-edit confirm path so an unchanged attribute commit makes
 * no history entry (受け入れ基準10). Compared on the COMPLETE feature value so a
 * partial check cannot let a real change slip (FR-59). Vertex bodies are compared
 * by the moved set being empty / coordinate-equal.
 */
export function isFeatureUnchanged(baseline: Feature, candidate: Feature): boolean {
  return shallowFeatureEqual(baseline, candidate);
}

function shallowFeatureEqual(a: Feature, b: Feature): boolean {
  // Reference-equal is the fast path; otherwise compare the serialisable shape.
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- the RELEASE entry point (教訓5.7 完了トリガー) --------------------------

export const RELEASE_OUTCOME = {
  /** Nothing changed: no consistency run, no history (教訓5.24). */
  NoOp: 'no-op',
  /** A proposal was assembled and U13 ran; carries the process result. */
  Processed: 'processed',
  /**
   * **確定の関門が断った**（増分 3 の手直し A5 / A6）。何も記録せず、理由だけを返す。
   * `NoOp`（何も変わっていないので黙って終わる）とは別の値である ―― こちらは
   * 「変わろうとしたが通せなかった」ので、**画面に理由を出さなければならない**
   * （無反応にしない。設計書 §H.5 / G-23 の共通の出口）。
   */
  Refused: 'refused',
} as const;

export type ReleaseOutcomeKind = (typeof RELEASE_OUTCOME)[keyof typeof RELEASE_OUTCOME];

/**
 * 確定を断った理由（機械可読。文言は UI 層が持つ ―― 教訓 5.26 拒否理由は
 * 「テストできる値」と「通知の文」の両方を返す）。
 */
export const EDIT_REFUSAL = {
  /**
   * N-51: 1 回の移動で経度を 180 度以上動かした（技術方針 §6.8）。保存形式は
   * 「隣り合う頂点は最短方向で繋がっている」と仮定するので、この移動で生まれる辺は
   * **保存して読み直すと必ず別の形になる**。追加の道具は同じ規則で断っており
   * （`domain/add/shape-draft.ts` の `confirmShape`）、編集だけ素通りしていた（反証 #4）。
   */
  LongDrag: 'long-drag',
  /**
   * 緯度 ±90 度の外へ頂点を置こうとした（バグ狩り #3）。北極の上にも南極の下にも
   * 場所は無い。状態行が同じ場所で座標を「—」と出しているのに操作だけ通っていた。
   */
  OutsideWorld: 'outside-world',
} as const;

export type EditRefusalKind = (typeof EDIT_REFUSAL)[keyof typeof EDIT_REFUSAL];

export type ReleaseOutcome<S> =
  | { readonly kind: typeof RELEASE_OUTCOME.NoOp }
  | { readonly kind: typeof RELEASE_OUTCOME.Refused; readonly reason: EditRefusalKind }
  | {
      readonly kind: typeof RELEASE_OUTCOME.Processed;
      readonly result: ProcessResult<S>;
      readonly proposal: EditProposal<FeatureSnapshot>;
    };

/**
 * 確定の関門（増分 3 の手直し A5 / A6）。通らなければ理由を返す（通れば null）。
 *
 * **経度は「1 回の移動の差」で見る**。保存されている座標どうしの差で見てはいけない ――
 * 日付変更線をまたぐ正しい地物は代表値では 358 度離れて見えるので、それを断ると継ぎ目の
 * 地物が 1 つも編集できなくなる。断るべきなのは **利用者が意図した移動が半周以上のとき**で、
 * それはドラッグの押した点と離した点の差にそのまま表れる（`dragDelta`）。
 *
 * **緯度は移動後の体で見る**。こちらは差ではなく位置そのものが世界の外かどうかである。
 */
function refusalFor(
  session: DragSession,
  snapshot: FeatureSnapshot,
  movingRings: readonly MovingRing[] | undefined,
): EditRefusalKind | null {
  if (longEdgeAfterMove(session, movingRings)) return EDIT_REFUSAL.LongDrag;
  for (const v of snapshot.vertices) {
    if (!isWorldLatitude(v.coordinate.lat)) return EDIT_REFUSAL.OutsideWorld;
  }
  return null;
}

/**
 * この移動で **保存できない長さの辺** ができるか。
 *
 * リングが渡されていれば、動く頂点にドラッグの変位を足した **結果の並び** を
 * `longEdgeStartIndexes`（追加の道具と同じ 1 本）に掛ける。渡されていなければ、
 * 1 回の移動量そのものが半周以上かどうかで粗く見る（それでも「意図が半周以上」は捕まる）。
 */
function longEdgeAfterMove(
  session: DragSession,
  movingRings: readonly MovingRing[] | undefined,
): boolean {
  const { dLon, dLat } = dragDelta(session);
  if (movingRings === undefined || movingRings.length === 0) {
    return Math.abs(dLon) >= MAX_EDGE_LON_SPAN_DEG;
  }
  for (const ring of movingRings) {
    if (ring.movingIndexes.length === 0) continue;
    const moving = new Set<number>(ring.movingIndexes);
    const after = ring.coordinates.map((c, i) =>
      moving.has(i) ? { lon: c.lon + dLon, lat: c.lat + dLat } : c,
    );
    if (longEdgeStartIndexes(after, ring.closed).length > 0) return true;
  }
  return false;
}

/**
 * 動かす前のリング 1 本を、**画面に見えているとおりの連続経度**で表したもの
 * （増分 3 の手直し 2 回目 / A5）。確定の関門はこれに移動量を足して、
 * **移動後の辺**が保存できる長さに収まるかを見る。
 *
 * **なぜ移動量だけでは足りないか**: 1 回の移動が 180 度未満でも、動かした先が隣の頂点から
 * 見て 180 度以上になれば、保存して読み直したときに別の形になる（実測: 160 度の移動で
 * 経度差 211.8 度の辺ができた）。**追加の道具と同じ 1 本**（`longEdgeStartIndexes`）で
 * 結果の辺そのものを見る。
 *
 * **なぜ「連続経度」でなければならないか**: 保存されている代表値のままだと、日付変更線を
 * またぐ正しい地物（179 度 → −179 度）が 358 度の差に見えて誤爆する。画面に見えている
 * 並び＝連続へ戻した列に対して測るのが、利用者の意図と一致する唯一の測り方である。
 */
export interface MovingRing {
  /** 動かす前の頂点の並び（連続経度）。添字は下の `movingIndexes` と対応する。 */
  readonly coordinates: readonly WorldCoordinate[];
  /** 面のリングなら真（最後の頂点から先頭へ戻る「閉じる辺」も数える）。線は偽。 */
  readonly closed: boolean;
  /** このドラッグで動く頂点の添字（空なら、このリングは移動の影響を受けない）。 */
  readonly movingIndexes: readonly number[];
}

export interface ReleaseInput<S> {
  readonly session: DragSession;
  /** The anchor time the edit confirms at (FR-59). */
  readonly anchorTime: TimePoint;
  /** The complete after-state snapshot for the touched feature (assembled by caller). */
  readonly snapshot: FeatureSnapshot;
  /** The current domain state to validate against. */
  readonly current: S;
  /** The U13 dependency ports (FR-61 pipeline). */
  readonly ports: ConsistencyPorts<S, FeatureSnapshot>;
  /**
   * Override the no-op decision (e.g. attribute-only edits where the gesture had
   * no move but the attribute changed). Default uses the drag {@link isNoOp}.
   */
  readonly forceChanged?: boolean;
  /**
   * 動かす前のリング（連続経度）と、そのうち動く頂点の添字（増分 3 の手直し 2 回目 / A5）。
   * 渡されていれば **移動後の辺そのもの**を見る。渡されていなければ（単体テストや、
   * リングを組み立てられない経路では）**1 回の移動量**で粗く見る ―― どちらも
   * `domain/geo/long-edge.ts` の同じ述語を通す。
   */
  readonly movingRings?: readonly MovingRing[];
}

/**
 * Confirm a release: run the no-op guard, then (if changed) assemble the proposal
 * and drive U13's fixed-order pipeline. The SINGLE confirm path (教訓5.26): the
 * full integrity check always goes through U13. Pure — U13 commits via its ports,
 * nothing is mutated here.
 */
export function confirmRelease<S>(input: ReleaseInput<S>): ReleaseOutcome<S> {
  const changed = input.forceChanged === true || !isNoOp(input.session);
  // No-op guard: a zero-move drag with no forced change does nothing (教訓5.24).
  if (!changed && input.snapshot.sharePair === undefined) {
    return { kind: RELEASE_OUTCOME.NoOp };
  }

  // 確定の関門（A5 / A6）。**記録する前**に見る（教訓 5.22 確定までの非破壊）。
  const refusal = refusalFor(input.session, input.snapshot, input.movingRings);
  if (refusal !== null) {
    return { kind: RELEASE_OUTCOME.Refused, reason: refusal };
  }

  const featureId = input.snapshot.deletedFeatureId ?? input.snapshot.feature?.id;
  if (featureId === undefined) {
    // A snapshot with neither a surviving feature nor a deletion id is malformed;
    // refuse to assemble a proposal rather than confirm an empty edit (教訓5.18).
    return { kind: RELEASE_OUTCOME.NoOp };
  }

  const proposal = createEditProposal(featureId, input.anchorTime, input.snapshot);
  const result = startProcess(input.current, proposal, input.ports);
  return { kind: RELEASE_OUTCOME.Processed, result, proposal };
}

// --- small helper: build a snapshot value (factory, never bare literal) -------

export { buildSnapshot, coordinatesEqual };
