// UI layer (U21 / 時刻レール): 操作列（設計書 §C.7 の (d) / §B.4 の畳みの表）。
//
// **±1 の送りと再生の文字・読み上げ名は現行のまま残す**（設計書 §O の B-7）。
// `e2e/ux-cluster.spec.ts` の HB-13 が固定しているのは寸法だけではなく、可視テキスト
// 「次へ」「前へ」「再生」と読み上げ名「1年次へ進む」「1年前へ戻る」「再生」、そして
// 「ステップ単位」の `select` の実在である。10・100 の送りは **別のボタン**として足すので、
// 条文（FR-68「ステップ値は常に 1 単位」）にもテストにも触れない。
//
// **畳みは窓幅だけで決まる**（`rail-fold.ts`）。中身の量では決まらないので、教訓 5.69 の
// 「畳む → 器が縮む → もっと畳む」の輪が起きない。各まとまりの幅は `rail-fold.ts` の
// 見積りと **同じ数を CSS で嵌める**ので、教訓 5.74 の「予算と実寸がずれる」も起きない。

import { useEffect, useRef, useState } from 'react';

import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';
import { OptionPopover } from '../shell/OptionPopover';
import { RAIL_FOLD, railGroupsAt, type RailFoldLevel } from '../time/rail-fold';

import { RAIL_STRINGS } from './rail-strings';
import { STEP_UNIT, type StepDirection, type StepUnit } from './step';
import { useLongPress } from './useLongPress';
import type { PlaybackController } from './usePlayback';
import { PLAYBACK_SPEEDS, type PlaybackSpeed } from './playback';
import {
  draftFromTimePoint,
  parseYmdDraft,
  ymdErrorMessage,
  type YmdDraft,
} from './ymd-draft';

const UNIT_LABELS: Readonly<Record<StepUnit, string>> = {
  [STEP_UNIT.Year]: '年',
  [STEP_UNIT.Month]: '月',
  [STEP_UNIT.Day]: '日',
};

export interface RailControlsProps {
  readonly fold: RailFoldLevel;
  /** 送り。`amount` は 1 / 10 / 100。 */
  readonly onStep: (unit: StepUnit, direction: StepDirection, amount: number) => void;
  readonly playback: PlaybackController;
  /** 年月日の欄の初期値（現在時刻）。**打ちかけがあるあいだは上書きしない**（中身 6）。 */
  readonly currentTime: TimePoint;
  /** 月日の検証に使う暦（U02）。 */
  readonly calendar: Calendar;
  /** 時刻を確定する。断られたら理由の文が返る（範囲外は丸めない＝中身 7）。 */
  readonly onJumpTime: (point: TimePoint) => string | null;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomFit: () => void;
  readonly onPrevAnchor: () => void;
  readonly onNextAnchor: () => void;
  /** 増えるたびに年入力へ焦点を入れる（Ctrl+G）。 */
  readonly focusYearSignal: number;
  /** ポップオーバーの開閉（鍵盤の持ち主の導出に使う）。 */
  readonly onPopoverOpenChange?: (open: boolean) => void;
  /** ポップオーバーを閉じる契機の指紋（`OptionPopover` の作法 4）。 */
  readonly closeKey: string;
}

