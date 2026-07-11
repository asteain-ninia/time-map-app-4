// U41 public barrel — 表示制御 / 検索 / エラー処理・ログ / バリデーション / 文言集約.
//
// 横断の「発見・健全性・文言基盤」(FR-113 / FR-115 / FR-116 / FR-117 / FR-118)。
// 純粋ロジック (フィルター・検索・バリデーション・エラー変換・表示状態解決) は React /
// Canvas / Zustand に依存せず Vitest 単体でテスト可能 (技術方針 2.13, NFR 5.8).
// 描画への反映は表示状態 (visibility 解決・検索ハイライト) を購読する規約で、本ユニットは
// 描画ロジックを持たない (技術方針 2.3).

// axes (FR-113 / FR-34 / FR-38)
export {
  FILTER_AXIS,
  type FilterAxis,
  FEATURE_KIND_AXIS,
  type FeatureKindAxis,
  ALL_FEATURE_KIND_AXES,
  type DomainFeatureKind,
  kindAxisOf,
} from './axes';

// filter state (FR-113)
export {
  OPACITY_MIN,
  OPACITY_MAX,
  type IndividualOverride,
  type FilterState,
  DEFAULT_FILTER_STATE,
  setKindVisible,
  setDepthThreshold,
  setOpacity,
  setIndividualHidden,
  setEmphasizedIds,
  setEmphasizedKinds,
  setEmphasizedDepth,
  clearEmphasis,
  reconcileToLiveFeatures,
  emphasisActive,
} from './filter-state';

// the single display-state resolution (教訓 5.29)
export {
  type FeatureDisplayMeta,
  DIM_OPACITY_FACTOR,
  type ResolvedFeatureDisplay,
  resolveFeatureDisplay,
  resolveVisible,
  visibleIdSet,
} from './visibility';

// search (FR-113, 教訓 5.3 / 5.5)
export {
  type SearchableFeature,
  MATCH_FIELD,
  type MatchField,
  type SearchHit,
  type SearchResult,
  searchFeatures,
  reevaluateResult,
  highlightIds,
  JUMP_OUTCOME,
  type JumpOutcome,
  evaluateJump,
} from './search';

// sanitize 入口 (FR-116)
export { toSearchableText } from './sanitize';

// validation (FR-116, 教訓 5.26)
export {
  type ValidationResult,
  VALIDATION_REASON,
  type ValidationReason,
  validationMessage,
  MAX_QUERY_LENGTH,
  searchQuerySchema,
  type SearchQuery,
  validateSearchQuery,
  opacitySchema,
  type ValidOpacity,
  validateOpacity,
  depthThresholdSchema,
  type ValidDepth,
  validateDepthThreshold,
} from './validation';

// errors (FR-115 / FR-117, 教訓 5.6 / 5.12)
export {
  ERROR_ORIGIN,
  type ErrorOrigin,
  ERROR_SEVERITY,
  type ErrorSeverity,
  DISMISS_ON,
  type DismissOn,
  JUDGEMENT_DISMISS_TRIGGERS,
  type UserNotification,
  type ErrorInput,
  describeCause,
  buildUserMessage,
  handleError,
  handleRenderError,
  mayDismiss,
} from './errors';

// global handlers (FR-117, 教訓 5.6)
export {
  type ErrorEventTarget,
  type GlobalErrorHandlerOptions,
  installGlobalErrorHandlers,
  wrapEventHandler,
  wrapAsyncBoundary,
} from './global-handlers';

// production wiring for the global handlers (FR-117, 教訓 5.7)
export {
  type GlobalErrorWiringOptions,
  wireGlobalErrorHandlers,
} from './error-wiring';

// log + diagnostics (FR-117 / FR-02, 教訓 5.15 / 5.41)
export {
  LOG_LEVEL,
  type LogLevel,
  type LogContext,
  type LogEntry,
  type LogSink,
  type Clock,
  type DiagnosticLoggerOptions,
  DEFAULT_LOG_CAPACITY,
  DiagnosticLogger,
  type AppOverview,
  type DiagnosticsSnapshot,
  buildDiagnosticsSnapshot,
} from './log';

// diagnostic-log FILE SINK bridge + session marker (FR-117 / FR-02, 教訓 5.7 / 5.41)
export {
  SESSION_START_MESSAGE,
  type DiagnosticLogAppendApi,
  createDiagnosticLogSink,
  resolveDiagnosticLogSink,
  logSessionStart,
} from './log-sink';

// React error boundary (FR-117)
export {
  type ErrorBoundaryProps,
  ErrorBoundary,
} from './ErrorBoundary';

// adapters / boundary interfaces (教訓 5.33 / 5.34)
export {
  type FeatureReadModel,
  type ExistencePort,
  type JumpPort,
  toDisplayMeta,
  toSearchableFeature,
} from './adapters';

// strings (FR-115 / FR-118)
export {
  FILTER_STRINGS,
  SEARCH_STRINGS,
  VALIDATION_STRINGS,
  ERROR_HANDLING_STRINGS,
  DIAGNOSTICS_STRINGS,
} from './strings';
