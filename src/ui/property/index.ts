// Property-panel UI — public barrel.
//
// U31 owns the "地物を削除" button + confirmation dialog (FR-85). U32 owns the
// property panel itself (FR-83 / FR-97), the anchor list + 時間バー切替 (FR-84 /
// FR-60), the draggable・複数同時 modal detail panels (FR-99), and the
// markdown-it + DOMPurify detail-document renderer (FR-98). Both share this
// directory; this barrel re-exports both units' public surface.

// --- U31: delete control (FR-85) -------------------------------------------
export {
  DELETE_BUTTON_LABEL,
  type DeleteFeatureButtonProps,
  DeleteFeatureButton,
} from './DeleteFeatureButton';

// --- U32: property panel + anchor views + detail panels + markdown ---------

// Components
export { PropertyPanel, type PropertyPanelProps } from './PropertyPanel';
export { BasicInfoForm, type BasicInfoFormProps } from './BasicInfoForm';
export {
  AnchorSection,
  type AnchorSectionProps,
  ANCHOR_VIEW_MODE,
  type AnchorViewMode,
} from './AnchorSection';
export { AnchorList, type AnchorListProps } from './AnchorList';
export {
  AnchorTimeBar,
  type AnchorTimeBarProps,
  DEFAULT_TIMEBAR_PIXELS,
} from './AnchorTimeBar';
export { DetailPanel, type DetailPanelProps } from './DetailPanel';
export {
  DetailPanels,
  type DetailPanelsProps,
  type DetailPanelsController,
  closeDetailPanel,
} from './DetailPanels';
export { MarkdownView, type MarkdownViewProps } from './MarkdownView';

// Contracts (the ports U32 consumes)
export type {
  FeatureLookup,
  AnchorSeriesLookup,
  AssetResolver,
  EditDispatch,
  PropertyEditIntent,
  PropertyEditValues,
  AnchorIntervalEditDispatch,
  AnchorIntervalEditIntent,
  AnchorIntervalOp,
} from './contracts';
export { ANCHOR_INTERVAL_OP } from './contracts';

// Pure logic: selection-display judgment (FR-83, 教訓 5.10 / 5.29)
export {
  DISPLAY_KIND,
  type DisplayKind,
  type DisplayDecision,
  type RawSelectionInput,
  decideDisplay,
  targetFeatureIdOf,
} from './selection-display';

// Pure logic: object-reference link classification (FR-98, 教訓 5.19)
export {
  OBJECT_LINK_SCHEME,
  LINK_KIND,
  type LinkKind,
  type ClassifiedLink,
  classifyLink,
  objectLinkHref,
} from './object-link';

// Pure logic: markdown render + sanitize (FR-98 / FR-116)
export {
  renderDetailMarkdown,
  type RenderOptions,
  BROKEN_IMAGE_SRC,
} from './markdown';

// Pure logic: 時間バー mapping (FR-60)
export {
  type TimeBarView,
  type BarSegment,
  MIN_VIEW_DAYS,
  ZOOM_STEP,
  LABEL_MIN_OCCUPANCY,
  viewFromTimePoints,
  viewSpanDays,
  timeToPixel,
  normalizedToPixel,
  pixelToTime,
  viewMinTime,
  viewMaxTime,
  barSegment,
  shouldShowLabel,
  zoomView,
} from './timebar';

// Pure logic: open-detail-panels model (FR-99後段)
export {
  type DetailPanelEntry,
  type DetailPanelsState,
  EMPTY_DETAIL_PANELS,
  DETAIL_PANEL_CASCADE_PX,
  panelIdFor,
  openPanel,
  closePanel,
  isPanelOpen,
} from './detail-panels';

// Pure logic: edit-intent + no-op guard (FR-97 / FR-84, 教訓 5.24 / 5.15)
export { valuesFromFeature, isNoOpEdit, buildEditIntent } from './edit-intent';

// Pure logic: 存続期間編集 intent assembly + rejection messaging (HB3-12, 教訓 5.26)
export {
  buildChangeStartIntent,
  buildSetEndIntent,
  buildDeleteAnchorIntent,
  yearToTimePoint,
  intervalRejectionMessage,
} from './interval-edit';

// Strings + 種別の日本語表示ラベル (表示層の単一写像, 要件定義書 §4)
export { PROPERTY_STRINGS, featureKindJaLabel } from './messages';
