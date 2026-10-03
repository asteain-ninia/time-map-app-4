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
//
// K-6「読むだけ」(教訓 5.13 / 所有者裁定): 表示専用モードでは**プロジェクト設定タブの
// 部品をすべて無効化**する（プロジェクト設定＝保存ファイルの中身）。アプリ全体設定タブ
// は裁定どおり触れるままにし、「設定を読む」こと自体も止めない。無効化は見た目だけの
// 封鎖にしない: 確定 (`useSettingsDialog(store, canEdit)` の confirm) と、ベースマップ
// 差し替えの押下ハンドラの**両方**で同じ `canEdit` をもう一度確かめる。

import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_PALETTE_THEME } from '../../domain/coloring/palette';
import { GRID_SPACINGS_DEG, coerceGridSpacing } from '../../domain/basemap/grid';
import { useModalKeydown, nextTabForArrow } from '../a11y/index';
import type { ProjectSettingKey } from '../state/settings';
import {
  AUTO_SAVE_INTERVAL_MINUTES_RANGE,
  BACKUP_GENERATIONS_RANGE,
} from '../../shell/ipc/contract';

import {
  type SettingsStorePort,
  useSettingsDialog,
} from './useSettingsDialog';
import {
  type BackupSettingsPort,
  type UseBackupSettings,
  useBackupSettings,
} from './useBackupSettings';
import {
  APP_FIELD_STRINGS,
  BACKUP_SETTINGS_STRINGS,
  BASEMAP_STRINGS,
  PALETTE_STRINGS,
  PROJECT_FIELD_STRINGS,
  SETTINGS_DIALOG_TEXT,
  SETTINGS_STRINGS,
} from './strings';

const SETTINGS_TAB = {
  Project: 'project',
  App: 'app',
  /** 増分 8D: 保存とバックアップ（G-5。自動保存の間隔・世代数）。 */
  Backup: 'backup',
} as const;

type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/** The scope tabs in traversal order (for the WAI-ARIA arrow-key navigation). */
const SETTINGS_TAB_ORDER: readonly SettingsTab[] = [
  SETTINGS_TAB.Project,
  SETTINGS_TAB.App,
  SETTINGS_TAB.Backup,
];

/** Palette themes offered for the default-theme select (single source, 教訓 5.19). */
const PALETTE_THEME_OPTIONS = [DEFAULT_PALETTE_THEME] as const;

