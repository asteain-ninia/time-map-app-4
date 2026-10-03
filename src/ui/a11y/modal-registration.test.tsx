// 「板が出ているのに鍵盤の持ち主が板でない」を総当たりで防ぐ検査
//（司令塔の決定 (13)。教訓 5.75 の実効化。反証 3-1・3-2 / Fable #1 の再発防止）。
//
// 増分 7 で足した板 5 枚が `modalOwnsKeyboard` にまるごと書き漏れていた。人手で
// OR 鎖へ書き足す形だと必ず漏れるので、
//   1. 板の部品は自分で名乗る（{@link useModalRegistration}）、
//   2. **板を出しているすべての場所**が名乗る口を渡しているかを、ここで機械的に見る、
// の 2 段にする。2 の走査は「新しい板を足したのに配線を忘れた」をその場で落とす。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { BulkKindLabelDialog } from '../property/BulkKindLabelDialog';
import { ImpactConfirmDialog } from '../shell/ImpactConfirmDialog';

/** 名乗る口を持つ「本物の板」の部品名。足したらここへ書く（走査の母集合）。 */
const MODAL_COMPONENTS = [
  'ImpactConfirmDialog',
  'BulkKindLabelDialog',
  'ReparentOptionsDialog',
  'DeleteConfirmDialog',
  // 項目 6: 時刻レールの右クリック（開いているあいだ鍵盤の持ち主は `modal`）。
  'RailContextMenu',
] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!name.endsWith('.tsx')) continue;
    if (name.endsWith('.test.tsx')) continue;
    out.push(full);
  }
  return out;
}

/** `<Name ... />` / `<Name ...>` の 1 個ぶんの開始タグを切り出す（入れ子は数えない）。 */
function openingTags(source: string, component: string): string[] {
  const tags: string[] = [];
  const marker = `<${component}`;
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at < 0) break;
    const next = source[at + marker.length];
    if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
      from = at + marker.length;
      continue;
    }
    let depth = 0;
    let end = at;
    for (let i = at; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    tags.push(source.slice(at, end + 1));
    from = end + 1;
  }
  return tags;
}

describe('板の登録 — 出している場所は必ず名乗る口を渡す（決定 (13)）', () => {
  it.each(MODAL_COMPONENTS)('%s を出すすべての場所が onModalChange を渡す', (component) => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8');
      for (const tag of openingTags(source, component)) {
        if (tag.includes('onModalChange') || tag.includes('onImpactModalChange')) continue;
        offenders.push(`${file}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('板の登録 — 部品は出ている間だけ名乗る', () => {
  it('ImpactConfirmDialog は出たら名乗り、外れたら取り消す', () => {
    const onModalChange = vi.fn();
    const view = render(
      <ImpactConfirmDialog
        testIdPrefix="probe"
        title="試し"
        groups={[]}
        confirmLabel="消す"
        cancelLabel="やめる"
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onModalChange={onModalChange}
      />,
    );
    expect(onModalChange).toHaveBeenCalledWith(true);
    view.unmount();
    expect(onModalChange).toHaveBeenLastCalledWith(false);
  });

  it('BulkKindLabelDialog は出たら名乗り、外れたら取り消す', () => {
    const onModalChange = vi.fn();
    const view = render(
      <BulkKindLabelDialog
        count={3}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onModalChange={onModalChange}
      />,
    );
    expect(onModalChange).toHaveBeenCalledWith(true);
    view.unmount();
    expect(onModalChange).toHaveBeenLastCalledWith(false);
  });

  it('口を渡さない宿主では何も起きない（単体試験が壊れない）', () => {
    expect(() =>
      render(
        <ImpactConfirmDialog
          testIdPrefix="probe2"
          title="試し"
          groups={[]}
          confirmLabel="消す"
          cancelLabel="やめる"
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    ).not.toThrow();
  });
});
