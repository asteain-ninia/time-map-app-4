// U36 context menu — public barrel.
//
// The right-click coordination unit (FR-96): a PURE composition that derives
// "which items, in which state" from the current selection / object kind / tool
// kind / edit permission (compose.ts), and a PURE dispatch that maps a chosen
// item to ONE launch intent for an existing flow (U11/U26/U28/U30/U31) or
// "open property editor" (dispatch.ts). This unit re-implements no flow body and
// runs no consistency process — it only wires the right-click path to the SAME
// flows the UI buttons use (spec §1, 教訓 5.6). Framework-free (技術方針 2.13).

// Layer-crossing contracts: tool kind, flow intents, injected lookups.
export {
  MENU_TOOL_KIND,
  type MenuToolKind,
  FLOW_KIND,
  type FlowKind,
  type DispatchIntent,
  FEATURE_KIND,
  type FeatureKind,
  type SharedVertexLookup,
  sharedLookupFromSet,
  type FeatureKindLookup,
  featureKindLookupFromMap,
} from './contracts';

// Item kinds, Japanese labels, disable reasons, item value (FR-115, 教訓 5.19).
export {
  MENU_ITEM_KIND,
  type MenuItemKind,
  ITEM_FLOW,
  MENU_ITEM_LABEL,
  DISABLE_REASON,
  type DisableReason,
  DISABLE_REASON_MESSAGE,
  type ContextMenuItem,
  enabledItem,
  disabledItem,
} from './items';

// The pure composition + resolved target + model.
export {
  type MenuPosition,
  type ComposeInput,
  MENU_TARGET_KIND,
  type MenuTargetKind,
  type MenuTarget,
  resolveMenuTarget,
  NO_MENU,
  type NoMenu,
  type ContextMenuModel,
  composeContextMenu,
} from './compose';

// The pure dispatch (chosen item → flow intent) + blocked outcomes.
export {
  DISPATCH_BLOCKED_KIND,
  type DispatchBlockedKind,
  type DispatchBlocked,
  type DispatchResult,
  isBlocked,
  dispatchMenuItem,
  vertexOnlyOwner,
} from './dispatch';

// Rejection-message bridging (FR-115 / FR-117, 教訓 5.12).
export {
  type RejectionNotice,
  MSG_INTERNAL_INCONSISTENCY,
  flowRejection,
  internalInconsistency,
  disableReasonMessage,
} from './messages';

// Structure-change → U22 selection re-resolution bridge (受け入れ基準 12, 教訓 5.11).
export {
  type ReresolveBridge,
  nextTargetPreferenceFor,
  bridgeReresolve,
} from './reresolve-bridge';
