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
// 数えるのは主プロセスの `countBackups`（ファイルを 1 つも開かない。パスは来ない）。
//
// 増分 8D の手直し:
//   - **世代数を下げると、次の保存で古い世代がまとめて消える**。いまの数から消える数を出し、
//     消える数が 1 つ以上なら［適用］／［保存］の前に確認を挟む（やめれば値は戻る）。
//   - **書き込みの成否を見る**。書けなかったら入力を残して理由を出す（以前は「適用しました」と
//     出し、再起動で既定へ戻って次の保存で世代が消えた）。
//   - **書き込み中は欄とボタンを止め**、応答が来ても、頼んだあとに打ち直された下書きは上書き
//     しない（以前は応答が、待っている間に打った値を消した）。

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AUTO_SAVE_INTERVAL_MINUTES_RANGE,
  BACKUP_GENERATIONS_RANGE,
  type AppPrefs,
  type AppPrefsWriteResult,
  type BackupCount,
} from '../../shell/ipc/contract';
import { BACKUP_SETTINGS_STRINGS } from './strings';

/** この節が使う口（`window.timeMapApi` の一部。単体テストは偽物を渡す）。 */
export interface BackupSettingsPort {
  readonly readAppPrefs: () => Promise<AppPrefs>;
  readonly writeAppPrefs: (patch: Partial<AppPrefs>) => Promise<AppPrefsWriteResult>;
  readonly countBackups: () => Promise<BackupCount>;
}

/** 世代の数の読み取り状態。 */
export type GenerationCount =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly count: number; readonly sourceName: string }
  /** どのファイルの世代を数えればよいか分からない（新規・開けなかったファイル）。 */
  | { readonly kind: 'no-basis' }
  | { readonly kind: 'unavailable' };

export interface BackupSettingsField {
  readonly field: 'autoSaveIntervalMinutes' | 'backupGenerations';
  readonly message: string;
}

/**
 * 世代数を下げたときに、次の保存で消える世代（増分 8D の手直し）。`deleteCount` が 1 以上の
 * ときだけ作る。
 */
export interface GenerationShrink {
  readonly sourceName: string;
  /** 次の保存で消える古い世代の数。 */
  readonly deleteCount: number;
  /** 残す世代の数（下書きの値）。 */
  readonly keep: number;
}

/**
 * 世代数を下げたときの確認（増分 8D の再手直し・司令塔の決定 2-3）。**下げたら必ず出す** ――
 * 開いているファイルが無くて数が分からなくても、ほかのファイルの世代は次に保存したときに
 * 新しい数を超える分だけ消えるので、確認なしに消える経路を残さない。いま開いているファイルで
 * 消える数が分かれば `known` に入れる（数を添えて言う）。
 */
export interface GenerationShrinkConfirm {
  /** 残す世代の数（下書きの値）。 */
  readonly keep: number;
  /** いま開いているファイルで次の保存に消える数（分からない・0 なら null）。 */
  readonly known: GenerationShrink | null;
}

/** ［適用］の結末。 */
export type BackupApplyOutcome =
  /** 書けた。 */
  | 'applied'
  /** 変わっていないので何もしなかった。 */
  | 'unchanged'
  /** 範囲外などで書かなかった（理由は `errors`）。 */
  | 'invalid'
  /** 世代が消えるので確認を出した（`pendingShrink`）。まだ書いていない。 */
  | 'needs-confirm'
  /** 書けなかった（理由は `writeError`。入力は残す）。 */
  | 'failed'
  /** 書き込み中なので落とした。 */
  | 'busy';

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
  /** 直前の書き込みが失敗した理由（次の［適用］まで残す）。 */
  readonly writeError: string | null;
  /** 書き込み中（欄とボタンを止める）。 */
  readonly writing: boolean;
  readonly generations: GenerationCount;
  /** 下書きが保存してある値と違うか。 */
  readonly dirty: boolean;
  /**
   * いまの下書きのまま書くと、次の保存で消える世代（世代数を下げたときだけ。消える数が 0 なら
   * null）。欄の下に先に出す。
   */
  readonly shrinkPreview: GenerationShrink | null;
  /** 確認を待っている「世代が消える」書き込み（［適用］／［保存］で、下げたら必ず出る）。 */
  readonly pendingShrink: GenerationShrinkConfirm | null;
  /**
   * 検証して書く。世代数を下げて世代が消えるなら、`confirmShrink` が無い限り書かずに確認を
   * 出す。変わっていなければ何もしない（教訓 5.24 の no-op ガード）。
   */
  readonly apply: (options?: { readonly confirmShrink?: boolean }) => Promise<BackupApplyOutcome>;
  /** 「世代が消える」確認でやめる。世代数の下書きは保存してある値へ戻る。 */
  readonly cancelShrink: () => void;
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

