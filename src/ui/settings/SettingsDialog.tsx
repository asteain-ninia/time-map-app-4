// UI layer (U38 / settings): the settings modal dialog (FR-109 / FR-110).
//
// Presentational over `useSettingsDialog`: it renders the project-specific tab
// (FR-109) and the app-wide tab (FR-110) as CLEARLY separated sections so the
// user can see which scope each setting belongs to (受け入れ基準 3), edits feed
// the draft only (教訓 5.22), confirm validates + writes changed keys (教訓 5.24 /
// 5.26), and every exit path (cancel button, Esc, backdrop click, tab switch)
// discards the draft (教訓 5.2). The rejection banner persists until a re-confirm
// or explicit close, not an unrelated edit (教訓 5.12).
//
// The base-map control is only the REQUEST起動点 (FR-109): it invokes the host's
// `onRequestBasemapReplace`, which forwards to U18; this dialog performs no
// replacement / correction / fallback itself (spec §やらないこと, 受け入れ基準 1).

import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_PALETTE_THEME } from '../../domain/coloring/palette';
import { GRID_SPACINGS_DEG, coerceGridSpacing } from '../../domain/basemap/grid';
import type { ProjectSettingKey } from '../state/settings';

import {
  type SettingsStorePort,
  useSettingsDialog,
} from './useSettingsDialog';
import {
  APP_FIELD_STRINGS,
  BASEMAP_STRINGS,
  PALETTE_STRINGS,
  PROJECT_FIELD_STRINGS,
  SETTINGS_STRINGS,
} from './strings';

const SETTINGS_TAB = {
  Project: 'project',
  App: 'app',
} as const;

type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/** Palette themes offered for the default-theme select (single source, 教訓 5.19). */
const PALETTE_THEME_OPTIONS = [DEFAULT_PALETTE_THEME] as const;

export interface SettingsDialogProps {
  /** The injected U16 store slice (current values + per-scope update actions). */
  readonly store: SettingsStorePort;
  /** Close the dialog (host unmounts it). Called after confirm or cancel. */
  readonly onClose: () => void;
  /**
   * Hand a base-map replacement REQUEST to U18 (FR-109 起動点のみ). Optional; when
   * absent the control is disabled. This dialog never performs the replacement.
   */
  readonly onRequestBasemapReplace?: (() => void) | undefined;
}

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const { store, onClose, onRequestBasemapReplace } = props;
  const dialog = useSettingsDialog(store);
  const [tab, setTab] = useState<SettingsTab>(SETTINGS_TAB.Project);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Cancel = discard the draft (教訓 5.2) then close.
  const cancelAndClose = useCallback(() => {
    dialog.cancel();
    onClose();
  }, [dialog, onClose]);

  const saveAndClose = useCallback(() => {
    const result = dialog.confirm();
    // Stay open on rejection so the user can fix the value (errors persist, 教訓 5.12).
    if (result.status !== 'rejected') onClose();
  }, [dialog, onClose]);

  // Focus trap + Esc (受け入れ基準 3 / 6: モーダル離脱の全経路でドラフト破棄).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelAndClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [cancelAndClose],
  );

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="settings-modal-root" data-testid="settings-modal-root">
      {/* Backdrop: a click outside the dialog discards the draft (教訓 5.2). */}
      <div
        className="settings-backdrop"
        data-testid="settings-backdrop"
        aria-hidden="true"
        onClick={cancelAndClose}
      />

      <div
        className="settings-dialog"
        data-testid="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={SETTINGS_STRINGS.title}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="settings-dialog__header">
          <h2 className="settings-dialog__title">{SETTINGS_STRINGS.title}</h2>
        </header>

        {/* Tabs make the project/app scope boundary explicit (受け入れ基準 3). */}
        <div className="settings-tabs" role="tablist" aria-label={SETTINGS_STRINGS.title}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === SETTINGS_TAB.Project}
            data-testid="settings-tab-project"
            onClick={() => setTab(SETTINGS_TAB.Project)}
          >
            {SETTINGS_STRINGS.tabProject}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === SETTINGS_TAB.App}
            data-testid="settings-tab-app"
            onClick={() => setTab(SETTINGS_TAB.App)}
          >
            {SETTINGS_STRINGS.tabApp}
          </button>
        </div>

        {/* Rejection banner (FR-115). Persists until re-confirm / cancel (教訓 5.12). */}
        {dialog.errors.length > 0 && (
          <ul className="settings-dialog__errors" role="alert" data-testid="settings-errors">
            {dialog.errors.map((e) => (
              <li key={e.field} data-testid={`settings-error-${e.field}`}>
                {e.message}
              </li>
            ))}
          </ul>
        )}

        <div className="settings-dialog__body">
          {tab === SETTINGS_TAB.Project ? (
            <ProjectTab
              dialog={dialog}
              onRequestBasemapReplace={onRequestBasemapReplace}
            />
          ) : (
            <AppTab dialog={dialog} />
          )}
        </div>

        <footer className="settings-dialog__footer">
          <button
            type="button"
            className="settings-dialog__cancel"
            data-testid="settings-cancel"
            onClick={cancelAndClose}
          >
            {SETTINGS_STRINGS.cancel}
          </button>
          <button
            type="button"
            className="settings-dialog__save"
            data-testid="settings-save"
            onClick={saveAndClose}
          >
            {SETTINGS_STRINGS.save}
          </button>
        </footer>
      </div>
    </div>
  );
}

