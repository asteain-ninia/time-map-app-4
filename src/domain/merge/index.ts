// U30 — 合体 (結合) 機能の public barrel。純粋ドメインロジック (domain 層, 技術方針
// 2.13): 種別ごとの統合処理 (末端のみ / 集約のみ / 混在)、結合後の上位領域・プロパティ
// 決定の候補集合と適用、開始前・確定前の同一事前条件検証、不可分の単一アンドゥ単位
// コマンド、確定後の整合性維持 (U13) への編集案供給、共有頂点継続 (U11) の素材供給。
// Electron/React/Canvas に非依存。

export {
  MERGE_REJECT,
  type MergeRejectKind,
  type MergeVerdict,
  existsAtTime,
  isVerticallyRelated,
  validateMergePreconditions,
} from './precondition';

export {
  PARENT_DECISION,
  type ParentDecisionKind,
  type ParentDecision,
  type NewAggregateSpec,
  parentExisting,
  parentNone,
  parentCreate,
  parentCreateWithTerminal,
  CREATE_TERMINAL,
  type CreateTerminalKind,
  PROPERTY_DECISION,
  type PropertyDecisionKind,
  type MergedProperties,
  type PropertyDecision,
  propertyInherit,
  propertyNew,
  isTopLevelDecision,
} from './decision';

export {
  type MergeCandidate,
  allowedMergeParentCandidates,
  propertyInheritCandidates,
} from './candidates';

export {
  type MergeIdPorts,
  MERGE_KIND,
  type MergeKind,
  classifyMerge,
  MERGE_STATUS,
  type MergeStatus,
  type MergeProposal,
  type MergeRejected,
  type MergeProposalResult,
  type BuildMergeProposalInput,
  buildMergeProposal,
  type MergeSnapshot,
  toMergeSnapshot,
  toMergeEditProposal,
} from './proposal';

export {
  type MergeState,
  MERGE_COMMAND_KIND,
  MERGE_COMMAND_LABEL,
  createMergeCommand,
} from './command';

export {
  MSG_MERGE_TOO_FEW,
  MSG_MERGE_TARGET_MISSING,
  MSG_MERGE_NOT_PRESENT,
  MSG_MERGE_VERTICAL,
  MSG_MERGE_UNION_REJECTED,
  MSG_MERGE_INHERIT_SOURCE,
  MSG_MERGE_HIERARCHY,
  MSG_MERGE_INTERNAL,
  mergeRejectMessage,
} from './messages';