export interface SettingsDialogProps {
  /** The injected U16 store slice (current values + per-scope update actions). */
  readonly store: SettingsStorePort;
  /** Close the dialog (host unmounts it). Called after confirm or cancel. */
  readonly onClose: () => void;
  /**
   * K-6: プロジェクト設定を変更してよいか。shell の `canEdit(mode)`（唯一の権限判定,
   * 教訓 5.13）をそのまま渡す。false =「読むだけ」: プロジェクト設定タブの部品は全部
   * 無効になり、確定してもプロジェクト設定は 1 件も書かれない。アプリ全体設定
   * （FR-110, 教訓 5.36 の区分で「プロジェクトに属さない」側）はこの値に関わらず変更
   * できる。**必須**にしてあるのは、渡し忘れが黙って「編集可」へ倒れる（＝関門が消える）
   * のを型で防ぐため。
   */
  readonly canEdit: boolean;
  /**
   * Hand a base-map replacement REQUEST to U18 (FR-109 起動点のみ). Optional; when
   * absent the control is disabled. This dialog never performs the replacement.
   */
  readonly onRequestBasemapReplace?: (() => void) | undefined;
  /**
   * 「保存とバックアップ」の節が使う口（増分 8D）。`window.timeMapApi` の
   * `readAppPrefs` / `writeAppPrefs` / `listBackups`。無ければ節は読み取り不能の案内を出す。
   */
  readonly backupPort?: BackupSettingsPort | undefined;
}

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const { store, onClose, canEdit, onRequestBasemapReplace, backupPort } = props;
  const dialog = useSettingsDialog(store, canEdit);
  const backup = useBackupSettings(backupPort);
  const [tab, setTab] = useState<SettingsTab>(SETTINGS_TAB.Project);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Cancel = discard the draft (教訓 5.2) then close.
  const cancelAndClose = useCallback(() => {
    dialog.cancel();
    onClose();
  }, [dialog, onClose]);

  // 増分 8D の手直し: ［保存］で「保存とバックアップ」を書くとき、世代が消える確認が出たら、
  // 確認で「この数にする」を押して書けた時点でダイアログを閉じる。
  const [closeAfterShrink, setCloseAfterShrink] = useState(false);

  const saveAndClose = useCallback(async () => {
    // 増分 8D: 「保存とバックアップ」の下書きが打ちかけで変わっていれば、［保存］でも
    // 一緒に書く（［適用］を押し忘れた変更を黙って捨てない）。値が範囲外ならその節を開いて
    // 理由を出し、何も書かずに留まる。
    if (backup.dirty && backup.validate().length > 0) {
      setTab(SETTINGS_TAB.Backup);
      void backup.apply();
      return;
    }
    const result = dialog.confirm();
    // Stay open on rejection so the user can fix the value (errors persist, 教訓 5.12).
    if (result.status === 'rejected') return;
    if (backup.dirty) {
      // 増分 8D の手直し: 書き込みの成否を **待ってから** 閉じる。世代が消えるなら確認を出して
      // 留まり、書けなければ理由を出して留まる（入力は残す）。
      const outcome = await backup.apply();
      if (outcome === 'needs-confirm') {
        setTab(SETTINGS_TAB.Backup);
        setCloseAfterShrink(true);
        return;
      }
      if (outcome !== 'applied' && outcome !== 'unchanged') {
        setTab(SETTINGS_TAB.Backup);
        return;
      }
    }
    onClose();
  }, [dialog, backup, onClose]);

  /** 「世代が消える」確認で「この数にする」。［保存］から来たなら、書けたら閉じる。 */
  const confirmShrink = useCallback(async () => {
    const outcome = await backup.apply({ confirmShrink: true });
    if (outcome === 'applied' && closeAfterShrink) onClose();
  }, [backup, closeAfterShrink, onClose]);

  /** 「世代が消える」確認でやめる（世代数は保存してある値へ戻る）。 */
  const cancelShrink = useCallback(() => {
    setCloseAfterShrink(false);
    backup.cancelShrink();
  }, [backup]);

  // Focus trap + Esc (受け入れ基準 3 / 6: モーダル離脱の全経路でドラフト破棄). The
  // trap logic is the shared a11y helper (教訓 5.13 単一の真実源).
  const onKeyDown = useModalKeydown(dialogRef, cancelAndClose);

  // Arrow-key traversal between the scope tabs (WAI-ARIA tablist pattern). Focus
  // FOLLOWS the arrow (setTab alone would leave DOM focus on the old tab, violating the
  // tablist contract), so move focus to the target tab too (bughunt review #2).
  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const next = nextTabForArrow(SETTINGS_TAB_ORDER, tab, e.key);
      if (next === null) return;
      e.preventDefault();
      setTab(next);
      document.getElementById(`settings-tab-${next}`)?.focus();
    },
    [tab],
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
            id="settings-tab-project"
            aria-controls="settings-panel-project"
            aria-selected={tab === SETTINGS_TAB.Project}
            data-testid="settings-tab-project"
            onClick={() => setTab(SETTINGS_TAB.Project)}
            onKeyDown={onTabKeyDown}
          >
            {SETTINGS_STRINGS.tabProject}
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-app"
            aria-controls="settings-panel-app"
            aria-selected={tab === SETTINGS_TAB.App}
            data-testid="settings-tab-app"
            onClick={() => setTab(SETTINGS_TAB.App)}
            onKeyDown={onTabKeyDown}
          >
            {SETTINGS_STRINGS.tabApp}
          </button>
          <button
            type="button"
            role="tab"
            id="settings-tab-backup"
            aria-controls="settings-panel-backup"
            aria-selected={tab === SETTINGS_TAB.Backup}
            data-testid="settings-tab-backup"
            onClick={() => setTab(SETTINGS_TAB.Backup)}
            onKeyDown={onTabKeyDown}
          >
            {SETTINGS_STRINGS.tabBackup}
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

        {/* Both panels are ALWAYS rendered; the inactive one carries `hidden` so each
            tab's aria-controls IDREF always points at an existing panel (review #3: a
            three-way render left the non-active tab's aria-controls dangling). Mirrors
            the Sidebar tablist. */}
        <div className="settings-dialog__body">
          <ProjectTab
            dialog={dialog}
            canEdit={canEdit}
            onRequestBasemapReplace={onRequestBasemapReplace}
            hidden={tab !== SETTINGS_TAB.Project}
          />
          <AppTab dialog={dialog} hidden={tab !== SETTINGS_TAB.App} />
          <BackupTab
            backup={backup}
            hidden={tab !== SETTINGS_TAB.Backup}
            onApply={() => {
              setCloseAfterShrink(false);
              void backup.apply();
            }}
            onConfirmShrink={() => void confirmShrink()}
            onCancelShrink={cancelShrink}
          />
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
            disabled={backup.writing}
            onClick={() => void saveAndClose()}
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
  /** K-6: false =「読むだけ」。このタブの部品はすべて無効になる（教訓 5.13）。 */
  readonly canEdit: boolean;
  readonly onRequestBasemapReplace?: (() => void) | undefined;
  /** Hide (but keep mounted) when the app tab is active, so aria-controls stays valid. */
  readonly hidden: boolean;
}): JSX.Element {
  const { dialog, canEdit, onRequestBasemapReplace, hidden } = props;
  const d = dialog.projectDraft;
  const set = dialog.setProjectField;

  const setNum = (key: ProjectSettingKey, raw: string): void => {
    const n = Number(raw);
    set(key as never, n as never);
  };

  // K-6: このタブの部品は 1 つ残らずこの 1 変数から disabled を引く（教訓 5.13「部品
  // ごとに個別判定を書くと、見た目だけ非表示で…操作が残る」）。個別に条件を書き分けて
  // よいのは「結線が無い」ことによる無効（ベースマップの起動点）だけで、それも権限側
  // の判定と OR で重ねる。
  const readOnly = !canEdit;

  return (
    <section
      className="settings-section settings-section--project"
      data-testid="settings-project"
      role="tabpanel"
      id="settings-panel-project"
      aria-labelledby="settings-tab-project"
      hidden={hidden}
    >
      <p className="settings-section__hint">{SETTINGS_STRINGS.projectScopeHint}</p>

      {/* K-6: なぜ触れないのかを画面に出す（無効化だけだと「壊れている」に見える）。 */}
      {readOnly && (
        <p className="settings-section__readonly" data-testid="settings-project-readonly">
          {SETTINGS_STRINGS.projectReadOnlyHint}
        </p>
      )}

      <label>
        {PROJECT_FIELD_STRINGS.projectName}
        <input
          type="text"
          aria-label={PROJECT_FIELD_STRINGS.projectName}
          value={d.projectName}
          disabled={readOnly}
          onChange={(e) => set('projectName', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.projectDescription}
        <textarea
          aria-label={PROJECT_FIELD_STRINGS.projectDescription}
          value={d.projectDescription}
          disabled={readOnly}
          onChange={(e) => set('projectDescription', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.equatorLengthKm}
        <input
          type="number"
          aria-label={PROJECT_FIELD_STRINGS.equatorLengthKm}
          value={d.equatorLengthKm}
          disabled={readOnly}
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
          disabled={readOnly}
          onChange={(e) => setNum('flattening', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.timelineMinYear}
        <input
          type="number"
          aria-label={PROJECT_FIELD_STRINGS.timelineMinYear}
          value={d.timelineMinYear}
          disabled={readOnly}
          onChange={(e) => setNum('timelineMinYear', e.target.value)}
        />
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.timelineMaxYear}
        <input
          type="number"
          aria-label={PROJECT_FIELD_STRINGS.timelineMaxYear}
          value={d.timelineMaxYear}
          disabled={readOnly}
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
          disabled={readOnly}
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
          disabled={readOnly}
          onChange={(e) => setNum('zoomMax', e.target.value)}
        />
      </label>

      {/* FR-13 グリッド ON/OFF切替 (受け入れ基準 9): a checkbox in the SAME grid group
          as 間隔/色/不透明度 (FR-109 永続プロジェクト設定). Rides the existing
          validation→updateProjectSetting confirm flow like every other project field. */}
      <label>
        <input
          type="checkbox"
          data-testid="settings-grid-visible"
          aria-label={PROJECT_FIELD_STRINGS.gridVisible}
          checked={d.gridVisible}
          disabled={readOnly}
          onChange={(e) => set('gridVisible', e.target.checked)}
        />
        {PROJECT_FIELD_STRINGS.gridVisible}
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.gridSpacingDeg}
        <select
          aria-label={PROJECT_FIELD_STRINGS.gridSpacingDeg}
          value={d.gridSpacingDeg}
          disabled={readOnly}
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
          disabled={readOnly}
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
          disabled={readOnly}
          onChange={(e) => setNum('gridOpacity', e.target.value)}
        />
      </label>

      {/* Base-map: REQUEST起動点 only; replacement is U18's (受け入れ基準 1).
          K-6: 差し替えは保存ファイルの背景地図そのものを入れ替えるので「読むだけ」では
          止める。無効化に加えて**押下ハンドラでも `canEdit` を確かめる** — 見た目を
          塞ぐだけだと、この起動点に別経路（ショートカット・自動化・将来の再結線）が
          生えたときに素通りする（教訓 5.13）。 */}
      <div className="settings-field settings-field--basemap">
        <span className="settings-field__label">{PROJECT_FIELD_STRINGS.baseMapId}</span>
        <button
          type="button"
          data-testid="settings-basemap-replace"
          disabled={readOnly || onRequestBasemapReplace === undefined}
          onClick={() => {
            if (readOnly) return;
            onRequestBasemapReplace?.();
          }}
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
          disabled={readOnly}
          onChange={(e) => setNum('areaLabelOccupancyThreshold', e.target.value)}
        />
      </label>

      <label>
        <input
          type="checkbox"
          aria-label={PROJECT_FIELD_STRINGS.newAreaAutoColorDefault}
          checked={d.newAreaAutoColorDefault}
          disabled={readOnly}
          onChange={(e) => set('newAreaAutoColorDefault', e.target.checked)}
        />
        {PROJECT_FIELD_STRINGS.newAreaAutoColorDefault}
      </label>

      <label>
        {PROJECT_FIELD_STRINGS.defaultPaletteTheme}
        <select
          aria-label={PROJECT_FIELD_STRINGS.defaultPaletteTheme}
          value={d.defaultPaletteTheme}
          disabled={readOnly}
          onChange={(e) => set('defaultPaletteTheme', e.target.value)}
        >
          {PALETTE_THEME_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <CustomPaletteEditor dialog={dialog} readOnly={readOnly} />
    </section>
  );
}

// --- Custom palette management (FR-109 / FR-102) ----------------------------

function CustomPaletteEditor(props: {
  readonly dialog: ReturnType<typeof useSettingsDialog>;
  /** K-6: true =「読むだけ」。色の追加・変更・削除をすべて塞ぐ（教訓 5.13）。 */
  readonly readOnly: boolean;
}): JSX.Element {
  const { dialog, readOnly } = props;
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
              aria-label={SETTINGS_DIALOG_TEXT.customPaletteColorLabel(String(i + 1))}
              value={color}
              disabled={readOnly}
              onChange={(e) => setAt(i, e.target.value)}
            />
            <button
              type="button"
              data-testid={`settings-palette-remove-${String(i)}`}
              disabled={readOnly}
              onClick={() => removeAt(i)}
            >
              {PALETTE_STRINGS.remove}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="settings-palette-add"
        disabled={readOnly}
        onClick={add}
      >
        {PALETTE_STRINGS.add}
      </button>
    </fieldset>
  );
}

// --- App-wide tab (FR-110) ---------------------------------------------------

function AppTab(props: {
  readonly dialog: ReturnType<typeof useSettingsDialog>;
  /** Hide (but keep mounted) when the project tab is active, so aria-controls stays valid. */
  readonly hidden: boolean;
}): JSX.Element {
  const { dialog, hidden } = props;
  const d = dialog.appDraft;
  const set = dialog.setAppField;

  return (
    <section
      className="settings-section settings-section--app"
      data-testid="settings-app"
      role="tabpanel"
      id="settings-panel-app"
      aria-labelledby="settings-tab-app"
      hidden={hidden}
    >
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

      {/* 初回起動のガイド（増分 6 / 設計書 §H.3）。**恒久 OFF にした人が戻せる場所**が
          ここである ―― ガイドの「今後表示しない」を押したきり二度と出せない、を作らない。 */}
      <label>
        <input
          type="checkbox"
          aria-label={APP_FIELD_STRINGS.showFirstRunGuide}
          checked={d.showFirstRunGuide}
          onChange={(e) => set('showFirstRunGuide', e.target.checked)}
        />
        {APP_FIELD_STRINGS.showFirstRunGuide}
      </label>
    </section>
  );
}

// --- 保存とバックアップ（増分 8D / 設計書 G-5・FR-108、V12 の合格条件④）---------------

function generationText(backup: UseBackupSettings): string {
  const g = backup.generations;
  switch (g.kind) {
    case 'loading':
      return BACKUP_SETTINGS_STRINGS.generationLoading;
    case 'unavailable':
      return BACKUP_SETTINGS_STRINGS.generationUnavailable;
    case 'no-basis':
      return BACKUP_SETTINGS_STRINGS.generationNoBasis;
    case 'ready':
      return g.count === 0
        ? BACKUP_SETTINGS_STRINGS.generationNone
        : BACKUP_SETTINGS_STRINGS.generationCount(g.sourceName, g.count);
    default: {
      const never: never = g;
      return never;
    }
  }
}

/**
 * 自動保存の間隔と残す世代の数。**アプリ全体の設定**なので「読むだけ」でも変えられる
 * （アプリ全体設定タブと同じ扱い。K-6 はプロジェクト設定だけを止める）。
 * ［適用］はこの節だけをその場で書き、ダイアログは閉じない。
 */
function BackupTab(props: {
  readonly backup: UseBackupSettings;
  readonly hidden: boolean;
  readonly onApply: () => void;
  readonly onConfirmShrink: () => void;
  readonly onCancelShrink: () => void;
}): JSX.Element {
  const { backup, hidden, onApply, onConfirmShrink, onCancelShrink } = props;
  // 読み終わるまでと、書き込み中は欄とボタンを止める（増分 8D の手直し: 応答が、待っている
  // 間に打った値を消さないように）。
  const loading = backup.saved === null;
  const locked = loading || backup.writing;
  // 世代数を下げたのに、いま開いているファイルで消える数を出せない（どのファイルか分からない・
  // このファイルでは消えない）。数は出せないが、ほかのファイルで消えることは先に言う。
  const draftGenerations = Number.parseInt(backup.generationsDraft.trim(), 10);
  const loweredWithoutCount =
    backup.saved !== null &&
    backup.shrinkPreview === null &&
    backup.pendingShrink === null &&
    Number.isInteger(draftGenerations) &&
    draftGenerations < backup.saved.backupGenerations;
  const errorFor = (field: 'autoSaveIntervalMinutes' | 'backupGenerations'): string | undefined =>
    backup.errors.find((e) => e.field === field)?.message;
  const intervalError = errorFor('autoSaveIntervalMinutes');
  const generationsError = errorFor('backupGenerations');
  return (
    <section
      className="settings-section settings-section--backup"
      data-testid="settings-backup"
      role="tabpanel"
      id="settings-panel-backup"
      aria-labelledby="settings-tab-backup"
      hidden={hidden}
    >
      <p className="settings-section__hint">{BACKUP_SETTINGS_STRINGS.hint}</p>

      <label>
        {BACKUP_SETTINGS_STRINGS.interval}
        <input
          type="number"
          min={AUTO_SAVE_INTERVAL_MINUTES_RANGE.min}
          max={AUTO_SAVE_INTERVAL_MINUTES_RANGE.max}
          step={1}
          data-testid="settings-backup-interval"
          aria-label={BACKUP_SETTINGS_STRINGS.interval}
          aria-invalid={intervalError !== undefined}
          value={backup.intervalDraft}
          disabled={locked}
          onChange={(e) => backup.setIntervalDraft(e.target.value)}
        />
      </label>
      {intervalError !== undefined && (
        <p className="settings-field__error" role="alert" data-testid="settings-backup-interval-error">
          {intervalError}
        </p>
      )}

      <label>
        {BACKUP_SETTINGS_STRINGS.generations}
        <input
          type="number"
          min={BACKUP_GENERATIONS_RANGE.min}
          max={BACKUP_GENERATIONS_RANGE.max}
          step={1}
          data-testid="settings-backup-generations"
          aria-label={BACKUP_SETTINGS_STRINGS.generations}
          aria-invalid={generationsError !== undefined}
          value={backup.generationsDraft}
          disabled={locked}
          onChange={(e) => backup.setGenerationsDraft(e.target.value)}
        />
      </label>
      {generationsError !== undefined && (
        <p
          className="settings-field__error"
          role="alert"
          data-testid="settings-backup-generations-error"
        >
          {generationsError}
        </p>
      )}
      {/* 増分 8D の手直し: 世代数を下げると次の保存で消える数を、［適用］の前から出す。 */}
      {backup.shrinkPreview !== null && backup.pendingShrink === null && (
        <p className="settings-section__hint" data-testid="settings-backup-shrink-preview">
          {BACKUP_SETTINGS_STRINGS.shrinkPreview(
            backup.shrinkPreview.sourceName,
            backup.shrinkPreview.deleteCount,
            backup.shrinkPreview.keep,
          )}
        </p>
      )}
      {loweredWithoutCount && (
        <p className="settings-section__hint" data-testid="settings-backup-shrink-generic">
          {BACKUP_SETTINGS_STRINGS.shrinkGeneric}
        </p>
      )}
      {backup.pendingShrink !== null && (
        <div className="settings-backup__confirm" role="alert" data-testid="settings-backup-shrink-confirm">
          <p>
            {backup.pendingShrink.known === null
              ? BACKUP_SETTINGS_STRINGS.shrinkConfirmGeneric(backup.pendingShrink.keep)
              : BACKUP_SETTINGS_STRINGS.shrinkConfirm(
                  backup.pendingShrink.known.sourceName,
                  backup.pendingShrink.known.deleteCount,
                )}
          </p>
          <button
            type="button"
            data-testid="settings-backup-shrink-yes"
            disabled={backup.writing}
            onClick={onConfirmShrink}
          >
            {BACKUP_SETTINGS_STRINGS.shrinkConfirmYes}
          </button>
          <button
            type="button"
            data-testid="settings-backup-shrink-no"
            disabled={backup.writing}
            onClick={onCancelShrink}
          >
            {BACKUP_SETTINGS_STRINGS.shrinkConfirmNo}
          </button>
        </div>
      )}

      <div className="settings-backup__actions">
        <button
          type="button"
          data-testid="settings-backup-apply"
          disabled={locked || backup.pendingShrink !== null}
          onClick={onApply}
        >
          {BACKUP_SETTINGS_STRINGS.apply}
        </button>
        {backup.appliedOnce && !backup.dirty && (
          <span className="settings-backup__applied" data-testid="settings-backup-applied">
            {BACKUP_SETTINGS_STRINGS.applied}
          </span>
        )}
      </div>
      {backup.writeError !== null && (
        <p className="settings-field__error" role="alert" data-testid="settings-backup-write-error">
          {backup.writeError}
        </p>
      )}

      <p className="settings-section__hint" data-testid="settings-backup-generation-count">
        {generationText(backup)}
      </p>
      <p className="settings-section__hint">{BACKUP_SETTINGS_STRINGS.autoSaveNote}</p>
    </section>
  );
}
