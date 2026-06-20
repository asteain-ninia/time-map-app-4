// UI layer (U21 / timeline): forward/back step controls (FR-68).
//
// Unit selector (年/月/日, initial 年), step value always 1 unit, press-and-hold
// repeat (useLongPress). Each step routes through the timeline binding's `step`,
// which uses U02 arithmetic and clamps to the range — no UI day math.

import { useState } from 'react';

import { STEP_UNIT, type StepUnit } from './step';
import { useLongPress } from './useLongPress';

export interface StepControlsProps {
  readonly onStep: (unit: StepUnit, direction: 1 | -1) => void;
}

const UNIT_LABELS: Readonly<Record<StepUnit, string>> = {
  [STEP_UNIT.Year]: '年',
  [STEP_UNIT.Month]: '月',
  [STEP_UNIT.Day]: '日',
};

export function StepControls(props: StepControlsProps): JSX.Element {
  const { onStep } = props;
  const [unit, setUnit] = useState<StepUnit>(STEP_UNIT.Year);

  const back = useLongPress(() => onStep(unit, -1));
  const forward = useLongPress(() => onStep(unit, 1));

  // HB-13: ボタンに可視ラベルを付け、最小サイズとツールチップを与える。アイコン
  // だけだと意味が伝わらないため「◀ 前へ」「次へ ▶」のようにテキストを併記する。
  const unitLabel = UNIT_LABELS[unit];

  return (
    <div className="timeline-step" data-testid="timeline-step">
      <button
        type="button"
        className="timeline-step__button"
        aria-label={`1${unitLabel}前へ戻る`}
        title={`1${unitLabel}前へ戻る`}
        onPointerDown={back.onPointerDown}
        onPointerUp={back.onPointerUp}
        onPointerLeave={back.onPointerLeave}
      >
        <span aria-hidden="true">◀</span>
        <span className="timeline-step__label">前へ</span>
      </button>

      <label className="timeline-step__unit">
        <span className="timeline-step__unit-caption">ステップ単位</span>
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

      <button
        type="button"
        className="timeline-step__button"
        aria-label={`1${unitLabel}次へ進む`}
        title={`1${unitLabel}次へ進む`}
        onPointerDown={forward.onPointerDown}
        onPointerUp={forward.onPointerUp}
        onPointerLeave={forward.onPointerLeave}
      >
        <span className="timeline-step__label">次へ</span>
        <span aria-hidden="true">▶</span>
      </button>
    </div>
  );
}
