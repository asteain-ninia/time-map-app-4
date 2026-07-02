// U27 — the public穴あけ実行コマンド (spec §公開する主関数).
//
// `(現在状態相当の入力, 穴あけ入力) → 穴あけ結果` as ONE pure function with a
// discriminated result (成功 / 拒否), in the fixed order the spec mandates:
//   指定領域の妥当性検証 → U06 差演算による穴形成 → 新独立末端地物の生成 →
//   上位領域の初期継承 → (caller hands the proposal to U13 for 単一アンドゥ単位確定).
// Early return on the first rejection (spec §公開する主関数: 途中で拒否が出たら後続へ
// 進まず即座に拒否を返す).
//
// This unit STOPS at the assembled {@link DrillEditProposal} + the結果メタ (残る原末端
// id / 新地物 id / 継承親 id). The actual確定 (整合性維持プロセス起動・単一アンドゥ単位
// 記録) is U13's job: the caller adapts the proposal via `toEditProposal` and runs
// U13's `startProcess`. We do NOT re-implement the pipeline (spec §依存 U13 / 単一の
// 真実源). The result carries everything UI needs to再解決 selection (教訓5.11): the
// 形状変化して残る原末端 id and the新規生成された新地物 id.
//
// 対概念分離 (教訓2.10 / 5.25): a SUCCESS always produces a new feature id — there is
// NO success variant that omits the new feature (= "形状編集のみ"). That divergence
// from U25's形状編集 confirm path is fixed by the type below and by tests.

import { type WorldCoordinate } from '../coordinate';
import type { Feature, LeafFeature } from '../feature';
import { FEATURE_KIND } from '../feature';
import type { FeatureId } from '../ids';
import type { TimePoint } from '../time/time-point';
import type { VertexStore } from '../vertex';
import {
  checkDrillable,
  DRILL_CHECK_STATUS,
  DRILL_REJECT,
  type DrillRejectKind,
} from './drill-geometry';
import { drillRejectMessage } from './messages';
import {
  assembleDrillProposal,
  type DrillEditProposal,
  type DrillIdPorts,
  type NewFeatureProperties,
} from './proposal';

// ---------------------------------------------------------------------------
// 穴あけ入力 (spec §成果物 DrillInput 相当)
// ---------------------------------------------------------------------------

/**
 * The穴あけ入力 (spec §成果物). An immutable value: 対象元末端地物 + くり抜く指定領域
 * (閉じた頂点列) + 編集基準時刻 + the new feature's initial properties. The target is
 * typed {@link Feature} so an aggregate CAN be passed at the boundary (the UI may
 * hand whatever is selected) but is REJECTED in the command (FR-35 / 受け入れ7); the
 * caller never has to pre-filter.
 */
export interface DrillInput {
  /** The target feature (aggregate is rejected; only a leaf is drillable). */
  readonly target: Feature;
  /** The vertex store the target's shape resolves against. */
  readonly store: VertexStore;
  /** The designated region to carve (a closed ring of ≥3 vertices). */
  readonly region: readonly WorldCoordinate[];
  /** 編集基準時刻 = 現在選択時刻 (FR-57); the anchor time the edit confirms at. */
  readonly editBaseTime: TimePoint;
  /** The new feature's initial properties (name / color / kindLabel). */
  readonly newProperties: NewFeatureProperties;
  /** Injected id ports (pure & deterministic; redo replays recorded ids 教訓5.20). */
  readonly ids: DrillIdPorts;
}

// ---------------------------------------------------------------------------
// 穴あけ結果 (judgement; discriminated union — spec §成果物)
// ---------------------------------------------------------------------------

export const DRILL_STATUS = {
  Drilled: 'drilled',
  Rejected: 'rejected',
} as const;

export type DrillStatus = (typeof DRILL_STATUS)[keyof typeof DRILL_STATUS];

/**
 * SUCCESS: the assembled indivisible編集案 + the結果メタ for selection再解決 (教訓5.11)
 * + the編集基準時刻 the caller hands to U13. ALWAYS carries `newFeatureId` — there is
 * no shape-edit-only success (対概念分離). The caller turns `proposal` into a U13
 * `EditProposal` (via `toEditProposal`) and runs the整合性維持プロセス, which records
 * the whole change as 1 アンドゥ単位 (FR-94).
 */
export interface DrillSucceeded {
  readonly status: typeof DRILL_STATUS.Drilled;
  readonly proposal: DrillEditProposal;
  /** 形状変化して残る原末端地物 id (同一性保持; 教訓5.11). */
  readonly originalFeatureId: FeatureId;
  /** 新規生成された新地物 id (教訓5.11). */
  readonly newFeatureId: FeatureId;
  /** 新地物が初期継承した上位領域 id; `undefined` ⇔ 最上位 (FR-45 / FR-39). */
  readonly inheritedParentId: FeatureId | undefined;
  /** The編集基準時刻 to record the anchor at (FR-57). */
  readonly anchorTime: TimePoint;
}

/**
 * REJECT: a machine-readable kind AND a Japanese user-facing message (教訓5.26 /
 * FR-115). Nothing is assembled or mutated (教訓5.22 確定まで共有データを破壊しない).
 */
export interface DrillRejected {
  readonly status: typeof DRILL_STATUS.Rejected;
  readonly reason: DrillRejectKind;
  readonly message: string;
}

export type DrillResult = DrillSucceeded | DrillRejected;

function reject(reason: DrillRejectKind): DrillRejected {
  return { status: DRILL_STATUS.Rejected, reason, message: drillRejectMessage(reason) };
}

/**
 * 穴あけ実行 (spec §公開する主関数). Validate the designated region, form the hole via
 * U06 difference, generate the new independent terminal feature, initially inherit
 * the原末端's上位領域, and return the indivisible編集案 — or a typed rejection. Pure;
 * nothing is committed and `input.store` / `input.target` are never mutated
 * (教訓5.22). The caller hands `proposal` to U13 for単一アンドゥ単位確定 (FR-94).
 *
 * Always increases the feature count by exactly 1 on success (新地物を必ず生成する;
 * 対概念分離 FR-23 / 受け入れ3) — `newFeatureId` is always present.
 */
export function drillRegion(input: DrillInput): DrillResult {
  // Fixed order with early return (spec §公開する主関数).
  const check = checkDrillable(input.target, input.store, input.region);
  if (check.status !== DRILL_CHECK_STATUS.Drillable) {
    return reject(check.reason);
  }

  // checkDrillable already proved the target is a leaf; narrow for assembly.
  if (input.target.kind !== FEATURE_KIND.Leaf) {
    // Unreachable (checkDrillable rejects non-leaf first); guard for type safety.
    return reject(DRILL_REJECT.Internal);
  }
  const target: LeafFeature = input.target;

  const proposal = assembleDrillProposal({
    target,
    store: input.store,
    geometry: { holedOriginal: check.holedOriginal, newRegion: check.newRegion },
    newProperties: input.newProperties,
    ids: input.ids,
  });

  return {
    status: DRILL_STATUS.Drilled,
    proposal,
    originalFeatureId: proposal.originalFeatureId,
    newFeatureId: proposal.newFeature.id,
    inheritedParentId: proposal.inheritedParentId,
    anchorTime: input.editBaseTime,
  };
}
