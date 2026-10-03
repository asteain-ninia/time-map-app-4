// UI layer (増分 8D / 設計書 G-5・FR-108、V12 の合格条件④): 設定の「保存とバックアップ」。
//
// 自動保存の間隔（分）と残す世代の数は **アプリ全体の設定** で、保存ファイルではなく
// この PC の userData（`app-prefs.json`）に置く（教訓 5.36 の境界: どのプロジェクトを
// 開いても同じ間隔）。だから設定ダイアログの下書き（ストアのプロジェクト設定・アプリ全体
// 設定）とは別の口で読み書きする: 読むのも書くのも型付きの IPC（`readAppPrefs` /
// `writeAppPrefs`）で、主プロセスが書いたその場で自動保存へ効かせる。
//
// 下書きは文字列のまま持つ（打ちかけの「1」「12」を数へ丸めない）。［適用］とダイアログの
// ［保存］で検証し、範囲外なら理由を出して書かない（教訓 5.26: 拒否理由は戻り値と画面の両方）。
//
// **いま世代がいくつ溜まっているか**も出す（設計書 §E.1 の V12 手順 (b)。V14 の入口）。
// 数えるのは主プロセスの `listBackups`（パスは来ない）。

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AUTO_SAVE_INTERVAL_MINUTES_RANGE,
  BACKUP_GENERATIONS_RANGE,
  type AppPrefs,
  type BackupEntry,
} from '../../shell/ipc/contract';
import { BACKUP_SETTINGS_STRINGS } from './strings';

/** この節が使う口（`window.timeMapApi` の一部。単体テストは偽物を渡す）。 */
export interface BackupSettingsPort {
  readonly readAppPrefs: () => Promise<AppPrefs>;
  readonly writeAppPrefs: (patch: Partial<AppPrefs>) => Promise<AppPrefs>;
  readonly listBackups: () => Promise<readonly BackupEntry[]>;
}

/** 世代の数の読み取り状態。 */
export type GenerationCount =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly count: number; readonly sourceName: string | null }
  | { readonly kind: 'unavailable' };

export interface BackupSettingsField {
  readonly field: 'autoSaveIntervalMinutes' | 'backupGenerations';
  readonly message: string;
}

export interface UseBackupSettings {
  /** 保存してあった値（読み終わるまで null）。 */
  readonly saved: AppPrefs | null;
  /** 下書き（打ったままの文字列）。 */
  readonly intervalDraft: string;
  readonly generationsDraft: string;
  readonly setIntervalDraft: (value: string) => void;
  readonly setGenerationsDraft: (value: string) => void;
  /** 直前の［適用］で出た理由（次の［適用］まで残す。教訓 5.12）。 */
  readonly errors: readonly BackupSettingsField[];
  /** 直前の［適用］が書けたか（「適用しました」を出す）。 */
  readonly appliedOnce: boolean;
  readonly generations: GenerationCount;
  /** 下書きが保存してある値と違うか。 */
  readonly dirty: boolean;
  /**
   * 検証して書く。書いたら true、理由があって書かなかったら false。変わっていなければ
   * 何もせず true（教訓 5.24 の no-op ガード）。
   */
  readonly apply: () => Promise<boolean>;
  /** 書かずに検証だけする（ダイアログの［保存］が先に見る）。 */
  readonly validate: () => readonly BackupSettingsField[];
}

/** 範囲内の整数に読めれば数、読めなければ null。 */
function parseIntegerIn(raw: string, range: { readonly min: number; readonly max: number }): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return value >= range.min && value <= range.max ? value : null;
}

/** 下書きを検証する（純粋）。 */
export function validateBackupDraft(
  intervalDraft: string,
  generationsDraft: string,
): { readonly ok: true; readonly value: Pick<AppPrefs, 'autoSaveIntervalMinutes' | 'backupGenerations'> } | { readonly ok: false; readonly errors: readonly BackupSettingsField[] } {
  const interval = parseIntegerIn(intervalDraft, AUTO_SAVE_INTERVAL_MINUTES_RANGE);
  const generations = parseIntegerIn(generationsDraft, BACKUP_GENERATIONS_RANGE);
  const errors: BackupSettingsField[] = [];
  if (interval === null) {
    errors.push({ field: 'autoSaveIntervalMinutes', message: BACKUP_SETTINGS_STRINGS.intervalInvalid });
  }
  if (generations === null) {
    errors.push({ field: 'backupGenerations', message: BACKUP_SETTINGS_STRINGS.generationsInvalid });
  }
  if (interval === null || generations === null) return { ok: false, errors };
  return { ok: true, value: { autoSaveIntervalMinutes: interval, backupGenerations: generations } };
}

export function useBackupSettings(port: BackupSettingsPort | undefined): UseBackupSettings {
  const [saved, setSaved] = useState<AppPrefs | null>(null);
  const [intervalDraft, setIntervalDraft] = useState('');
  const [generationsDraft, setGenerationsDraft] = useState('');
  const [errors, setErrors] = useState<readonly BackupSettingsField[]>([]);
  const [appliedOnce, setAppliedOnce] = useState(false);
  const [generations, setGenerations] = useState<GenerationCount>({ kind: 'loading' });
  // 閉じたあとに届いた応答で state を書かない（警告と、閉じた板の再描画を避ける）。
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (port === undefined) {
      setGenerations({ kind: 'unavailable' });
      return;
    }
    void port
      .readAppPrefs()
      .then((prefs) => {
        if (!aliveRef.current) return;
        setSaved(prefs);
        setIntervalDraft(String(prefs.autoSaveIntervalMinutes));
        setGenerationsDraft(String(prefs.backupGenerations));
      })
      .catch(() => undefined);
    void port
      .listBackups()
      .then((entries) => {
        if (!aliveRef.current) return;
        setGenerations({
          kind: 'ready',
          count: entries.length,
          sourceName: entries[0]?.sourceName ?? null,
        });
      })
      .catch(() => {
        if (aliveRef.current) setGenerations({ kind: 'unavailable' });
      });
  }, [port]);

  const dirty =
    saved !== null &&
    (intervalDraft.trim() !== String(saved.autoSaveIntervalMinutes) ||
      generationsDraft.trim() !== String(saved.backupGenerations));

  const validate = useCallback((): readonly BackupSettingsField[] => {
    const result = validateBackupDraft(intervalDraft, generationsDraft);
    return result.ok ? [] : result.errors;
  }, [intervalDraft, generationsDraft]);

  const apply = useCallback(async (): Promise<boolean> => {
    if (port === undefined || saved === null) return true;
    const result = validateBackupDraft(intervalDraft, generationsDraft);
    if (!result.ok) {
      setErrors(result.errors);
      setAppliedOnce(false);
      return false;
    }
    setErrors([]);
    if (
      result.value.autoSaveIntervalMinutes === saved.autoSaveIntervalMinutes &&
      result.value.backupGenerations === saved.backupGenerations
    ) {
      return true;
    }
    const next = await port.writeAppPrefs(result.value);
    if (aliveRef.current) {
      setSaved(next);
      setIntervalDraft(String(next.autoSaveIntervalMinutes));
      setGenerationsDraft(String(next.backupGenerations));
      setAppliedOnce(true);
    }
    return true;
  }, [port, saved, intervalDraft, generationsDraft]);

  return {
    saved,
    intervalDraft,
    generationsDraft,
    setIntervalDraft,
    setGenerationsDraft,
    errors,
    appliedOnce,
    generations,
    dirty,
    apply,
    validate,
  };
}
