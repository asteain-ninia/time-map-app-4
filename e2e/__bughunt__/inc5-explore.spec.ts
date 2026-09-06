// 増分 5 の探索的バグ狩り（実装計画 §5 の末尾 / §0.3）。
//
// **実データのコピーで、全部の道具を順に持ち替えながら 1 本の作業を最後まで通す。**
// 掃くのは実装計画が名指しした 5 つ:
//   ① どこかで選択が消えないか
//   ② Esc の階段が全道具で同じか
//   ③ 確定直後の Ctrl+Z が全道具で効くか
//   ④ 右クリックが道具中でも開くか
//   ⑤ ポップオーバーが地図のクリックを奪わないか（過去 3 回の K-2 事故と同じ型）
//
// **`[異常]` が出たら落ちる形**（増分 2〜4 の作法）。探索なので途中で止めず、観察を
// 集めてから最後にまとめて判定する。
//
// ⚠️ 正準ファイルはアプリで直接開かない（教訓 5.48）。必ず一時コピーを開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  ALL_TOOL_TESTIDS,
  launchAppWithProject,
  leaveViewMode,
  openDepthOptions,
} from '../helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

interface Finding {
  readonly tag: string;
  readonly detail: string;
}

function makeRecorder(): {
  record: (tag: string, detail: string) => void;
  findings: Finding[];
} {
  const findings: Finding[] = [];
  return {
    record: (tag, detail) => {
      findings.push({ tag, detail });
    },
    findings,
  };
}

/**
 * 1 段に並ぶ道具（レールの順）。「測る」は別の軸なので下で個別に掃く。
 *
 * **顔ぶれは実装（`ALL_TOOLS`）から引く**（増分 5 の手直し F3）。手で並べていたので、
 * 道具を足しても spec は古い顔ぶれのまま緑で通った。
 */
const RAIL_TOOLS = ALL_TOOL_TESTIDS;

async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}

async function focusOwner(page: Page): Promise<string> {
  return ((await page.getByTestId('app-focus-owner').textContent()) ?? '').trim();
}

/** 地図セルの 5×5 の格子で、その点が誰に届くかを集める（K-2 の走査）。 */
async function scanMapGrid(page: Page): Promise<Set<string>> {
  const b = (await page.getByTestId('map-input-layer').boundingBox())!;
  const hits = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      const x = b.x + (b.width * (i + 0.5)) / 5;
      const y = b.y + (b.height * (j + 0.5)) / 5;
      hits.add(
        await page.evaluate(
          ({ px, py }) => {
            const el = document.elementFromPoint(px, py);
            if (el === null) return 'null';
            const dialog = el.closest('[role="dialog"]');
            if (dialog !== null) {
              return `popover:${dialog.getAttribute('data-testid') ?? '?'}`;
            }
            return el.getAttribute('data-testid') ?? el.className.toString();
          },
          { px: x, py: y },
        ),
      );
    }
  }
  return hits;
}

