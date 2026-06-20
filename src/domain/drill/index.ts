// U27 — 穴あけによる新地物生成 (FR-45) public barrel. Pure domain layer
// (技術方針 2.13): the geometry validation + hole-formation (面ブーリアンは U06 へ委譲),
// the不可分編集案組み立て (U13 受け渡し), the public穴あけ実行コマンド, and the日本語拒否
// 文言。Render / UI consume these; the dependency direction stays inward to domain
// (no render/ui/shell imports here). 集約地物は穴あけ対象から除外 (FR-35 / 教訓5.25);
// 必ず新地物を 1 つ生成し対概念である形状編集 (U25) と別経路 (FR-23 / 教訓2.10)。

export {
  DRILL_REJECT,
  type DrillRejectKind,
  MIN_REGION_VERTICES,
  DRILL_CHECK_STATUS,
  type DrillCheckStatus,
  type DrillGeometry,
  type DrillCheckResult,
  checkDrillable,
  executeDrill,
} from './drill-geometry';

export { DRILL_REJECT_MESSAGE, drillRejectMessage } from './messages';

export {
  type NewFeatureProperties,
  type DrillIdPorts,
  type DrillEditProposal,
  type AssembleDrillInput,
  assembleDrillProposal,
  holedOriginalFeature,
  type DrillSnapshot,
  toDrillSnapshot,
  toEditProposal,
} from './proposal';

export {
  type DrillInput,
  DRILL_STATUS,
  type DrillStatus,
  type DrillSucceeded,
  type DrillRejected,
  type DrillResult,
  drillRegion,
} from './drill';
