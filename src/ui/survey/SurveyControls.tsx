// U37 — the survey topBar chrome (FR-14 / FR-15 / FR-16 / FR-05 / FR-109).
//
// Mounted in the shell's 上部バー beside 経度シフト / 表示階層 (a normal flow row —
// it never overlaps the map input layer, 教訓 5.14). It renders:
//   - the 測量モード toggle (a 補助モード on its OWN axis, specs/U37 §2.1): NOT
//     gated on editability — the survey works in View mode too;
//   - the クリア button (FR-15 全消去) with the confirmed-line count, shown while
//     survey is active OR lines remain (so lines left visible after survey OFF
//     can still be cleared);
//   - the per-phase guide text while active;
//   - the FR-14 / FR-16 readout: BOTH distances (正距円筒 + 大円) and BOTH
//     coordinate forms (度分秒 + 十進) for the current subject pair, derived LIVE
//     via `currentMeasurement` over `createGeoParams(projectSettings…)` — the geo
//     params are subscribed, so an equator-length / flattening change re-computes
//     the distances at once (FR-05 / FR-109, 教訓 5.3 / 5.35: derive display from
//     stored truth, never cache).
//
// The DMS/十進 switch is UI-local useState (FR-16 表示形式): pure presentation
// state that belongs to this component, not the store (二重真実源を作らない — the
// coordinate TRUTH stays in the readout; only which projection is SHOWN is local).
// All user-visible text comes from SURVEY_STRINGS (教訓 5.19).

import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { createGeoParams } from '../../domain/geo/geo-params';
import type { CoordinateDisplay } from '../../domain/survey/coords-format';
import type { SessionStore } from '../state/store';

import { currentMeasurement } from './survey-batch';
import { SURVEY_STRINGS, formatDistanceKm } from './strings';

/** Which coordinate form(s) the readout shows (FR-16 切替; UI-local). */
type CoordFormat = 'both' | 'dms' | 'decimal';

export interface SurveyControlsProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

