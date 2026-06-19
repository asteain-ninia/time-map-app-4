// Longitude shift widget (U18 / FR-12). UI layer: a React function component for
// the業務 UI (技術方針 2.3). Presentational + callback-driven: the center-longitude
// TRUTH lives in U16's session store (单一真实源); this widget renders the current
// center, the preset buttons and the shift slider, and reports user intent via
// callbacks. The store/wiring unit applies the shift to the camera (technique 5.17).
//
// The zoom-dependent shift conversion is NOT done here — the widget reports a raw
// shift操作量, and the wiring/domain (`applyLongitudeShift`) multiplies by zoom in
// ONE place (教訓 5.16 倍率の二重適用防止). This widget never sees zoom, so it
// cannot double-apply it.

import {
  CENTER_LON_PRESET,
  type CenterLonPreset,
  formatCenterLonDisplay,
} from '../../domain/basemap/index';

export interface LongitudeShiftControlProps {
  /** Current continuous-scalar center longitude (from U16). */
  readonly centerLon: number;
  /**
   * Apply a shift操作量 (slider drag amount). The wiring multiplies by zoom and
   * pushes the new center into the camera (教訓 5.16: zoom applied once, not here).
   */
  readonly onShift: (shift: number) => void;
  /** Jump the center to a named preset (本初子午線中心 / 太平洋中心). */
  readonly onPreset: (preset: CenterLonPreset) => void;
}

/** Slider半幅: the slider runs [−SHIFT_SLIDER_RANGE, +SHIFT_SLIDER_RANGE]. */
const SHIFT_SLIDER_RANGE = 10;

const PRESET_LABELS: Readonly<Record<CenterLonPreset, string>> = {
  [CENTER_LON_PRESET.PrimeMeridian]: '本初子午線中心',
  [CENTER_LON_PRESET.Pacific]: '太平洋中心',
};

export function LongitudeShiftControl(props: LongitudeShiftControlProps): JSX.Element {
  const { centerLon, onShift, onPreset } = props;

  return (
    <div className="longitude-shift" data-testid="longitude-shift">
      <div className="longitude-shift__readout" data-testid="center-lon-readout">
        中心経度: {formatCenterLonDisplay(centerLon)}
      </div>

      <input
        type="range"
        aria-label="経度シフト"
        min={-SHIFT_SLIDER_RANGE}
        max={SHIFT_SLIDER_RANGE}
        step={0.1}
        // The slider is a momentary control: it reports the shift amount then
        // recenters to 0 (the truth is the center longitude, not the slider).
        value={0}
        onChange={(e) => {
          const shift = Number(e.target.value);
          if (shift !== 0) onShift(shift);
        }}
      />

      <div className="longitude-shift__buttons">
        <button type="button" aria-label="左へシフト" onClick={() => onShift(-1)}>
          ◀
        </button>
        <button type="button" aria-label="右へシフト" onClick={() => onShift(1)}>
          ▶
        </button>
      </div>

      <div className="longitude-shift__presets">
        {(Object.values(CENTER_LON_PRESET) as CenterLonPreset[]).map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onPreset(preset)}
          >
            {PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
    </div>
  );
}
