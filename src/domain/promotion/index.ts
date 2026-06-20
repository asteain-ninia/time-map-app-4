// U29 — 末端→集約遷移 と 直轄領自動生成・集約地物の自動消滅 (FR-35 / FR-36 / FR-37 /
// FR-39 / FR-41 / FR-94) の public barrel。純粋ドメインロジック (domain 層, 技術方針
// 2.13): 末端→集約遷移 (同一性保持・属性引き継ぎ・形状破棄), 直轄領の差分算出 (U06 委譲)
// と複数領土リング (飛び地) 生成, 既定名称「<元名> 直轄領」+ ダイアログ上書き合成, 集約
// 地物の自動消滅 (結果状態判定 教訓 5.6) + 参照掃除 (U31 委譲), 不可分変換 + 確定前検証
// (U08 委譲) + 構造化結果 (選択再解決 教訓 5.11)。Electron/React/Canvas 非依存。

export {
  DIRECT_DOMAIN_NAME_SUFFIX,
  defaultDirectDomainName,
  directDomainName,
  type DirectDomainIdPorts,
  type BuiltDirectDomainShape,
  buildDirectDomainShape,
} from './direct-domain';

export {
  PROMOTION_STATUS,
  type PromotionStatus,
  PROMOTION_REJECT,
  type PromotionRejectKind,
  type PromotionOutcome,
  type PromotionCommitted,
  type PromotionNoOp,
  type PromotionRejected,
  type PromotionResult,
  type PromoteToAggregateInput,
  promoteLeafToAggregate,
  promoteFeature,
  emptiedAggregateIds,
  syncAggregateChildIds,
} from './promote';
