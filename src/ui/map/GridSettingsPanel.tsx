// Grid settings panel (U18 / FR-13 / FR-109). UI layer: a React function
// component. Presentational + callback-driven: the grid settings TRUTH is a
// PROJECT setting in U16's store (FR-109, 单一真实源); this panel renders the
// current values and reports changes via callbacks. The store applies them and
// notifies the Canvas, which re-reads and re-draws immediately (FR-109 即時反映,
// 教訓 5.35). This widget holds no draft state — every change is a direct callback.

import {
  GRID_SPACINGS_DEG,
  type GridSpacingDeg,
  coerceGridSpacing,
} from '../../domain/basemap/index';

export interface GridSettings {
  /** Grid ON/OFF (受け入れ基準 9). */
  readonly enabled: boolean;
  /** Spacing in degrees (5/10/15/30, 受け入れ基準 9). */
  readonly spacing: GridSpacingDeg;
  /** Grid color (CSS hex). */
  readonly color: string;
  /** Grid opacity [0,1]. */
  readonly opacity: number;
}

export interface GridSettingsPanelProps {
  readonly settings: GridSettings;
  readonly onToggle: (enabled: boolean) => void;
  readonly onSpacing: (spacing: GridSpacingDeg) => void;
  readonly onColor: (color: string) => void;
  readonly onOpacity: (opacity: number) => void;
}

export function GridSettingsPanel(props: GridSettingsPanelProps): JSX.Element {
  const { settings, onToggle, onSpacing, onColor, onOpacity } = props;

  return (
    <div className="grid-settings" data-testid="grid-settings">
      <label>
        <input
          type="checkbox"
          aria-label="グリッド表示"
          checked={settings.enabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        グリッドを表示
      </label>

      <label>
        間隔
        <select
          aria-label="グリッド間隔"
          value={settings.spacing}
          onChange={(e) => onSpacing(coerceGridSpacing(Number(e.target.value)))}
        >
          {GRID_SPACINGS_DEG.map((s) => (
            <option key={s} value={s}>
              {s}°
            </option>
          ))}
        </select>
      </label>

      <label>
        色
        <input
          type="color"
          aria-label="グリッド色"
          value={settings.color}
          onChange={(e) => onColor(e.target.value)}
        />
      </label>

      <label>
        不透明度
        <input
          type="range"
          aria-label="グリッド不透明度"
          min={0}
          max={1}
          step={0.05}
          value={settings.opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
        />
      </label>
    </div>
  );
}
