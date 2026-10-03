// UI layer (増分 8D): 「以前の保存から開く」の世代の一覧（設計書 §E.1 の V14 の手順 (a)）。
//
// 保存のたびに保存ファイルの隣へ残る世代（`<名前>.bak.<時刻>-<連番>`）を、主プロセスが
// 一覧にして返す（`listBackups`）。この板はそれを **日時・大きさ・地物数** で並べ、行を押すと
// その世代の id を返すだけの表示である。未保存の確認・読み込み・修復・保存先を確定させない
// 規則は、呼び出し側（`openBackupCommand` と保存文脈）が受け持つ。
//
// 行は 1 つずつボタンになっていて、**押すとそのまま開く**（設計書の手順は「行を選ぶ」の次が
// 未保存の確認で、別の［開く］を挟まない）。やめるのは［やめる］・Esc・閉じるボタン。
//
// **板が出ている間は鍵盤の持ち主を名乗る**（`useModalRegistration`。司令塔の決定 (13)）。
// 名乗らないと、板の上で Ctrl+Z が背後へ抜けて世界が巻き戻る。
//
// 増分 8D の手直し:
//   - **どのファイルの世代を見ればよいか分からない**（新規・元のファイルが壊れて開けなかった）
//     ときは「戻せる世代はまだありません」と言わない（事実に反する）。「開いているファイルが
//     ありません。元のファイルを選ぶと、その世代を一覧します」と［元のファイルを選ぶ…］を出す。
//   - 地物数は板を出したあとで 1 行ずつ埋まる（数えている間は「…」、読めなければ「—」）。

import { useCallback, useEffect, useRef } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { formatTimestamp } from '../shell/status-format';
import { useModalKeydown } from '../a11y/index';
import { useModalRegistration } from '../a11y/useModalRegistration';
import type { BackupEntry, BackupListing } from '../../shell/ipc/contract';
import { BACKUP_LIST_STRINGS, BACKUP_LIST_TEXT } from './strings';

export interface BackupListDialogProps {
  /** 主プロセスが返した一覧（基準が無ければ `basis: 'none'`。行は新しい順）。 */
  readonly listing: BackupListing;
  /**
   * 後から数えた地物数（id → 数。読めなければ null）。一覧に数が入っていない行だけを見る。
   * 無い行は数えている途中なので「…」を出す。
   */
  readonly featureCounts?: ReadonlyMap<string, number | null> | undefined;
  /** 行を押したらその id、やめたら null。 */
  readonly onChoose: (id: string | null) => void;
  /**
   * 基準が無いときの［元のファイルを選ぶ…］（主プロセスの「開く」ダイアログで選ばせる）。
   * 無ければボタンを出さない。
   */
  readonly onPickSource?: (() => void) | undefined;
  /** 元のファイルを選んでいる最中（ボタンを止める）。 */
  readonly picking?: boolean | undefined;
  /** 板が出ている間は鍵盤の持ち主を名乗る（App の `toolModalChange('backup-list')`）。 */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
  /** Front-most z-index from U20's z-order model (FR-112 前面化). */
  readonly zIndex?: number;
}

const INITIAL_POSITION = { x: 320, y: 140 } as const;
const NO_ENTRIES: readonly BackupEntry[] = [];

/**
 * ファイルの大きさを読める形にする（「820 KB」「1.3 MB」）。1,024 で割る（OS の表示と同じ）。
 * ロケールに依らない（`toLocaleString` を使わない。status-format.ts の方針と同じ）。
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return BACKUP_LIST_TEXT.bytes(String(Math.round(bytes)));
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

/** 1 行の地物数の表示（数えている途中は「…」、読めなければ「—」）。 */
function featureText(
  entry: BackupEntry,
  counts: ReadonlyMap<string, number | null> | undefined,
): string {
  const count = entry.featureCount !== undefined ? entry.featureCount : counts?.get(entry.id);
  if (count === undefined) return BACKUP_LIST_STRINGS.countingFeatures;
  if (count === null) return BACKUP_LIST_STRINGS.unknownFeatures;
  return BACKUP_LIST_STRINGS.features(count);
}