/**
 * 世代数を `current` から `next` へ下げたとき、次の保存で消える世代の数（純粋）。
 *
 * 保存は世代を 1 つ足してから、上限を超えた古いものを消す。だから今 `count` 個あるとき、
 * 次の保存で消えるのは `count + 1 − next` 個（0 未満なら 0）。**下げたときだけ**数える ――
 * 上げた・同じときの「いつもの 1 個の入れ替わり」は利用者が選んだ結果ではない。
 */
export function generationsToDelete(count: number, current: number, next: number): number {
  if (next >= current) return 0;
  return Math.max(0, count + 1 - next);
}

export function useBackupSettings(port: BackupSettingsPort | undefined): UseBackupSettings {
  const [saved, setSaved] = useState<AppPrefs | null>(null);
  const [intervalDraft, setIntervalDraftState] = useState('');
  const [generationsDraft, setGenerationsDraftState] = useState('');
  const [errors, setErrors] = useState<readonly BackupSettingsField[]>([]);
  const [appliedOnce, setAppliedOnce] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [pendingShrink, setPendingShrink] = useState<GenerationShrinkConfirm | null>(null);
  const [generations, setGenerations] = useState<GenerationCount>({ kind: 'loading' });
  // 閉じたあとに届いた応答で state を書かない（警告と、閉じた板の再描画を避ける）。
  const aliveRef = useRef(true);
  // 下書きの版。打つたびに進む。書き込みの応答は、頼んだときから版が動いていなければだけ
  // 下書きを書き替える（待っている間に打った値を消さない。GPT 指摘 4）。
  const draftVersionRef = useRef(0);
  // 書き込み中の印（state は描画の都合で遅れるので、二重の書き込みは ref で止める）。
  const writingRef = useRef(false);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const setIntervalDraft = useCallback((value: string) => {
    draftVersionRef.current += 1;
    setIntervalDraftState(value);
  }, []);
  const setGenerationsDraft = useCallback((value: string) => {
    draftVersionRef.current += 1;
    setGenerationsDraftState(value);
    setPendingShrink(null);
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
        setIntervalDraftState(String(prefs.autoSaveIntervalMinutes));
        setGenerationsDraftState(String(prefs.backupGenerations));
      })
      .catch(() => undefined);
    void port
      .countBackups()
      .then((counted) => {
        if (!aliveRef.current) return;
        setGenerations(
          counted.basis === 'none'
            ? { kind: 'no-basis' }
            : { kind: 'ready', count: counted.count, sourceName: counted.sourceName },
        );
      })
      .catch(() => {
        if (aliveRef.current) setGenerations({ kind: 'unavailable' });
      });
  }, [port]);

  const dirty =
    saved !== null &&
    (intervalDraft.trim() !== String(saved.autoSaveIntervalMinutes) ||
      generationsDraft.trim() !== String(saved.backupGenerations));

  /** 下書きの世代数で、次の保存で消える世代（消えないなら null）。 */
  const shrinkFor = useCallback(
    (nextGenerations: number): GenerationShrink | null => {
      if (saved === null || generations.kind !== 'ready') return null;
      const deleteCount = generationsToDelete(generations.count, saved.backupGenerations, nextGenerations);
      return deleteCount > 0
        ? { sourceName: generations.sourceName, deleteCount, keep: nextGenerations }
        : null;
    },
    [saved, generations],
  );

  const draftGenerations = parseIntegerIn(generationsDraft, BACKUP_GENERATIONS_RANGE);
  const shrinkPreview = draftGenerations === null ? null : shrinkFor(draftGenerations);

  const validate = useCallback((): readonly BackupSettingsField[] => {
    const result = validateBackupDraft(intervalDraft, generationsDraft);
    return result.ok ? [] : result.errors;
  }, [intervalDraft, generationsDraft]);

  const apply = useCallback(
    async (options?: { readonly confirmShrink?: boolean }): Promise<BackupApplyOutcome> => {
      if (port === undefined || saved === null) return 'unchanged';
      if (writingRef.current) return 'busy';
      const result = validateBackupDraft(intervalDraft, generationsDraft);
      if (!result.ok) {
        setErrors(result.errors);
        setAppliedOnce(false);
        return 'invalid';
      }
      setErrors([]);
      if (
        result.value.autoSaveIntervalMinutes === saved.autoSaveIntervalMinutes &&
        result.value.backupGenerations === saved.backupGenerations
      ) {
        setPendingShrink(null);
        return 'unchanged';
      }
      // 世代数を下げたら、確かめてから書く（増分 8D の手直し）。再手直し（司令塔の決定 2-3）:
      // 開いているファイルが無くて数が分からなくても **いつも** 確かめる。
      const nextGenerations = result.value.backupGenerations;
      if (nextGenerations < saved.backupGenerations && options?.confirmShrink !== true) {
        setPendingShrink({ keep: nextGenerations, known: shrinkFor(nextGenerations) });
        setAppliedOnce(false);
        return 'needs-confirm';
      }
      setPendingShrink(null);
      writingRef.current = true;
      setWriting(true);
      setWriteError(null);
      const versionAtRequest = draftVersionRef.current;
      let written: AppPrefsWriteResult;
      try {
        written = await port.writeAppPrefs(result.value);
      } catch (error) {
        written = {
          ok: false,
          prefs: saved,
          message: BACKUP_SETTINGS_STRINGS.writeFailed(error instanceof Error ? error.message : ''),
        };
      } finally {
        writingRef.current = false;
      }
      if (!aliveRef.current) return written.ok ? 'applied' : 'failed';
      setWriting(false);
      if (!written.ok) {
        // 入力は残す（打った値を黙って消さない）。理由を出し、効いている値は書けなかった前のまま。
        setSaved(written.prefs);
        setWriteError(written.message);
        setAppliedOnce(false);
        return 'failed';
      }
      setSaved(written.prefs);
      // 頼んだあとで打ち直された下書きは上書きしない（待っている間に打った値を消さない）。
      if (draftVersionRef.current === versionAtRequest) {
        setIntervalDraftState(String(written.prefs.autoSaveIntervalMinutes));
        setGenerationsDraftState(String(written.prefs.backupGenerations));
      }
      setAppliedOnce(true);
      return 'applied';
    },
    [port, saved, intervalDraft, generationsDraft, shrinkFor],
  );

  const cancelShrink = useCallback(() => {
    setPendingShrink(null);
    if (saved !== null) {
      draftVersionRef.current += 1;
      setGenerationsDraftState(String(saved.backupGenerations));
    }
  }, [saved]);

  return {
    saved,
    intervalDraft,
    generationsDraft,
    setIntervalDraft,
    setGenerationsDraft,
    errors,
    appliedOnce,
    writeError,
    writing,
    generations,
    dirty,
    shrinkPreview,
    pendingShrink,
    apply,
    cancelShrink,
    validate,
  };
}