// --- Project-specific tab (FR-109) ------------------------------------------

function ProjectTab(props: {
  readonly dialog: ReturnType<typeof useSettingsDialog>;
  readonly onRequestBasemapReplace?: (() => void) | undefined;
}): JSX.Element {
  const { dialog, onRequestBasemapReplace } = props;
  const d = dialog.projectDraft;
  const set = dialog.setProjectField;

  const setNum = (key: ProjectSettingKey, raw: string): void => {
    const n = Number(raw);
    set(key as never, n as never);
  };

  return (
    <section className="settings-section settings-section--project" data-testid="settings-project">
      <p className="settings-section__hint">{SETTINGS_STRINGS.projectScopeHint}</p>

      <label>
        {PROJECT_FIELD_STRINGS.projectName}
        <input
          type="text"
          aria-label={PROJECT_FIELD_STRINGS.projectName}
          value={d.projectName}
          onChange={(e) => set('projectName', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.projectDescription}
        <textarea
          aria-label={PROJECT_FIELD_STRINGS.projectDescription}
          value={d.projectDescription}
          onChange={(e) => set('projectDescription', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.equatorLengthKm}
        <input
          type="number"
          aria-label={PROJECT_FIELD_STRINGS.equatorLengthKm}
          value={d.equatorLengthKm}
          onChange={(e) => setNum('equatorLengthKm', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.flattening}
        <input
          type="number"
          step="0.001"
          aria-label={PROJECT_FIELD_STRINGS.flattening}
          value={d.flattening}
          onChange={(e) => setNum('flattening', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.timelineMinYear}
        <input
          type="number"
          aria-label={PROJECT_FIELD_STRINGS.timelineMinYear}
          value={d.timelineMinYear}
          onChange={(e) => setNum('timelineMinYear', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.timelineMaxYear}
        <input
          type="number"
          aria-label={PROJECT_FIELD_STRINGS.timelineMaxYear}
          value={d.timelineMaxYear}
          onChange={(e) => setNum('timelineMaxYear', e.target.value)}
        />
      </label>

      {/* FR-10 zoom-limit inputs (provided by U39; range 0.1×..10000×, min ≤ max). */}
      <label>
        {PROJECT_FIELD_STRINGS.zoomMin}
        <input
          type="number"
          step="0.1"
          aria-label={PROJECT_FIELD_STRINGS.zoomMin}
          value={d.zoomMin}
          onChange={(e) => setNum('zoomMin', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.zoomMax}
        <input
          type="number"
          step="0.1"
          aria-label={PROJECT_FIELD_STRINGS.zoomMax}
          value={d.zoomMax}
          onChange={(e) => setNum('zoomMax', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.gridSpacingDeg}
        <select
          aria-label={PROJECT_FIELD_STRINGS.gridSpacingDeg}
          value={d.gridSpacingDeg}
          onChange={(e) => set('gridSpacingDeg', coerceGridSpacing(Number(e.target.value)))}
        >
          {GRID_SPACINGS_DEG.map((s) => (
            <option key={s} value={s}>
              {s}°
            </option>
          ))}
        </select>
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.gridColor}
        <input
          type="color"
          aria-label={PROJECT_FIELD_STRINGS.gridColor}
          value={d.gridColor}
          onChange={(e) => set('gridColor', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.gridOpacity}
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          aria-label={PROJECT_FIELD_STRINGS.gridOpacity}
          value={d.gridOpacity}
          onChange={(e) => setNum('gridOpacity', e.target.value)}
        />
      </label>

      {/* Base-map: REQUEST起動点 only; replacement is U18's (受け入れ基準 1). */}
      <div className="settings-field settings-field--basemap">
        <span className="settings-field__label">{PROJECT_FIELD_STRINGS.baseMapId}</span>
        <button
          type="button"
          data-testid="settings-basemap-replace"
          disabled={onRequestBasemapReplace === undefined}
          onClick={() => onRequestBasemapReplace?.()}
        >
          {BASEMAP_STRINGS.replace}
        </button>
        <p className="settings-field__note">{BASEMAP_STRINGS.note}</p>
      </div>

      <label>
        {PROJECT_FIELD_STRINGS.areaLabelOccupancyThreshold}
        <input
          type="number"
          step="0.01"
          aria-label={PROJECT_FIELD_STRINGS.areaLabelOccupancyThreshold}
          value={d.areaLabelOccupancyThreshold}
          onChange={(e) => setNum('areaLabelOccupancyThreshold', e.target.value)}
        />
      </label>

      <label>
        <input
          type="checkbox"
          aria-label={PROJECT_FIELD_STRINGS.newAreaAutoColorDefault}
          checked={d.newAreaAutoColorDefault}
          onChange={(e) => set('newAreaAutoColorDefault', e.target.checked)}
        />
        {PROJECT_FIELD_STRINGS.newAreaAutoColorDefault}
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.defaultPaletteTheme}
        <select
          aria-label={PROJECT_FIELD_STRINGS.defaultPaletteTheme}
          value={d.defaultPaletteTheme}
          onChange={(e) => set('defaultPaletteTheme', e.target.value)}
        >
          {PALETTE_THEME_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <CustomPaletteEditor dialog={dialog} />
    </section>
  );
}

// --- Custom palette management (FR-109 / FR-102) ----------------------------

function CustomPaletteEditor(props: {
  readonly dialog: ReturnType<typeof useSettingsDialog>;
}): JSX.Element {
  const { dialog } = props;
  const palette = dialog.projectDraft.customPalette;

  const setAt = (index: number, color: string): void => {
    const next = palette.map((c, i) => (i === index ? color : c));
    dialog.setProjectField('customPalette', next);
  };
  const removeAt = (index: number): void => {
    dialog.setProjectField('customPalette', palette.filter((_, i) => i !== index));
  };
  const add = (): void => {
    dialog.setProjectField('customPalette', [...palette, '#000000']);
  };

  return (
    <fieldset className="settings-palette" data-testid="settings-custom-palette">
      <legend>{PROJECT_FIELD_STRINGS.customPalette}</legend>
      {palette.length === 0 && <p className="settings-palette__empty">{PALETTE_STRINGS.empty}</p>}
      <ul className="settings-palette__list">
        {palette.map((color, i) => (
          // Index keys are acceptable here: palette entries are positional and the
          // list is small + fully controlled.
          <li key={`palette-${String(i)}`} className="settings-palette__item">
            <input
              type="color"
              aria-label={`カスタムパレット色 ${String(i + 1)}`}
              value={color}
              onChange={(e) => setAt(i, e.target.value)}
            />
            <button
              type="button"
              data-testid={`settings-palette-remove-${String(i)}`}
              onClick={() => removeAt(i)}
            >
              {PALETTE_STRINGS.remove}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" data-testid="settings-palette-add" onClick={add}>
        {PALETTE_STRINGS.add}
      </button>
    </fieldset>
  );
}

// --- App-wide tab (FR-110) ---------------------------------------------------

function AppTab(props: {
  readonly dialog: ReturnType<typeof useSettingsDialog>;
}): JSX.Element {
  const { dialog } = props;
  const d = dialog.appDraft;
  const set = dialog.setAppField;

  return (
    <section className="settings-section settings-section--app" data-testid="settings-app">
      <p className="settings-section__hint">{SETTINGS_STRINGS.appScopeHint}</p>

      <label>
        {APP_FIELD_STRINGS.snapDistancePx}
        <input
          type="number"
          aria-label={APP_FIELD_STRINGS.snapDistancePx}
          value={d.snapDistancePx}
          onChange={(e) => set('snapDistancePx', Number(e.target.value))}
        />
      </label>

      <label>
        {APP_FIELD_STRINGS.renderFps}
        <input
          type="number"
          min={1}
          max={60}
          aria-label={APP_FIELD_STRINGS.renderFps}
          value={d.renderFps}
          onChange={(e) => set('renderFps', Number(e.target.value))}
        />
      </label>

      <label>
        {APP_FIELD_STRINGS.vertexMarkerCap}
        <input
          type="number"
          min={0}
          aria-label={APP_FIELD_STRINGS.vertexMarkerCap}
          value={d.vertexMarkerCap}
          onChange={(e) => set('vertexMarkerCap', Number(e.target.value))}
        />
      </label>

      <label>
        {APP_FIELD_STRINGS.undoStackSize}
        <input
          type="number"
          min={1}
          step={1}
          aria-label={APP_FIELD_STRINGS.undoStackSize}
          value={d.undoStackSize}
          onChange={(e) => set('undoStackSize', Number(e.target.value))}
        />
      </label>

      <label>
        <input
          type="checkbox"
          aria-label={APP_FIELD_STRINGS.showConflictGuide}
          checked={d.showConflictGuide}
          onChange={(e) => set('showConflictGuide', e.target.checked)}
        />
        {APP_FIELD_STRINGS.showConflictGuide}
      </label>
    </section>
  );
}