test.describe('増分 5 の探索 — 実データで全部の道具を順に持ち替える', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('選択・Esc の階段・確定後の取り消し・右クリック・ポップオーバーを全道具で掃く', async () => {
    test.setTimeout(900_000);
    const { record, findings } = makeRecorder();

    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc5-hunt-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await leaveViewMode(page);
      const mapBox = (await page.getByTestId('map-input-layer').boundingBox())!;
      const cx = mapBox.x + mapBox.width / 2;
      const cy = mapBox.y + mapBox.height / 2;

      // --- 下ごしらえ: 実データの地物を 1 つ選ぶ ------------------------------
      // 実データは陸地が広いので中央のクリックでほぼ必ず何かに当たる。当たらな
      // かったら少しずつずらす（探索なので落とさずに記録する）。
      let picked = '';
      // **当たった場所を覚える。** 実データは海も広いので、中央がいつも陸とは限らない。
      // 覚えずに毎回中央を押すと「選び直せない」が量産され、**アプリの不具合ではなく
      // 探索の当て方の粗**を記録してしまう（1 回目の実行で実際にそうなった）。
      let pickAt: readonly [number, number] = [cx, cy];
      for (const [dx, dy] of [
        [0, 0],
        [-120, -60],
        [120, 60],
        [-200, 80],
        [200, -80],
      ] as const) {
        await page.mouse.click(cx + dx, cy + dy);
        picked = await activeFeature(page);
        if (picked !== '') {
          pickAt = [cx + dx, cy + dy];
          break;
        }
      }
      if (picked === '') {
        record('no-feature-under-cursor', '地図の中央付近を 5 か所押しても何も選べない');
      }

      // --- ① 全部の道具を順に持ち替えて、選択が消えないことを見る --------------
      for (const tool of RAIL_TOOLS) {
        await page.getByTestId(tool).click();
        const after = await activeFeature(page);
        if (picked !== '' && after !== picked) {
          record('selection-lost-on-tool', `${tool} を構えたら選択が ${picked} → ${after}`);
        }
        // ② Esc の階段: どの道具でも「素の状態」に必ず戻れる。
        //   ここでは「連打したら道具が外れ、選択も空になる」ことだけを見る
        //   （段の順序そのものは e2e/inc5-shell.spec.ts が固定している）。
        for (let i = 0; i < 4; i += 1) await page.keyboard.press('Escape');
        const toolAfter = ((await page.getByTestId('app-active-tool').textContent()) ?? '').trim();
        // **素の状態は「選ぶ」である。** 道具を外した状態（空）と `edit.select` は
        // どちらも「選ぶ」を意味するので、そこで止まっていれば階段は最後まで降りている
        // （設計書 §D.4 の階段の最後は「『選ぶ』道具に戻る」であって「無になる」ではない）。
        if (toolAfter !== '' && toolAfter !== 'edit.select') {
          record('escape-stuck-tool', `${tool}: Esc を 4 回押しても道具が ${toolAfter} のまま`);
        }
        const selAfter = await activeFeature(page);
        if (selAfter !== '') {
          record('escape-stuck-selection', `${tool}: Esc を 4 回押しても選択が ${selAfter}`);
        }
        const owner = await focusOwner(page);
        if (owner !== 'map') {
          record('focus-owner-stuck', `${tool}: Esc のあと鍵盤の持ち主が ${owner}`);
        }
        // 次の道具のために選び直す（**最初に当たった場所**を押す）。
        if (picked !== '') {
          await page.mouse.click(pickAt[0], pickAt[1]);
          const again = await activeFeature(page);
          if (again === '') record('reselect-failed', `${tool} のあと選び直せない`);
          picked = again === '' ? picked : again;
        }
      }

      // --- ③ 確定した直後の Ctrl+Z が効く（道具を外さずに）--------------------
      // 実データでいちばん軽い確定は「面を描いて保存」なので、それで測る。
      // 帯の確定ボタンは全道具で同じ場所（U-10）なので、ここが通れば置き場は正しい。
      await page.getByTestId('tool-add.area').click();
      const layer = page.getByTestId('add-input-layer');
      await expect(layer).toBeVisible();
      const lb = (await layer.boundingBox())!;
      const ax = lb.x + lb.width * 0.12;
      const ay = lb.y + lb.height * 0.82;
      for (const [dx, dy] of [
        [0, 0],
        [26, 0],
        [26, 26],
        [0, 26],
      ] as const) {
        await page.mouse.click(ax + dx, ay + dy);
      }
      const complete = page.getByTestId('add-complete');
      if (await complete.isEnabled().catch(() => false)) {
        await complete.click();
        const save = page.getByTestId('add-save');
        if (await save.isVisible().catch(() => false)) {
          await save.click();
          // 実データは陸が詰まっているので、置いた四角が既存の面と重なって
          // **重なり競合の板**が出ることがある。板が出ているあいだ鍵盤が板のものに
          // なるのは設計どおり（設計書 §D.4）なので、**板を閉じてから**測る。
          const conflictCancel = page.getByTestId('conflict-cancel');
          if (await conflictCancel.isVisible().catch(() => false)) {
            record(
              'commit-conflicted',
              '追加が重なり競合で止まった（実データなので想定内。板を閉じて測り直す）',
            );
            await conflictCancel.click().catch(() => undefined);
            await expect(conflictCancel).toHaveCount(0);
          }
          // 確定した直後、道具を外さずに Ctrl+Z。
          const ownerAtCommit = await focusOwner(page);
          if (ownerAtCommit !== 'map') {
            record('commit-owner', `確定直後の鍵盤の持ち主が ${ownerAtCommit}（map のはず）`);
          }
          const canUndo = await page.getByTestId('app-can-undo').textContent();
          await page.keyboard.press('Control+z');
          const canRedo = ((await page.getByTestId('app-can-redo').textContent()) ?? '').trim();
          if (canUndo === '1' && canRedo !== '1') {
            record('undo-after-commit', '確定直後の Ctrl+Z が効かない（やり直せる印が立たない）');
          }
        } else {
          record('add-save-missing', '面を確定したのに素性欄の保存が出ない');
        }
      } else {
        record('add-complete-disabled', '4 点打っても［完了］が押せない');
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      // --- ④ 右クリックは道具を構えていても開く（設計書 §I.3 の原則①）--------
      for (const tool of ['tool-edit.knife', 'tool-edit.reparent', 'tool-add.area'] as const) {
        await page.getByTestId(tool).click();
        await page.mouse.click(cx + 40, cy + 40, { button: 'right' });
        const opened = await page
          .getByTestId('context-menu')
          .isVisible()
          .catch(() => false);
        if (!opened) record('context-menu-blocked', `${tool} を構えていると右クリックが開かない`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }

      // --- ⑤ ポップオーバーは地図のクリックを奪わない（K-2）------------------
      await page.getByTestId('tool-edit.select').click();
      const closed = await scanMapGrid(page);
      if (closed.size !== 1 || !closed.has('map-input-layer')) {
        record('k2-idle', `道具なしで地図の 25 点が ${[...closed].join(' / ')}`);
      }
      for (const [name, open] of [
        ['display', async () => page.getByTestId('option-display-button').click()],
        ['depth', async () => openDepthOptions(page)],
      ] as const) {
        await open();
        const hits = await scanMapGrid(page);
        for (const hit of hits) {
          if (hit !== 'map-input-layer' && !hit.startsWith('popover:')) {
            record('k2-open', `${name} を開くと地図の点が ${hit} に奪われる`);
          }
        }
        await page.keyboard.press('Escape');
        const after = await scanMapGrid(page);
        if (after.size !== 1 || !after.has('map-input-layer')) {
          record('k2-closed', `${name} を閉じたあと地図の 25 点が ${[...after].join(' / ')}`);
        }
      }

      // --- 正準ファイルを触っていないこと（教訓 5.48）------------------------
      const canonicalAfter = statSync(canonicalPath);
      if (
        canonicalAfter.size !== canonicalBefore.size ||
        canonicalAfter.mtimeMs !== canonicalBefore.mtimeMs
      ) {
        record('canonical-touched', '正準ファイルが書き換わった（コピーを開いたはず）');
      }
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    console.log(
      `[増分5探索] 観察 ${String(findings.length)} 件:\n` +
        findings.map((f) => `  - ${f.tag}: ${f.detail}`).join('\n'),
    );
    // **想定内の観察は落とす。** 実データは陸が詰まっているので「置いた四角が既存の面と
    // 重なった」は不具合ではない（そのときは板を閉じてから測り直している）。
    const abnormal = findings.filter((f) => f.tag !== 'commit-conflicted');
    expect(abnormal.map((f) => `[異常] ${f.tag}: ${f.detail}`)).toEqual([]);
  });
});
