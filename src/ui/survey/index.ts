// Survey-mode UI/operation barrel (U37, FR-14 / FR-15 / FR-16).
//
// The UI/operation side of the survey mode: Japanese text + distance formatting,
// and the render-batch builder that composes the pure survey state (domain) into
// declarative MapRenderer primitives (U17). The pure survey LOGIC (state machine,
// formatting, great-circle interpolation, distance adapter) lives in
// `domain/survey` and is re-exported there.

export { SURVEY_STRINGS, formatDistanceKm } from './strings';

export {
  type SurveyStyle,
  type SurveyReadout,
  DEFAULT_SURVEY_STYLE,
  confirmedLinePrimitives,
  draftPrimitives,
  buildSurveyPrimitives,
  currentMeasurement,
} from './survey-batch';
