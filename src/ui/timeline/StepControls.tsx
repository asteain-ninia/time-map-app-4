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

  return (
    <div className="timeline-step" data-testid="timeline-step">
      <button
        type="button"
        aria-label="後退"
        onPointerDown={back.onPointerDown}
        onPointerUp={back.onPointerUp}
        onPointerLeave={back.onPointerLeave}
      >
        ◀
      </button>

      <select
        aria-label="ステップ単位"
        value={unit}
        onChange={(e) => setUnit(e.target.value as StepUnit)}
      >
        {Object.values(STEP_UNIT).map((u) => (
          <option key={u} value={u}>
            {UNIT_LABELS[u]}
          </option>
        ))}
      </select>

      <button
        type="button"
        aria-label="前進"
        onPointerDown={forward.onPointerDown}
        onPointerUp={forward.onPointerUp}
        onPointerLeave={forward.onPointerLeave}
      >
        ▶
      </button>
    </div>
  );
}
