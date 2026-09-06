// U37 — the survey chrome (FR-14 / FR-15 / FR-16 / FR-05 / FR-109).
//
// **増分 5a で 2 つに割った。** 元は 1 つの部品がアプリバー（上部バー）に居て、測量を
// ON にすると読み取り欄が生えてアプリバーの段が増え、**地図が縦に 87〜95px 縮んで
// いた**（現状分析 §1.3 / N-54。`e2e/option-bar.spec.ts` がその段増えを「いまの姿」
// として固定していたほどである）。設計書 §B.4 は「測量の道具を持っても地図は縮まない。
// 読み取りはオプションバーと状態行に出す」と定めているので、**アプリバーに残すのは
// 高さの変わらない入口だけ**にした。
//
//   - {@link SurveyControls}（アプリバー）: 測量モードの入口 1 個と、確定線の数の
//     隠し観測だけ。中身が変わっても占有幅が変わらないので、アプリバーの 32px は
//     どの局面でも動かない。編集できるかどうかで無効化しない（View でも測れる、
//     specs/U37 §2.1）。
//   - {@link SurveyMeasurementPanel}（オプションバーの設定欄）: クリア（FR-15 全消去。
//     確定線の数つき）／段階ごとの案内／FR-14 の 2 つの距離／FR-16 の座標。
//     **座標と表示形式の切替は「座標 ▾」ポップオーバーの中**へ入れた ―― 40px の帯に
//     度分秒と十進を 2 点ぶん並べると、いちばん大事な距離まで押し出されるためである
//     （設計書 §C.4 の「設定: 度分秒 ▾」がこれに当たる）。
//
// 距離と座標は `currentMeasurement` を `createGeoParams(projectSettings…)` の上で LIVE に
// 導出する（geo の 2 値を購読しているので、赤道長・扁平率を変えれば即座に計算し直す
// ＝FR-05 / FR-109、教訓 5.3 / 5.35: 表示は保存された真実から導出し、キャッシュしない）。
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
import { OptionPopover } from '../shell/OptionPopover';
import type { SessionStore } from '../state/store';

import { currentMeasurement } from './survey-batch';
import { SURVEY_STRINGS, formatDistanceKm } from './strings';

/** Which coordinate form(s) the readout shows (FR-16 切替; UI-local). */
type CoordFormat = 'both' | 'dms' | 'decimal';

export interface SurveyControlsProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
}

/**
 * アプリバーに残す入口（増分 5a）。**測量モードの入り口 1 個と、確定線の数の隠し観測だけ。**
 *
 * 中身が局面で変わらないので、アプリバーの高さ 32px も占有幅もどの状態でも動かない
 * （K-3。以前はここに読み取り欄まで載っていて、測量 ON で段が 1 つ増えていた）。
 */
export function SurveyControls<S>(props: SurveyControlsProps<S>): JSX.Element {
  const { store } = props;
  const survey = useStore(store, (s) => s.survey);

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

      {/* Hidden mirror of the confirmed-line count (E2E 観測フック — it holds NO
          truth, 技術方針 2.5; the app-active-feature marker pattern). **入口と一緒に
          残す** ―― 読み取り欄はオプションバーへ移ったが、観測はいつでも読めるほうが
          よい（測量を切ったあとに線が残っているかを確かめる spec がある）。 */}
      <span data-testid="survey-line-count" hidden>
        {survey.lines.length}
      </span>
    </div>
  );
}

export interface SurveyMeasurementPanelProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** 「座標 ▾」の開閉の報せ（`focusOwner` の導出。設計書 §D.1）。 */
  readonly onCoordsOpenChange?: (open: boolean) => void;
}

/**
 * オプションバーの設定欄に出す測量の読み取り（増分 5a / 設計書 §C.4 の「測る」の行）。
 *
 * **帯は高さ 40px 固定・`overflow: hidden`** なので、ここに何を入れても地図の矩形は
 * 動かない（K-3）。窓が狭いときに真っ先に削られるのは案内の文で、距離と操作は残る
 * （`.survey-controls__guide` が `flex: 1 1 0` の縮む役を引き受ける＝survey.css）。
 */
