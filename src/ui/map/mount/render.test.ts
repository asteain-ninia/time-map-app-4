// 回帰: **`startRedrawScheduling()` の呼び忘れが黙って通る**（`mount/render.ts`）。
//
// `createMountRender` は「ホストを作る」までしかしない。ストアの購読も、ホスト自身の
// 高頻度な描き直しを FPS 上限に載せる `setRedrawRequester` も、**返ってきた
// `startRedrawScheduling()` を呼んだ時点で初めて張られる**（`render.ts` の同名の関数）。
// 呼ぶのを忘れると:
//   - ストアが変わっても描き直されない（年を動かしても・地物を足しても画面が変わらない）
//   - 移動 / 拡大縮小 / 下書きの描き直しが FR-110 の上限を素通りする
// のに、**組み立て（App.tsx）は何ごともなく動き、単体テストは 1 本も落ちなかった**。
// 分けた部品を「作って返す」形にすると、こういう「呼ばないと死ぬ 1 行」が生まれる。
//
// 実際に描かせて確かめる形は取れない（レンダラは実物のキャンバスと合成が要る）。代わりに
// **組み立ての側のソースを読んで、`createMountRender` の産物に対して
// `startRedrawScheduling()` を呼んでいることを見る**。同じやり方の先例が
// `ui/shell/command-result.test.ts`（label の直書き走査）と
// `domain/perf/offline-egress.test.ts` にある。
//
// 走査は「App.tsx」を名指ししない。`createMountRender` を呼んでいるファイルを全部拾って、
// そのどれもが呼んでいることを見る ―― 組み立ての置き場所が動いても検査が付いていく。

import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSourceText } from '../../../test-support/read-source-text';

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(here, '../..');

/** `src/ui` 配下の実装ファイル（テストを除く）を全部並べる。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * コメントを落とす。**説明文の中に書いてある呼び出しを「呼んでいる」と数えないため**。
 * `render.ts` の説明文にはこの関数名が何度も出てくるので、ここを省くと素通りする。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `createMountRender(...)` の戻りを受けている変数名（複数あれば全部）。 */
function mountRenderReceivers(source: string): string[] {
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createMountRender\s*\(/g;
  const names: string[] = [];
  let m = re.exec(source);
  while (m !== null) {
    if (m[1] !== undefined) names.push(m[1]);
    m = re.exec(source);
  }
  return names;
}

/** その変数に対して `startRedrawScheduling()` を呼んでいるか。 */
function callsStartRedrawScheduling(source: string, receiver: string): boolean {
  return new RegExp(`(^|[^\\w$.])${receiver}\\.startRedrawScheduling\\s*\\(`, 'm').test(source);
}

/** `createMountRender` を呼んでいる実装ファイル（＝地図の組み立て）。 */
const composers = sourceFiles(uiRoot)
  .map((path) => ({ path, text: stripComments(readSourceText(path)) }))
  .map((f) => ({ ...f, receivers: mountRenderReceivers(f.text) }))
  .filter((f) => f.receivers.length > 0);

describe('startRedrawScheduling() の呼び忘れ（呼ばないと再描画が止まる）', () => {
  it('地図を組み立てているファイルが 1 つは見つかる（走査が空振りしていない）', () => {
    expect(composers.map((f) => f.path.slice(uiRoot.length + 1))).not.toEqual([]);
  });

  it('createMountRender を呼んだファイルは、その産物の startRedrawScheduling() も呼ぶ', () => {
    const forgotten: string[] = [];
    for (const f of composers) {
      for (const receiver of f.receivers) {
        if (callsStartRedrawScheduling(f.text, receiver)) continue;
        forgotten.push(`${f.path.slice(uiRoot.length + 1)}: ${receiver}.startRedrawScheduling()`);
      }
    }
    expect(
      forgotten,
      `再描画の開始を呼んでいない組み立てがある（画面が更新されなくなる）:\n${forgotten.join('\n')}`,
    ).toEqual([]);
  });

  it('呼ぶのは入力側の結線より後（render.ts が要求している並び）', () => {
    // 先に呼ぶと、マウント直後の再クランプ描画が同期から次フレーム送りに変わり、
    // ストア購読の登録順（モード中断の購読が先）も入れ替わる ―― `MountRender` の
    // `startRedrawScheduling` の説明にある約束。
    for (const f of composers) {
      const inputAt = f.text.indexOf('createMountInput');
      if (inputAt < 0) continue;
      const startAt = f.text.search(/[A-Za-z_$][\w$]*\.startRedrawScheduling\s*\(/);
      expect(startAt, f.path.slice(uiRoot.length + 1)).toBeGreaterThan(inputAt);
    }
  });

  it('この検査には歯がある: 呼び出しの 1 行を消すと「呼び忘れ」と言う', () => {
    // わざと壊した版を **実物のソースから作って** 同じ検査にかける。検査そのものが
    // 空振りしていないことを、緑のまま確かめ続けるための 1 本（教訓 5.49 の裏返し）。
    for (const f of composers) {
      for (const receiver of f.receivers) {
        const without = f.text.replace(
          new RegExp(`^[^\\S\\n]*${receiver}\\.startRedrawScheduling\\s*\\(\\);[^\\S\\n]*$`, 'm'),
          '',
        );
        expect(without, `${f.path}: 消す対象の行が見つからない`).not.toBe(f.text);
        expect(callsStartRedrawScheduling(without, receiver)).toBe(false);
      }
    }
  });
});
