// UI layer (U21 / 時刻レール): 目盛りと再生ヘッド（設計書 §C.7 の (c)）。
//
// **目盛りは押すとその年へ飛ぶ**（現状の目盛りは押せない飾りだった）。押せる実体は
// `input[type=range]` で、**読み上げ名「時間軸スライダー」は据え置く**（T-1: testid と
// 読み上げ名は役割で維持し、改名しない）。つまみの位置は表示範囲の中の割合なので、
// レールを拡大すると目盛りも錨の印も同じだけ動く ―― 軸の写像は 1 つである。
//
// **「単位: 年」は消さない**（U-27）。目盛りのラベルと重ならないよう、軸の右側に
// 専用の余白（`--rail-unit-gutter`）を取り、そこに置く。軸そのものはその余白の手前で
// 終わるので、いちばん右のラベルと重なる余地が構造的に無い。

import type { CSSProperties } from 'react';

import type { Calendar } from '../../domain/time/calendar';
import type { RailTick } from '../time/rail-ticks';
import { railTicks, tickLabelWidthPx } from '../time/rail-ticks';
import type { TimeBarView } from '../time/timebar';

import { RAIL_STRINGS } from './rail-strings';

export interface RailTicksProps {
  readonly view: TimeBarView;
  readonly calendar: Calendar;
  /** 目盛りラベルの目標本数。 */
  readonly targetTicks?: number;
  /** つまみの値（表示範囲の中の割合 0〜1）。 */
  readonly fraction: number;
  /** 現在時刻が表示範囲の外か（つまみは端に寄っている）。 */
  readonly playheadOutside: boolean;
  /** つまみを動かした（割合を確定する）。 */
  readonly onFraction: (fraction: number) => void;
  /**
   * 矢印キーで 1 目盛りぶん動かす（2026-09-07 の手直し）。`input[type=range]` の
   * 既定の 1 歩（`step`）は割合なので、**年の切り下げで消えて何も起きなかった** ――
   * 送りのボタンと同じ「単位 1 つ」を動かす。
   */
  readonly onArrowStep: (direction: -1 | 1) => void;
}

export function RailTicks(props: RailTicksProps): JSX.Element {
  const {
    view,
    calendar,
    targetTicks = 10,
    fraction,
    playheadOutside,
    onFraction,
    onArrowStep,
  } = props;

  const ticks: readonly RailTick[] = railTicks(view, calendar, targetTicks);
  // 右端のラベルは中央揃えで余白へ半分はみ出す。余白はその「はみ出し」を含めて取る。
  const overhang = ticks.reduce((w, tick) => Math.max(w, tickLabelWidthPx(tick.label)), 0) / 2;

  return (
    <div
      className="rail__ticks"
      data-testid="timeline-ticks"
      data-rail-wheel="true"
      style={{ '--rail-tick-overhang': `${String(Math.ceil(overhang))}px` } as CSSProperties}
      data-playhead-outside={playheadOutside ? 'true' : 'false'}
    >
      <div className="rail__axis" data-testid="rail-axis">
        {ticks.map((tick) => (
          <span
            key={tick.key}
            className="rail__tick"
            style={{ left: `${String(tick.px)}px` } satisfies CSSProperties}
            data-tick-year={tick.year}
            /* **左端のラベルは軸の外へ出さない**（2026-09-07 の最終手直し）。
               ラベルは目盛りの上に中央揃えで置くので、いちばん左の目盛り（px≒0）の
               ラベルは軸の左へ半分はみ出す ―― 行は `overflow: hidden` なので、実測で
               「0年」の左 7.7px が切れて「年」しか読めなかった。右端は「単位: 年」の
               余白が受けているが、左には受け皿が無いので **その目盛りだけ左揃え**に
               する（目盛りの線そのものの位置は動かさない）。 */
            data-align={tick.px - tickLabelWidthPx(tick.label) / 2 < 0 ? 'left' : 'center'}
            aria-hidden="true"
          >
            <span className="rail__tick-mark" />
            <span className="rail__tick-label" data-testid="timeline-tick-label">
              {tick.label}
            </span>
          </span>
        ))}
        {/* 押せる軸そのもの。目盛りの上に重ねて全幅に敷く（どこを押してもその年へ飛ぶ）。 */}
        <input
          className="rail__slider"
          type="range"
          aria-label={RAIL_STRINGS.sliderLabel}
          min={0}
          max={1}
          step={0.0001}
          value={fraction}
          onChange={(e) => onFraction(Number(e.target.value))}
          onKeyDown={(e) => {
            // 矢印は「単位 1 つ」。既定の 1 歩（割合 0.0001）は年に届かず、
            // value が現在時刻から作り直されて元に戻っていた。
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault();
              onArrowStep(-1);
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault();
              onArrowStep(1);
            }
          }}
        />
      </div>
      {/* U-27: 消さない。軸の外の余白に置くので、目盛りラベルと重ならない。 */}
      <span
        className="rail__ticks-unit"
        data-testid="timeline-ticks-unit"
        aria-hidden="true"
      >
        {RAIL_STRINGS.ticksUnit}
      </span>
    </div>
  );
}
