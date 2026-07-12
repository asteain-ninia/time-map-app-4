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

import { useState } from 'react';

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
  /** Jump the center to a longitude preset (0度中心 / 180度中心). */
  readonly onPreset: (preset: CenterLonPreset) => void;
}

/** Slider半幅: the slider runs [−SHIFT_SLIDER_RANGE, +SHIFT_SLIDER_RANGE]. */
const SHIFT_SLIDER_RANGE = 10;

// Compact preset labels for the上部バー (short visible text keeps the bar one row).
const PRESET_LABELS: Readonly<Record<CenterLonPreset, string>> = {
  [CENTER_LON_PRESET.PrimeMeridian]: '0度中心',
  [CENTER_LON_PRESET.Pacific]: '180度中心',
};

// HB3-2→2026-07-12 実機FB: labels are the longitude values themselves (デーレ世界に
// 地球の地名は存在しないため、基準経線は経度値で呼ぶ)。The action phrasing is kept
// as the button's `title` tooltip so the 上部バー stays compact.
const PRESET_TITLES: Readonly<Record<CenterLonPreset, string>> = {
  [CENTER_LON_PRESET.PrimeMeridian]: '中心経度を0°にする',
  [CENTER_LON_PRESET.Pacific]: '中心経度を180°にする',
};

// HB3-1: the slider is a RELATIVE jog (momentary; snaps back to center on release), NOT
// an absolute position — the numeric readout is the真値. Surfaced BOTH as the hidden hint
// paragraph (a11y / regression) AND the slider's `title` tooltip so the compact上部バー
// keeps the clarification without spending a row on it.
const SHIFT_HINT =
  'スライダーは相対シフト（離すと中央へ戻ります）。現在の中心経度は上の数値が真値です。';

export function LongitudeShiftControl(props: LongitudeShiftControlProps): JSX.Element {
  const { centerLon, onShift, onPreset } = props;

  // The slider is a MOMENTARY control whose truth is the center longitude, not the
  // thumb. A native range drag fires many `change` events with ABSOLUTE thumb
  // positions; if each were forwarded as a fresh relative shift they would SUM and
  // over-shift (Codex medium #8). We instead remember the last thumb position and
  // report only the DELTA since the previous event, so a continuous drag's reported
  // shifts telescope to exactly the net thumb movement. The thumb snaps back to 0
  // when the gesture ends (pointer up / blur) so the next drag starts from center.
  const [thumb, setThumb] = useState(0);

  const reset = (): void => {
    if (thumb !== 0) setThumb(0);
  };

  return (
    <div className="longitude-shift" data-testid="longitude-shift">
      <div className="longitude-shift__readout" data-testid="center-lon-readout">
        中心経度: {formatCenterLonDisplay(centerLon)}
      </div>

      {/* HB3-1: the slider is a RELATIVE jog (momentary; snaps back to center on
          release), NOT an absolute position — that is why the thumb does not track
          the center. The真値 is the numeric readout above. Kept in the DOM (a11y /
          regression) but hidden in the compact上部バー (see shell.css); the same text
          is on the slider's `title` so the clarification is one hover away. */}
      <p className="longitude-shift__hint" data-testid="longitude-shift-hint">
        {SHIFT_HINT}
      </p>

      <input
        type="range"
        aria-label="経度シフト"
        title={SHIFT_HINT}
        min={-SHIFT_SLIDER_RANGE}
        max={SHIFT_SLIDER_RANGE}
        step={0.1}
        value={thumb}
        onChange={(e) => {
          const next = Number(e.target.value);
          const delta = next - thumb;
          setThumb(next);
          if (delta !== 0) onShift(delta);
        }}
        // End of gesture: snap the momentary thumb back to center so the truth stays
        // the center longitude and the next drag is measured from 0 (受け入れ基準 14).
        onPointerUp={reset}
        onPointerCancel={reset}
        onBlur={reset}
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
            title={PRESET_TITLES[preset]}
            onClick={() => onPreset(preset)}
          >
            {PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
    </div>
  );
}