export function SurveyControls<S>(props: SurveyControlsProps<S>): JSX.Element {
  const { store } = props;
  const survey = useStore(store, (s) => s.survey);
  // Subscribe the two geo scalars individually (not the settings object) so this
  // panel re-renders only when the values it derives from actually change.
  const equatorLengthKm = useStore(store, (s) => s.projectSettings.equatorLengthKm);
  const flattening = useStore(store, (s) => s.projectSettings.flattening);

  const [format, setFormat] = useState<CoordFormat>('both');

  const geo = useMemo(
    () => createGeoParams(equatorLengthKm, flattening),
    [equatorLengthKm, flattening],
  );
  // Re-derived from the LIVE survey state + LIVE geo params on every render —
  // no cached distance can go stale on a settings change (教訓 5.3 / 5.35).
  const readout = useMemo(() => currentMeasurement(survey, geo), [survey, geo]);

  const showClear = survey.active || survey.lines.length > 0;

  return (
    <div className="survey-controls" data-testid="survey-controls">
      <button
        type="button"
        className="survey-controls__toggle"
        data-testid="survey-toggle"
        aria-pressed={survey.active}
        onClick={() => {
          if (survey.active) {
            store.getState().surveyDisable();
          } else {
            store.getState().surveyEnable();
          }
        }}
      >
        {SURVEY_STRINGS.modeLabel}
      </button>

      {showClear && (
        <button
          type="button"
          className="survey-controls__clear"
          data-testid="survey-clear"
          onClick={() => store.getState().surveyClear()}
        >
          {SURVEY_STRINGS.clearLabel}（{survey.lines.length}）
        </button>
      )}

      {/* Hidden mirror of the confirmed-line count (E2E 観測フック — it holds NO
          truth, 技術方針 2.5; the app-active-feature marker pattern). */}
      <span data-testid="survey-line-count" hidden>
        {survey.lines.length}
      </span>

      {survey.active && (
        <span className="survey-controls__guide" data-testid="survey-guide" role="status">
          {survey.draft === null
            ? SURVEY_STRINGS.guideIdle
            : SURVEY_STRINGS.guideAwaitingEnd}
        </span>
      )}

      {/* 第6工程 (B2 fixed-occupancy): the readout is mounted from the moment survey
          mode turns ON (placeholder '—' values until something is measured), NOT when
          the first measurement appears. Mount-on-measure made the 上部バー's occupied
          size jump MID-GESTURE (the hover after the first click mounted this whole
          block → the menu-bar row re-wrapped → the map cell shifted → the second
          click landed on the wrong world point; 世界端跨ぎ e2e). The 上部バー's
          occupancy may change on the EXPLICIT mode toggle, never from measurement
          state; the CSS min-widths on guide/distance/coord fix each row's box across
          content / format changes. After survey OFF the readout stays only while a
          measured value remains (確定線, FR-15). */}
      {(survey.active || readout !== null) && (
        <div className="survey-controls__readout" data-testid="survey-readout">
          <span className="survey-controls__title">{SURVEY_STRINGS.panelTitle}</span>
          <span className="survey-controls__distance" data-testid="survey-eq-distance">
            {SURVEY_STRINGS.equirectangularLabel}:{' '}
            {readout !== null
              ? formatDistanceKm(readout.equirectangularKm)
              : SURVEY_STRINGS.noValue}
          </span>
          <span className="survey-controls__distance" data-testid="survey-gc-distance">
            {SURVEY_STRINGS.greatCircleLabel}:{' '}
            {readout !== null
              ? formatDistanceKm(readout.greatCircleKm)
              : SURVEY_STRINGS.noValue}
          </span>
          <CoordinateReadout
            label={SURVEY_STRINGS.startPointLabel}
            testId="survey-start"
            display={readout !== null ? readout.startDisplay : null}
            format={format}
          />
          <CoordinateReadout
            label={SURVEY_STRINGS.endPointLabel}
            testId="survey-end"
            display={readout !== null ? readout.endDisplay : null}
            format={format}
          />
          <span className="survey-controls__format" role="group" aria-label={SURVEY_STRINGS.formatLabel}>
            <FormatButton current={format} value="both" onSelect={setFormat} />
            <FormatButton current={format} value="dms" onSelect={setFormat} />
            <FormatButton current={format} value="decimal" onSelect={setFormat} />
          </span>
        </div>
      )}
    </div>
  );
}

// --- One endpoint's lat/lon in the selected form(s) (FR-16) -------------------

function CoordinateReadout(props: {
  readonly label: string;
  readonly testId: string;
  /** `null` = nothing measured yet — placeholder dashes (fixed occupancy, B2). */
  readonly display: CoordinateDisplay | null;
  readonly format: CoordFormat;
}): JSX.Element {
  const { label, testId, display, format } = props;
  return (
    <span className="survey-controls__coord">
      <span className="survey-controls__coord-label">{label}</span>
      {(format === 'both' || format === 'dms') && (
        <span data-testid={`${testId}-dms`}>
          {display !== null
            ? `${display.latDms} / ${display.lonDms}`
            : SURVEY_STRINGS.noValue}
        </span>
      )}
      {(format === 'both' || format === 'decimal') && (
        <span data-testid={`${testId}-decimal`}>
          {display !== null
            ? `${display.latDecimal} / ${display.lonDecimal}`
            : SURVEY_STRINGS.noValue}
        </span>
      )}
    </span>
  );
}

const FORMAT_LABEL: Record<CoordFormat, string> = {
  both: SURVEY_STRINGS.formatBoth,
  dms: SURVEY_STRINGS.formatDms,
  decimal: SURVEY_STRINGS.formatDecimal,
};

function FormatButton(props: {
  readonly current: CoordFormat;
  readonly value: CoordFormat;
  readonly onSelect: (format: CoordFormat) => void;
}): JSX.Element {
  const { current, value, onSelect } = props;
  return (
    <button
      type="button"
      data-testid={`survey-format-${value}`}
      aria-pressed={current === value}
      onClick={() => onSelect(value)}
    >
      {FORMAT_LABEL[value]}
    </button>
  );
}
