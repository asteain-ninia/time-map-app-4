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
import { railTicks } from '../time/rail-ticks';
import type { TimeBarView } from '../time/timebar';

import { RAIL_STRINGS } from './rail-strings';
import { formatYear } from './time-display';

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
  /** ホイール（ズーム／横スクロール）。 */
  readonly onWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
}

export function RailTicks(props: RailTicksProps): JSX.Element {
  const {
    view,
    calendar,
    targetTicks = 10,
    fraction,
    playheadOutside,
    onFraction,
    onWheel,
  } = props;

  const ticks: readonly RailTick[] = railTicks(view, calendar, targetTicks);

  return (
    <div
      className="rail__ticks"
      data-testid="timeline-ticks"
      onWheel={onWheel}
      data-playhead-outside={playheadOutside ? 'true' : 'false'}
    >
      <div className="rail__axis" data-testid="rail-axis">
        {ticks.map((tick) => (
          <span
            key={tick.year}
            className="rail__tick"
            style={{ left: `${String(tick.px)}px` } satisfies CSSProperties}
            data-tick-year={tick.year}
            aria-hidden="true"
          >
            <span className="rail__tick-mark" />
            <span className="rail__tick-label" data-testid="timeline-tick-label">
              {formatYear(tick.year)}
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
