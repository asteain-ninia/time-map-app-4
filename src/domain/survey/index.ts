// Survey-mode domain barrel (U37, FR-14 / FR-15 / FR-16).
//
// Pure, framework-free survey logic: lat/lon formatting (度分秒 + 十進),
// great-circle shortest-path interpolation, the two-point distance measurement
// adapter (delegating numbers to U04), and the survey-mode state machine. All
// run under Vitest in plain Node (受け入れ基準 6 / 開発ガイド §2.1). Import
// direction is inward only (domain depends on no other internal layer).

export {
  type CoordinateDisplay,
  type DmsParts,
  COMPASS,
  DECIMAL_PLACES,
  DMS_SECOND_PLACES,
  INVALID_VALUE_TEXT,
  representativeLon,
  formatLatDecimal,
  formatLonDecimal,
  formatLatDms,
  formatLonDms,
  toDmsParts,
  formatCoordinate,
} from './coords-format';

export {
  MAX_PATH_SEGMENTS,
  MIN_PATH_SEGMENTS,
  DEGREES_PER_SEGMENT,
  segmentCountForAngle,
  greatCirclePath,
  equirectangularPath,
} from './great-circle-path';

export { type SurveyMeasurement, measureSurveyPair } from './measure';

export {
  type SurveyPhase,
  type SurveyLine,
  type SurveyDraft,
  type SurveyState,
  SURVEY_PHASE,
  initialSurveyState,
  enableSurveyMode,
  disableSurveyMode,
  clickPoint,
  updateHover,
  cancelDraft,
  discardOnToolSwitch,
  clearSurvey,
} from './survey-state';
