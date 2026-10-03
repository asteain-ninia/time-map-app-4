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

import { useCallback, useEffect, useRef } from 'react';

import { DraggablePanel } from '../shell/DraggablePanel';
import { formatTimestamp } from '../shell/status-format';
import { useModalKeydown } from '../a11y/index';
import { useModalRegistration } from '../a11y/useModalRegistration';
import type { BackupEntry } from '../../shell/ipc/contract';
import { BACKUP_LIST_STRINGS } from './strings';

export interface BackupListDialogProps {
  /** 主プロセスが返した世代（新しい順）。 */
  readonly entries: readonly BackupEntry[];
  /** 行を押したらその id、やめたら null。 */
  readonly onChoose: (id: string | null) => void;
  /** 板が出ている間は鍵盤の持ち主を名乗る（App の `toolModalChange('backup-list')`）。 */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
  /** Front-most z-index from U20's z-order model (FR-112 前面化). */
  readonly zIndex?: number;
}

const INITIAL_POSITION = { x: 320, y: 140 } as const;

/**
 * ファイルの大きさを読める形にする（「820 KB」「1.3 MB」）。1,024 で割る（OS の表示と同じ）。
 * ロケールに依らない（`toLocaleString` を使わない。status-format.ts の方針と同じ）。
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} バイト`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

export function BackupListDialog(props: BackupListDialogProps): JSX.Element {
  const { entries, onChoose, onModalChange, zIndex } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useModalRegistration(onModalChange, true);

  const cancel = useCallback(() => onChoose(null), [onChoose]);
  const onKeyDown = useModalKeydown(rootRef, cancel);

  // 開いたら焦点は先頭の行（いちばん新しい世代）へ。世代が無ければ板そのものへ。
  useEffect(() => {
    const firstRow = rootRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="backup-row"]',
    );
    (firstRow ?? rootRef.current)?.focus();
  }, []);

  const sourceName = entries[0]?.sourceName ?? null;

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
          {entries.length === 0 ? (
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
                          {entry.featureCount === null
                            ? BACKUP_LIST_STRINGS.unknownFeatures
                            : BACKUP_LIST_STRINGS.features(entry.featureCount)}
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