export function BackupListDialog(props: BackupListDialogProps): JSX.Element {
  const { listing, featureCounts, onChoose, onPickSource, picking, onModalChange, zIndex } = props;
  const entries = listing.basis === 'file' ? listing.entries : NO_ENTRIES;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalRegistration(onModalChange, true);

  const cancel = useCallback(() => onChoose(null), [onChoose]);
  const onKeyDown = useModalKeydown(rootRef, cancel);

  // 開いたら焦点は先頭の行（いちばん新しい世代）へ。基準が無ければ［元のファイルを選ぶ…］へ。
  // どちらも無ければ板そのものへ。元のファイルを選んで一覧が差し替わったときも同じ。
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="backup-row"], [data-testid="backup-pick-source"]',
    );
    (first ?? rootRef.current)?.focus();
  }, [listing]);

  const sourceName = listing.basis === 'file' ? listing.sourceName : null;

  return (
    <div
      className="backup-modal-root"
      data-testid="backup-modal-root"
      role="dialog"
      aria-modal="true"
      aria-label={BACKUP_LIST_STRINGS.title}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <DraggablePanel
        id="backup-list"
        title={BACKUP_LIST_STRINGS.title}
        initialPosition={INITIAL_POSITION}
        zIndex={zIndex ?? 1000}
        onClose={cancel}
      >
        <div className="backup-dialog" data-testid="backup-dialog">
          {sourceName !== null && (
            <p className="backup-dialog__intro" data-testid="backup-intro">
              {BACKUP_LIST_STRINGS.intro(sourceName)}
            </p>
          )}
          {listing.basis === 'none' ? (
            <div className="backup-dialog__no-basis" data-testid="backup-no-basis">
              <p>{BACKUP_LIST_STRINGS.noBasis}</p>
              {onPickSource !== undefined && (
                <button
                  type="button"
                  className="backup-dialog__pick"
                  data-testid="backup-pick-source"
                  disabled={picking === true}
                  onClick={onPickSource}
                >
                  {BACKUP_LIST_STRINGS.pickSource}
                </button>
              )}
            </div>
          ) : entries.length === 0 ? (
            <p className="backup-dialog__empty" data-testid="backup-empty">
              {BACKUP_LIST_STRINGS.empty}
            </p>
          ) : (
            <>
              <div className="backup-dialog__head" aria-hidden="true">
                <span>{BACKUP_LIST_STRINGS.columnSavedAt}</span>
                <span>{BACKUP_LIST_STRINGS.columnSize}</span>
                <span>{BACKUP_LIST_STRINGS.columnFeatures}</span>
              </div>
              <ul className="backup-dialog__list" data-testid="backup-list">
                {entries.map((entry) => {
                  const savedAt = formatTimestamp(entry.savedAtMs);
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="backup-row"
                        data-testid="backup-row"
                        aria-label={BACKUP_LIST_STRINGS.openRow(savedAt)}
                        onClick={() => onChoose(entry.id)}
                      >
                        <span className="backup-row__saved-at" data-testid="backup-row-saved-at">
                          {savedAt}
                        </span>
                        <span className="backup-row__size" data-testid="backup-row-size">
                          {formatByteSize(entry.byteSize)}
                        </span>
                        <span className="backup-row__features" data-testid="backup-row-features">
                          {featureText(entry, featureCounts)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="backup-dialog__note" data-testid="backup-note">
                {BACKUP_LIST_STRINGS.note}
              </p>
            </>
          )}
          <div className="backup-dialog__actions">
            {/* 増分 8D の再手直し（司令塔の決定 2-4）: 元のファイルを選んだあとも選び直せる。
                選び間違えると、新規にするか別のファイルを開き終えるまで抜けられなかった。 */}
            {listing.basis === 'file' && onPickSource !== undefined && (
              <button
                type="button"
                className="backup-dialog__pick-other"
                data-testid="backup-pick-other"
                disabled={picking === true}
                onClick={onPickSource}
              >
                {BACKUP_LIST_STRINGS.pickOther}
              </button>
            )}
            <button
              type="button"
              className="backup-dialog__cancel"
              data-testid="backup-cancel"
              onClick={cancel}
            >
              {BACKUP_LIST_STRINGS.cancel}
            </button>
          </div>
        </div>
      </DraggablePanel>
    </div>
  );
}
