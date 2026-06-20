// U28 — 所属変更フロー (割譲/連邦化/独立/帰属/直轄化/自治化/解体・単一フロー) の
// public barrel。純粋ドメインロジック (domain 層, 技術方針 2.13): 新上位領域の決定
// (判別共用体)、許可候補算出 + 確定前検証 (同一述語, 教訓 5.26)、編集案の組み立てと
// 自動消滅・参照掃除 (U31 委譲)・確定後整合性再検証 (U08 委譲)、単一アンドゥ単位の
// コマンド (FR-94)。Electron/React/Canvas に非依存。

export {
  PARENT_DECISION,
  type ParentDecisionKind,
  CREATE_TERMINAL,
  type CreateTerminalKind,
  type NewAggregateSpec,
  type ParentDecision,
  parentExisting,
  parentNone,
  parentCreate,
  parentCreateWithTerminal,
} from './decision';

export {
  AFFILIATION_REJECT,
  type AffiliationRejectKind,
  type LegalityVerdict,
  existencePeriodsCompatible,
  isLegalNewParent,
  type ParentCandidate,
  allowedParentCandidates,
} from './candidates';

export {
  AFFILIATION_STATUS,
  type AffiliationStatus,
  type AffiliationProposal,
  type AffiliationRejected,
  type ProposalResult,
  type BuildProposalOptions,
  resolveTargetLeaves,
  buildAffiliationProposal,
} from './proposal';

export {
  type AffiliationState,
  AFFILIATION_COMMAND_KIND,
  AFFILIATION_COMMAND_LABEL,
  createAffiliationCommand,
} from './command';

export {
  MSG_AFFILIATION_SAME,
  MSG_AFFILIATION_CYCLE,
  MSG_AFFILIATION_EXISTENCE,
  MSG_AFFILIATION_TARGET_MISSING,
  MSG_AFFILIATION_TARGET_KIND,
  MSG_AFFILIATION_HIERARCHY,
  MSG_AFFILIATION_INTERNAL,
  affiliationRejectMessage,
} from './messages';
