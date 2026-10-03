// 「以前の保存から開く」の世代の一覧（増分 8D / 設計書 §E.1 の V14 の手順 (a)）。
// 行は日時・大きさ・地物数を出し、押すとその id を返す。やめる・Esc は null。

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

import type { BackupEntry } from '../../shell/ipc/contract';
import { BackupListDialog, formatByteSize } from './BackupListDialog';
import { BACKUP_LIST_STRINGS } from './strings';

afterEach(() => {
  cleanup();
});

const at = (h: number, m: number): number => new Date(2026, 9, 3, h, m, 7).getTime();

const ENTRIES: BackupEntry[] = [
  { id: 'new', savedAtMs: at(14, 3), byteSize: 2_022_467, featureCount: 335, sourceName: 'w.gimoza' },
  { id: 'old', savedAtMs: at(13, 58), byteSize: 840_000, featureCount: null, sourceName: 'w.gimoza' },
];

describe('formatByteSize', () => {
  it('バイト・KB・MB（1,024 で割る。ロケールに依らない）', () => {
    expect(formatByteSize(512)).toBe('512 バイト');
    expect(formatByteSize(2048)).toBe('2.0 KB');
    expect(formatByteSize(840_000)).toBe('820 KB');
    expect(formatByteSize(2_022_467)).toBe('1.9 MB');
    expect(formatByteSize(Number.NaN)).toBe('—');
  });
});

describe('BackupListDialog', () => {
  it('どのファイルの世代かと、各行の日時・大きさ・地物数を出す（読めない地物数は「—」）', () => {
    render(<BackupListDialog entries={ENTRIES} onChoose={() => undefined} />);
    expect(screen.getByTestId('backup-intro')).toHaveTextContent('w.gimoza');
    const rows = screen.getAllByTestId('backup-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('backup-row-saved-at').map((e) => e.textContent)).toEqual([
      '2026-10-03 14:03:07',
      '2026-10-03 13:58:07',
    ]);
    expect(screen.getAllByTestId('backup-row-size').map((e) => e.textContent)).toEqual([
      '1.9 MB',
      '820 KB',
    ]);
    expect(screen.getAllByTestId('backup-row-features').map((e) => e.textContent)).toEqual([
      BACKUP_LIST_STRINGS.features(335),
      BACKUP_LIST_STRINGS.unknownFeatures,
    ]);
    // 開いたら保存先にならないことを、押す前に言う。
    expect(screen.getByTestId('backup-note')).toHaveTextContent('名前を付けて保存');
    // 先頭の行（いちばん新しい世代）に焦点が入っている。
    expect(document.activeElement).toBe(rows[0]);
  });

  it('行を押すとその id、［やめる］と Esc は null', () => {
    const onChoose = vi.fn();
    render(<BackupListDialog entries={ENTRIES} onChoose={onChoose} />);
    fireEvent.click(screen.getAllByTestId('backup-row')[1]!);
    expect(onChoose).toHaveBeenLastCalledWith('old');
    fireEvent.click(screen.getByTestId('backup-cancel'));
    expect(onChoose).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(screen.getByTestId('backup-modal-root'), { key: 'Escape' });
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });

  it('世代が無ければ空の案内を出す（空の表を見せない）', () => {
    render(<BackupListDialog entries={[]} onChoose={() => undefined} />);
    expect(screen.getByTestId('backup-empty')).toHaveTextContent(BACKUP_LIST_STRINGS.empty);
    expect(screen.queryByTestId('backup-row')).toBeNull();
  });
});