export function SurveyMeasurementPanel<S>(
  props: SurveyMeasurementPanelProps<S>,
): JSX.Element | null {
  const { store, onCoordsOpenChange } = props;
  const survey = useStore(store, (s) => s.survey);
  // Subscribe the two geo scalars individually (not the settings object) so this
  // panel re-renders only when the values it derives from actually change.
  const equatorLengthKm = useStore(store, (s) => s.projectSettings.equatorLengthKm);
  const flattening = useStore(store, (s) => s.projectSettings.flattening);
  // K-5「状態が移ったら閉じる」ための指紋（表示 ▾ / 深さ ▾ と同じ 4 つ）。
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const currentTime = useStore(store, (s) => s.currentTime);
  const projectLoadNonce = useStore(store, (s) => s.projectLoadNonce);

  const [format, setFormat] = useState<CoordFormat>('both');

  const geo = useMemo(
    () => createGeoParams(equatorLengthKm, flattening),
    [equatorLengthKm, flattening],
  );
  // Re-derived from the LIVE survey state + LIVE geo params on every render —
  // no cached distance can go stale on a settings change (教訓 5.3 / 5.35).
  const readout = useMemo(() => currentMeasurement(survey, geo), [survey, geo]);

  const showClear = survey.active || survey.lines.length > 0;
  // 測量に触っていないあいだは設定欄に 1 文字も出さない（帯の一等地を空で埋めない）。
  if (!showClear) return null;

  return (
    <div className="survey-controls survey-controls--bar" data-testid="survey-panel">
      <button
        type="button"
        className="survey-controls__clear"
        data-testid="survey-clear"
        onClick={() => store.getState().surveyClear()}
      >
        {SURVEY_STRINGS.clearLabel}（{survey.lines.length}）
      </button>

      {/* **案内の文はオプションバーの「次の一手」が出す**（増分 5 の手直し C3 /
          司令塔の決定 (4)）。ここは観測のミラーとして `hidden` で残す（T-2: 隠し観測は
          足す一方）。**見える形で残すと二重になる**うえ、案内の文は長いので設定欄の幅を
          丸ごと食い、「≫」の畳みが読み取りごと畳んでしまう（実測: 測っているのに距離が
          読めなくなった）。 */}
      {survey.active && (
        <span className="survey-controls__guide" data-testid="survey-guide" role="status" hidden>
          {survey.draft === null
            ? SURVEY_STRINGS.guideIdle
            : SURVEY_STRINGS.guideAwaitingEnd}
        </span>
      )}

      {/* 第6工程 (B2 fixed-occupancy): the readout is mounted from the moment survey
          mode turns ON (placeholder '—' values until something is measured), NOT when
          the first measurement appears. **増分 5a では帯そのものが高さ固定なので、
          この配慮は「途中で段が増えない」ためではなく「値が入っても幅が跳ねない」ため
          に残っている**（.survey-controls__distance の min-width がそれ）。 */}
      {(survey.active || readout !== null) && (
        <div className="survey-controls__readout" data-testid="survey-readout">
          <span className="survey-controls__distance" data-testid="survey-eq-distance">
            {SURVEY_STRINGS.equirectangularShort}:{' '}
            {readout !== null
              ? formatDistanceKm(readout.equirectangularKm)
              : SURVEY_STRINGS.noValue}
          </span>
          <span className="survey-controls__distance" data-testid="survey-gc-distance">
            {SURVEY_STRINGS.greatCircleShort}:{' '}
            {readout !== null
              ? formatDistanceKm(readout.greatCircleKm)
              : SURVEY_STRINGS.noValue}
          </span>
          {/* 座標と表示形式は「座標 ▾」の中（設計書 §C.4 の「度分秒 ▾」）。40px の帯に
              度分秒と十進を 2 点ぶん並べると距離まで押し出されるので畳んだ。 */}
          <OptionPopover
            label={SURVEY_STRINGS.coordsMenuLabel}
            buttonTestId="survey-coords-button"
            panelTestId="survey-coords-panel"
            buttonClassName="option-popover__button"
            panelClassName="option-popover__panel option-popover__panel--survey"
            ariaLabel={SURVEY_STRINGS.coordsMenuLabel}
            closeKey={`${mode}|${activeTool ?? ''}|${String(currentTime)}|${projectLoadNonce}`}
            {...(onCoordsOpenChange ? { onOpenChange: onCoordsOpenChange } : {})}
          >
            {() => (
              <>
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
                <span
                  className="survey-controls__format"
                  role="group"
                  aria-label={SURVEY_STRINGS.formatLabel}
                >
                  <FormatButton current={format} value="both" onSelect={setFormat} />
                  <FormatButton current={format} value="dms" onSelect={setFormat} />
                  <FormatButton current={format} value="decimal" onSelect={setFormat} />
                </span>
              </>
            )}
          </OptionPopover>
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