export function RailControls(props: RailControlsProps): JSX.Element {
  const {
    fold,
    onStep,
    playback,
    currentTime,
    calendar,
    onJumpTime,
    onZoomIn,
    onZoomOut,
    onZoomFit,
    onPrevAnchor,
    onNextAnchor,
    focusYearSignal,
    onPopoverOpenChange,
    closeKey,
  } = props;

  const [unit, setUnit] = useState<StepUnit>(STEP_UNIT.Year);
  const unitLabel = UNIT_LABELS[unit];

  const shown = new Set(railGroupsAt(fold).map((g) => g.id));

  // --- 年入力（打ちかけを他経路の時刻変更で消さない＝中身 6） -----------------
  //
  // 旧実装は現在時刻を `key` にして入力欄を **作り直して**いた。だから再生・つまみ・
  // 錨の選択で時刻が動くたびに、打っている途中の数字が消えた（教訓 5.2 の「捨てる」は
  // 一時状態の話で、**利用者が打っている最中の文字**はそれに当たらない ―― 設計書 §D.7 の
  // 「打ちかけの文字も確認してから捨てる」と同じ立場）。ここでは作り直さず、
  // **打ちかけが無いときだけ**現在の年に追従する。
  const [draft, setDraft] = useState<YmdDraft>(() => draftFromTimePoint(currentTime));
  const [dirty, setDirty] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const yearRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (dirty) return;
    setDraft(draftFromTimePoint(currentTime));
  }, [currentTime, dirty]);

  /** 打ちかけを 1 つ書き換える（書いた瞬間から「打ちかけあり」になる）。 */
  const patch = (next: Partial<YmdDraft>): void => {
    setDraft((prev) => ({ ...prev, ...next }));
    setDirty(true);
    setRefusal(null);
  };

  useEffect(() => {
    if (focusYearSignal <= 0) return;
    yearRef.current?.focus();
    yearRef.current?.select();
  }, [focusYearSignal]);

  const confirmYear = (): void => {
    // 文字 → 完全な時刻の変換は **共有の 1 本**（`ymd-draft.ts`）を通す。素性欄の
    // 存続期間の欄と同じ規則で読む（教訓 5.44: 写しを作らない）。
    const parsed = parseYmdDraft(draft, calendar);
    if (!parsed.ok) {
      setRefusal(ymdErrorMessage(parsed.error));
      return;
    }
    const message = onJumpTime(parsed.point);
    setRefusal(message);
    if (message === null) setDirty(false);
  };

  // --- まとまりごとの描画（行にも「≫」の中にも同じものを出す） ---------------
  const step100 = (
    <div className="rail__group rail__group--step100" data-testid="rail-step-100" key="step100">
      <StepButton
        label="◀100"
        ariaLabel={RAIL_STRINGS.step100BackLabel}
        onStep={() => onStep(unit, -1, 100)}
      />
      <StepButton
        label="100▶"
        ariaLabel={RAIL_STRINGS.step100ForwardLabel}
        onStep={() => onStep(unit, 1, 100)}
      />
    </div>
  );

  const step10 = (
    <div className="rail__group rail__group--step10" data-testid="rail-step-10" key="step10">
      <StepButton
        label="◀10"
        ariaLabel={RAIL_STRINGS.step10BackLabel}
        onStep={() => onStep(unit, -1, 10)}
      />
      <StepButton
        label="10▶"
        ariaLabel={RAIL_STRINGS.step10ForwardLabel}
        onStep={() => onStep(unit, 1, 10)}
      />
    </div>
  );

  const unitGroup = (
    <label className="rail__group rail__unit" data-testid="rail-unit" key="unit">
      <span className="rail__unit-caption">ステップ単位</span>
      <select
        aria-label="ステップ単位"
        title="前へ/次へ で動かす時間の単位"
        value={unit}
        onChange={(e) => setUnit(e.target.value as StepUnit)}
      >
        {Object.values(STEP_UNIT).map((u) => (
          <option key={u} value={u}>
            {UNIT_LABELS[u]}
          </option>
        ))}
      </select>
    </label>
  );

  /**
   * 月日 ▾（直接ジャンプの月日）。**読み上げ名は現行のまま持ち越す**
   * （「直接ジャンプ 月」「直接ジャンプ 月 未指定」「直接ジャンプ 日」「直接ジャンプ 日 未指定」）。
   * 月日は **既定では使えない**（未指定）―― 月日を勝手に補わない（U-14）。
   */
  const ymdGroup = (
    <div className="rail__group rail__ymd" data-testid="rail-ymd" key="ymd">
      <OptionPopover
        label="月日"
        buttonTestId="rail-ymd-button"
        panelTestId="rail-ymd-panel"
        buttonClassName="rail__button rail__button--icon"
        panelClassName="rail__popover"
        ariaLabel="直接ジャンプの月日"
        closeKey={closeKey}
        {...(onPopoverOpenChange ? { onOpenChange: onPopoverOpenChange } : {})}
      >
        {() => (
          <div className="rail__popover-row">
            <label className="rail__ymd-field">
              <span>月</span>
              <input
                type="number"
                aria-label={`${RAIL_STRINGS.jumpFieldTitle} 月`}
                value={draft.monthText}
                disabled={!draft.monthSpecified}
                onChange={(e) => patch({ monthText: e.target.value })}
              />
              <button
                type="button"
                aria-pressed={!draft.monthSpecified}
                aria-label={`${RAIL_STRINGS.jumpFieldTitle} 月 未指定`}
                onClick={() =>
                  patch(
                    draft.monthSpecified
                      ? { monthSpecified: false, daySpecified: false }
                      : { monthSpecified: true },
                  )
                }
              >
                {draft.monthSpecified ? '指定' : '未指定'}
              </button>
            </label>
            <label className="rail__ymd-field">
              <span>日</span>
              <input
                type="number"
                aria-label={`${RAIL_STRINGS.jumpFieldTitle} 日`}
                value={draft.dayText}
                disabled={!draft.monthSpecified || !draft.daySpecified}
                onChange={(e) => patch({ dayText: e.target.value })}
              />
              <button
                type="button"
                aria-pressed={!draft.daySpecified}
                aria-label={`${RAIL_STRINGS.jumpFieldTitle} 日 未指定`}
                disabled={!draft.monthSpecified}
                onClick={() =>
                  patch(draft.daySpecified ? { daySpecified: false } : { daySpecified: true })
                }
              >
                {draft.daySpecified ? '指定' : '未指定'}
              </button>
            </label>
          </div>
        )}
      </OptionPopover>
    </div>
  );

  const anchorJump = (
    <div className="rail__group" data-testid="rail-anchor-jump" key="anchorJump">
      <button
        type="button"
        className="rail__button"
        data-testid="rail-prev-anchor"
        aria-label={RAIL_STRINGS.prevAnchorLabel}
        title={`${RAIL_STRINGS.prevAnchorLabel}（[）`}
        onClick={onPrevAnchor}
      >
        ◀錨
      </button>
      <button
        type="button"
        className="rail__button"
        data-testid="rail-next-anchor"
        aria-label={RAIL_STRINGS.nextAnchorLabel}
        title={`${RAIL_STRINGS.nextAnchorLabel}（]）`}
        onClick={onNextAnchor}
      >
        錨▶
      </button>
    </div>
  );

  const overflowItems = [
    ...(shown.has('step100') ? [] : [step100]),
    ...(shown.has('ymd') ? [] : [ymdGroup]),
    ...(shown.has('unit') ? [] : [unitGroup]),
    ...(shown.has('anchorJump') ? [] : [anchorJump]),
  ];

  return (
    <div className="rail__controls" data-testid="rail-controls" data-fold={fold}>
      {shown.has('step100') && step100}
      {shown.has('step10') && step10}

      {/* ±1 の送り。**文字と読み上げ名は現行のまま**（HB-13）。 */}
      <div className="rail__group rail__group--step1" data-testid="timeline-step" key="step1">
        <StepButton
          className="timeline-step__button"
          ariaLabel={`1${unitLabel}前へ戻る`}
          onStep={() => onStep(unit, -1, 1)}
          icon="◀"
          label="前へ"
          labelClassName="timeline-step__label"
        />
        <StepButton
          className="timeline-step__button"
          ariaLabel={`1${unitLabel}次へ進む`}
          onStep={() => onStep(unit, 1, 1)}
          label="次へ"
          iconAfter="▶"
          labelClassName="timeline-step__label"
        />
      </div>

      {/* 年入力。Enter で確定（§I.2）。断りは欄の下ではなく状態行に出るので、
          ここでは `title` と読み上げに載せて枠の高さを動かさない（レールは 112px 固定）。 */}
      <div className="rail__group rail__year" data-testid="rail-year" key="year">
        <input
          ref={yearRef}
          type="number"
          className="rail__year-input"
          aria-label={`${RAIL_STRINGS.jumpFieldTitle} 年`}
          aria-invalid={refusal !== null}
          title={refusal ?? RAIL_STRINGS.jumpFieldTitle}
          data-pristine={dirty ? 'false' : 'true'}
          value={draft.yearText}
          onChange={(e) => patch({ yearText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            confirmYear();
          }}
        />
        <span className="rail__year-unit" aria-hidden="true">
          年
        </span>
        <button
          type="button"
          className="rail__button"
          data-testid="rail-jump"
          onClick={confirmYear}
        >
          {RAIL_STRINGS.jumpLabel}
        </button>
        {/* 断りは **見える形では状態行の「直前の結果」枠**に出す（中身 7）。ここに
            見える行を足すとレールが 112px を超えて地図が動く（旧実装が 200 → 220px に
            伸びた事故そのもの）。読み上げのためだけに、寸法を持たない `role="alert"` を
            置く ―― 欄の枠の色（`aria-invalid`）と `title` も同じ文を持つ。 */}
        {refusal !== null && (
          <span className="rail__year-error" role="alert" data-testid="rail-year-error">
            {refusal}
          </span>
        )}
      </div>

      {shown.has('ymd') && ymdGroup}

      {/* 再生。**可視テキスト「再生」と読み上げ名「再生」を残す**（HB-13）。 */}
      <div className="rail__group rail__playback" data-testid="timeline-playback" key="play">
        <button
          type="button"
          className="timeline-playback__button"
          aria-label={playback.isPlaying ? '一時停止' : '再生'}
          aria-pressed={playback.isPlaying}
          title={playback.isPlaying ? '自動進行を一時停止します（Space）' : '時間を自動で進めます（Space）'}
          onClick={playback.toggle}
        >
          <span aria-hidden="true">{playback.isPlaying ? '⏸' : '▶'}</span>
          {fold !== RAIL_FOLD.KeysOnly && (
            <span className="timeline-playback__label">
              {playback.isPlaying ? '一時停止' : '再生'}
            </span>
          )}
        </button>
        {fold !== RAIL_FOLD.KeysOnly && (
          <label className="timeline-playback__speed">
            <span className="timeline-playback__speed-caption">再生速度</span>
            <select
              aria-label="再生速度"
              title="自動進行の速さ(1倍 = 1年/秒)"
              value={playback.speed}
              onChange={(e) => playback.setSpeed(Number(e.target.value) as PlaybackSpeed)}
            >
              {PLAYBACK_SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}倍
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* レールの拡大。狭い窓では「拡大 ▾」1 個へ畳む。 */}
      {shown.has('zoomFull') && (
        <div className="rail__group rail__zoom" data-testid="rail-zoom" key="zoom">
          <ZoomButtons
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onZoomFit={onZoomFit}
          />
        </div>
      )}
      {shown.has('zoomMenu') && (
        <div className="rail__group rail__zoom" data-testid="rail-zoom" key="zoomMenu">
          <OptionPopover
            label={RAIL_STRINGS.zoomMenuLabel}
            buttonTestId="rail-zoom-button"
            panelTestId="rail-zoom-panel"
            buttonClassName="rail__button"
            panelClassName="rail__popover"
            ariaLabel={RAIL_STRINGS.zoomMenuLabel}
            closeKey={closeKey}
            {...(onPopoverOpenChange ? { onOpenChange: onPopoverOpenChange } : {})}
          >
            {() => (
              <div className="rail__popover-row">
                <ZoomButtons
                  onZoomIn={onZoomIn}
                  onZoomOut={onZoomOut}
                  onZoomFit={onZoomFit}
                />
              </div>
            )}
          </OptionPopover>
        </div>
      )}

      {shown.has('anchorJump') && anchorJump}
      {shown.has('unit') && unitGroup}

      {shown.has('overflow') && (
        <div className="rail__group rail__overflow" key="overflow">
          <OptionPopover
            label={RAIL_STRINGS.overflowLabel}
            buttonTestId="rail-overflow-button"
            panelTestId="rail-overflow-panel"
            buttonClassName="rail__button rail__button--overflow"
            panelClassName="rail__popover"
            ariaLabel={RAIL_STRINGS.overflowAriaLabel}
            closeKey={closeKey}
            measureKey={overflowItems.length}
            {...(onPopoverOpenChange ? { onOpenChange: onPopoverOpenChange } : {})}
          >
            {() => <div className="rail__popover-row">{overflowItems}</div>}
          </OptionPopover>
        </div>
      )}
    </div>
  );
}

function ZoomButtons(props: {
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomFit: () => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="rail__button rail__button--icon"
        data-testid="rail-zoom-out"
        aria-label={RAIL_STRINGS.zoomOutLabel}
        title={RAIL_STRINGS.zoomOutLabel}
        onClick={props.onZoomOut}
      >
        −
      </button>
      <button
        type="button"
        className="rail__button rail__button--icon"
        data-testid="rail-zoom-in"
        aria-label={RAIL_STRINGS.zoomInLabel}
        title={RAIL_STRINGS.zoomInLabel}
        onClick={props.onZoomIn}
      >
        ＋
      </button>
      <button
        type="button"
        className="rail__button rail__button--icon"
        data-testid="rail-zoom-fit"
        aria-label={RAIL_STRINGS.zoomFitLabel}
        title={RAIL_STRINGS.zoomFitLabel}
        onClick={props.onZoomFit}
      >
        全体
      </button>
    </>
  );
}

/** 押しっぱなしで送り続けるボタン（現行の `useLongPress` をそのまま使う）。 */
function StepButton(props: {
  readonly ariaLabel: string;
  readonly onStep: () => void;
  readonly label?: string;
  readonly icon?: string;
  readonly iconAfter?: string;
  readonly className?: string;
  readonly labelClassName?: string;
}): JSX.Element {
  const press = useLongPress(props.onStep);
  return (
    <button
      type="button"
      className={props.className ?? 'rail__button'}
      aria-label={props.ariaLabel}
      title={props.ariaLabel}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerLeave={press.onPointerLeave}
    >
      {props.icon !== undefined && <span aria-hidden="true">{props.icon}</span>}
      {props.label !== undefined && (
        <span className={props.labelClassName}>{props.label}</span>
      )}
      {props.iconAfter !== undefined && <span aria-hidden="true">{props.iconAfter}</span>}
    </button>
  );
}
