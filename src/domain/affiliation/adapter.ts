// U28 — 所属変更編集案を U13 (整合性維持プロセス) へ接続する型付きアダプタ
// (spec §依存 U13 / スコープ項目 7 / 受け入れ基準 5, 教訓 5.33 / 5.34 両側型固定).
//
// U28 は所属変更固有の事前条件 (循環・存在期間・対象種別) を検証し「所属変更編集案」
// (AffiliationProposal) を組み立てるところまでを担う。確定 (時間整合性検証 → 空間
// 競合検出 → 競合解決 → 1 アンドゥ単位の一括確定) は U13 の固定順序プロセスへ委譲する
// (本ユニットは時間整合性検証・空間競合検出・アンドゥスタックを自前実装しない)。
//
// 本 module は U28 → U13 の層をまたぐ契約を **型と両側テスト** で固定する:
//   - 状態スナップショット `S` = 面情報集合 (readonly Feature[])。U13 はこれを不透明値
//     として ports 経由でスレッドする (U13 は中身を読まない)。
//   - AffiliationProposal を U13 の EditProposal<Snapshot> (featureId / anchorTime /
//     snapshot) へ写像する。snapshot には確定後の面情報集合 (proposal.nextFeatures)
//     を載せ、applyProposal は「編集案を適用した結果状態」をそのまま返す (再採番なし,
//     教訓 5.20)。
//   - 空間競合 (末端同士の重なり) の検出・解決は U13 (U10/U06 port) に委譲する。U28 は
//     spatial port を注入される側で、自前で空間判定をしない (スコープ項目 7)。
//
// これにより「所属変更コマンドが U13 を迂回して確定される」経路を塞ぐ: 確定したい
// 呼び出し側は本アダプタ (startAffiliationProcess) を通り、必ず U13 の固定順序
// パイプライン (時間整合性 → 編集制約 → 空間競合) を経由する。

import type { Feature } from '../feature';
import type { FeatureId } from '../ids';
import type { TimePoint } from '../time/time-point';
import {
  createEditProposal,
  type ConsistencyPorts,
  type EditProposal,
} from '../consistency/types';
import { startProcess } from '../consistency/orchestrator';
import type { ProcessResult } from '../consistency/types';
import { createAffiliationCommand } from './command';
import type { AffiliationProposal } from './proposal';

/** U13 へ渡す状態スナップショット型: 面情報集合 (U03/U08 のフル状態の最小形)。 */
export type AffiliationSnapshot = readonly Feature[];

/**
 * 所属変更編集案を U13 の {@link EditProposal} へ写像する (型付きアダプタ, 教訓 5.34)。
 *
 * - `featureId`: 編集案が触れる代表地物。展開後の末端対象の先頭を錨とする (対象群は
 *   touched 集合として U13 の makeCommand へ伝わる)。対象が空の編集案は組み立て時に
 *   拒否されるため、ここでは必ず 1 件以上存在する。
 * - `anchorTime`: 確定する対象時刻 (呼び出し側が当該錨の時刻を渡す)。
 * - `snapshot`: 編集案を適用した確定後の面情報集合 (proposal.nextFeatures)。U13 は
 *   これを不透明値として扱い、applyProposal がそのまま結果状態として返す。
 */
export function toEditProposal(
  proposal: AffiliationProposal,
  anchorTime: TimePoint,
): EditProposal<AffiliationSnapshot> {
  const first = proposal.targetIds[0];
  if (first === undefined) {
    // 編集案組み立てが空対象を拒否するため到達不能。型のために防御する。
    throw new Error('affiliation proposal has no target');
  }
  return createEditProposal<AffiliationSnapshot>(first, anchorTime, proposal.nextFeatures);
}

/**
 * 確定対象の全 touched 地物 ID (新規 + 存続 + 削除)。U13 の makeCommand へ渡し、
 * execute/undo/redo が対称に通知できるようにする (教訓 5.23)。
 */
export function affiliationTouchedIds(proposal: AffiliationProposal): readonly FeatureId[] {
  const set = new Set<FeatureId>();
  for (const id of proposal.targetIds) set.add(id);
  for (const id of proposal.createdIds) set.add(id);
  for (const id of proposal.deletedIds) set.add(id);
  for (const id of proposal.survivedTouchedIds) set.add(id);
  return [...set];
}

/**
 * U28 の ports 既定実装の一部を組み立てる補助。所属変更編集案は「結果状態」を完全に
 * 内包するため、applyProposal は snapshot をそのまま返す (再適用＝再採番なし, 教訓
 * 5.20)。makeCommand は単一アンドゥ単位の所属変更コマンドを返す。
 *
 * 時間整合性 (checkTime) / 編集制約 (checkConstraints) / 空間競合 (detectSpatial) /
 * 競合解決 (applyResolution) は U09/U10/U06 が供給する port を呼び出し側が注入する。
 * U28 はそれらを自前実装しない (スコープ項目 7): 本ヘルパは「編集案を結果状態として
 * 適用し、確定を 1 アンドゥ単位に包む」U28 固有の 2 port だけを供給する。
 */
export interface AffiliationPortOverrides<S> {
  readonly checkTime: ConsistencyPorts<S, AffiliationSnapshot>['checkTime'];
  readonly checkConstraints: ConsistencyPorts<S, AffiliationSnapshot>['checkConstraints'];
  readonly detectSpatial: ConsistencyPorts<S, AffiliationSnapshot>['detectSpatial'];
  readonly applyResolution: ConsistencyPorts<S, AffiliationSnapshot>['applyResolution'];
}

/**
 * 所属変更用の {@link ConsistencyPorts} を組み立てる。状態型 `S` = 面情報集合。
 * applyProposal/makeCommand は U28 が供給し、空間・時間・制約 port は注入する。
 */
export function makeAffiliationPorts(
  baseline: AffiliationSnapshot,
  proposal: AffiliationProposal,
  overrides: AffiliationPortOverrides<AffiliationSnapshot>,
): ConsistencyPorts<AffiliationSnapshot, AffiliationSnapshot> {
  const command = createAffiliationCommand(baseline, proposal);
  return {
    // 編集案は結果状態を内包する: 適用は snapshot をそのまま返す (再採番なし)。
    applyProposal: (_current, p) => p.snapshot,
    checkTime: overrides.checkTime,
    checkConstraints: overrides.checkConstraints,
    detectSpatial: overrides.detectSpatial,
    applyResolution: overrides.applyResolution,
    // 単一アンドゥ単位: U28 の確定コマンドをそのまま 1 コマンドとして返す (FR-94)。
    makeCommand: () => command,
  };
}

/**
 * 所属変更編集案を U13 の固定順序プロセスへ流して確定する (公開する主関数: 確定)。
 *
 * U13 の {@link startProcess} を経由するため、確定前に必ず 時間整合性 (U09) → 編集制約
 * → 空間競合検出 (U10) が固定順序で走り、空間競合があれば `conflicts-pending` を返す
 * (U13 へ委譲, スコープ項目 7)。競合なしなら 1 アンドゥ単位の所属変更コマンドとともに
 * `committed` を返す。これにより所属変更が U13 を迂回して確定される経路を塞ぐ。
 */
export function startAffiliationProcess(
  baseline: AffiliationSnapshot,
  proposal: AffiliationProposal,
  anchorTime: TimePoint,
  overrides: AffiliationPortOverrides<AffiliationSnapshot>,
): ProcessResult<AffiliationSnapshot> {
  const ports = makeAffiliationPorts(baseline, proposal, overrides);
  const editProposal = toEditProposal(proposal, anchorTime);
  return startProcess(baseline, editProposal, ports);
}
