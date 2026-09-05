// 増分 4 の探索的バグ狩り（実装計画 §4 の末尾 / §0.3）。
//
// **実データのコピーで仮名を 30 件連続で改名する。** 掃くのは 5 つ:
//   ① 束の並びが動かないか
//   ② 「済」の印が正しいか
//   ③ Ctrl+Z が 1 件ずつ戻るか
//   ④ 深さの自動追従で地図が飛ばないか（＝「必ず描く」でカメラが暴れないか）
//   ⑤ 5,000 行の合成データで固まらないか
//
// **`[異常]` が出たら落ちる形**（増分 2・3 の作法）。探索なので途中で止めず、観察を
// 集めてから最後にまとめて判定する。
//
// ⚠️ 正準ファイルはアプリで直接開かない（教訓 5.48）。必ず一時コピーを開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  enterEditMode,
  launchAppWithProject,
  listedFeatureCount,
  loadSyntheticProject,
  launchApp,
} from '../helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 何件を連続で直すか（実装計画 §4 の「仮名を 30 件連続で改名する」）。 */
const RENAME_COUNT = 30;

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
 * いまのカメラ（`data-zoom` / `data-pan-x` / `data-pan-y`）。
 * **付いているのは地図の入力層**（`map-input-layer`）で、地図セルではない。
 */
async function camera(page: Page): Promise<{ zoom: string; panX: string; panY: string }> {
  const el = page.getByTestId('map-input-layer');
  return {
    zoom: (await el.getAttribute('data-zoom')) ?? '',
    panX: (await el.getAttribute('data-pan-x')) ?? '',
    panY: (await el.getAttribute('data-pan-y')) ?? '',
  };
}

test.describe('増分 4 の探索 — 実データで仮名を 30 件連続で直す', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('束の並び・済の印・取り消し・カメラを 30 件ぶん掃く', async () => {
    test.setTimeout(900_000);
    const { record, findings } = makeRecorder();

    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc4-hunt-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const canonicalBefore = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    try {
      await enterEditMode(page);

      // --- 束を作る（既定の式「仮名: ○○付近の領域NN」）----------------------
      await page.getByTestId('bundle-preset').selectOption('kana-area');
      await page.getByTestId('bundle-make').click();

      const position = page.getByTestId('bundle-position');
      const firstPosition = (await position.textContent()) ?? '';
      const total = Number(/\/\s*(\d+)$/.exec(firstPosition)?.[1] ?? '0');
      if (total < RENAME_COUNT) {
        record('bundle-too-small', `束が ${String(total)} 件しかない（30 件直せない）`);
      }
      // 束を作った瞬間に先頭の未処理が選ばれている。
      const firstSelected = await page.getByTestId('app-active-feature').textContent();
      if (firstSelected === null || firstSelected.trim() === '') {
        record('bundle-no-first-selection', '束を作っても何も選ばれていない');
      }

      const name = page.getByLabel('名前', { exact: true });
      const renamed: string[] = [];
      let cameraJumps = 0;
      // **カメラが実際に動いた回数**（手直し F4 の下限）。「暴れていない」だけを見ると
      // カメラが 1 度も動かなくても緑になる ―― 送りの目的は「その地物を見せる」ことで、
      // 動かないのは動きすぎと同じくらいの不具合である。
      let cameraMoves = 0;
      let previous = await camera(page);

      for (let i = 0; i < RENAME_COUNT; i += 1) {
        const id = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
        if (id === '') {
          record('no-target', `${String(i)} 件目で対象が空になった`);
          break;
        }
        if (renamed.includes(id)) {
          // ① 束の並びが動くと、同じ地物へ何度も戻る。
          record('bundle-revisit', `${String(i)} 件目で ${id} が 2 度目に出た（並びが動いた疑い）`);
        }
        renamed.push(id);

        await name.fill(`探索の本名${String(i).padStart(2, '0')}`);
        await name.press('Enter');
        // 送りが効いて対象が変わるのを待つ。
        await expect
          .poll(async () => ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim())
          .not.toBe(id);

        // ④ カメラが「合わせた」以上に暴れていないか。倍率が桁で変わるのは異常。
        const now = await camera(page);
        const zoomBefore = Number(previous.zoom);
        const zoomNow = Number(now.zoom);
        if (
          Number.isFinite(zoomBefore) &&
          Number.isFinite(zoomNow) &&
          zoomBefore > 0 &&
          (zoomNow / zoomBefore > 100 || zoomBefore / zoomNow > 100)
        ) {
          cameraJumps += 1;
        }
        if (!Number.isFinite(zoomNow) || zoomNow <= 0) {
          record('camera-broken', `${String(i)} 件目でカメラの倍率が ${now.zoom}`);
        }
        if (
          now.zoom !== previous.zoom ||
          now.panX !== previous.panX ||
          now.panY !== previous.panY
        ) {
          cameraMoves += 1;
        }
        previous = now;
      }
      if (cameraJumps > 0) {
        record('camera-jump', `倍率が 100 倍以上動いた送りが ${String(cameraJumps)} 回`);
      }
      // --- 下限（手直し F4）: 掃いた回数とカメラを「1 回も起きなかった」で通さない。
      //     異常だけを数える形だと、**何も起きなくても緑**になってしまう。
      if (renamed.length < RENAME_COUNT) {
        record(
          'too-few-renamed',
          `${String(RENAME_COUNT)} 件直すつもりが ${String(renamed.length)} 件で終わった`,
        );
      }
      if (cameraMoves === 0) {
        record('camera-never-moved', '30 件送ってもカメラが 1 度も動かなかった');
      }

      // ② 直したものが全部「済」になっているか。
      //
      // **「済」を 1 件も確かめられなかったら、それ自体が異常**（手直し F4 の下限）。
      // 仮想スクロールなので窓に入っている行しか見られず、「行が 1 つも無い」＝
      // 「見なかった」で静かに通る形だった（教訓 5.59 と同じ型）。
      let doneChecked = 0;
      for (const id of renamed) {
        const done = await page.getByTestId(`ledger-done-${id}`).count();
        const row = await page.getByTestId(`feature-list-item-${id}`).count();
        if (row === 0) continue;
        doneChecked += 1;
        if (done === 0) {
          record('done-missing', `${id} は直したのに「済」の印が無い`);
        }
      }
      if (renamed.length > 0 && doneChecked === 0) {
        record(
          'done-unchecked',
          '直した地物の行が 1 つも窓に入らず、「済」を 1 件も確かめられなかった',
        );
      }

      // ① 束の並びは動いていない（総数が変わらない）。
      const afterPosition = (await position.textContent()) ?? '';
      const afterTotal = Number(/\/\s*(\d+)$/.exec(afterPosition)?.[1] ?? '0');
      if (afterTotal !== total) {
        record('bundle-total-changed', `束の件数が ${String(total)} → ${String(afterTotal)} に変わった`);
      }

      // ③ Ctrl+Z が 1 件ずつ戻るか。**押しても選択が動かない場所**を押してから送る
      //    （教訓 5.54: 地図を押すと選択が変わる）。
      await page.getByTestId('statusbar').click();
      for (let i = 0; i < 3; i += 1) {
        const before = renamed.length - 1 - i;
        const targetId = renamed[before];
        if (targetId === undefined) break;
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(200);
        // 取り消した地物は「済」から外れ、カーソルもそこへ移る（設計書 §C.5）。
        const stillDone = await page.getByTestId(`ledger-done-${targetId}`).count();
        if (stillDone > 0) {
          record('undo-not-reverted', `${targetId} を取り消したのに「済」のまま`);
        }
        const active = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
        if (active !== targetId) {
          record(
            'undo-cursor',
            `取り消した先が ${targetId} なのに選択は ${active}（カーソルが追いかけていない）`,
          );
        }
      }

      // 正準ファイルを触っていないこと（教訓 5.48）。
      const canonicalAfter = statSync(canonicalPath);
      if (
        canonicalAfter.size !== canonicalBefore.size ||
        canonicalAfter.mtimeMs !== canonicalBefore.mtimeMs
      ) {
        record('canonical-touched', '正準ファイルが書き換わった');
      }
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // 探索の判定は最後にまとめて（途中で止めない）。
    expect(
      findings.map((f) => `[異常] ${f.tag}: ${f.detail}`),
      '探索で見つけたもの',
    ).toEqual([]);
  });
});

test.describe('増分 4 の探索 — 5,000 行の合成データで固まらないか', () => {
  test('5,000 行を載せて、絞り込み・送り・スクロールが動く', async () => {
    test.setTimeout(600_000);
    const { record, findings } = makeRecorder();
    const { app, page } = await launchApp();
    try {
      const startedAt = Date.now();
      await loadSyntheticProject(page, 5000);
      await expect(page.getByTestId('unified-list-count')).toHaveText('5000件');
      const loadMs = Date.now() - startedAt;
      // 載せるのに時間がかかりすぎると、そのあとの測定は何を測っても意味が無い。
      if (loadMs > 60_000) record('synthetic-load-slow', `5,000 件を載せるのに ${String(loadMs)}ms`);

      // 絞り込み（打鍵ごとに効く）。
      const filterStarted = Date.now();
      await page.getByTestId('unified-list-filter').fill('合成地物01');
      await expect
        .poll(async () => listedFeatureCount(page))
        .toBeLessThan(5000);
      const filterMs = Date.now() - filterStarted;
      if (filterMs > 10_000) record('filter-slow', `絞り込みに ${String(filterMs)}ms`);

      // スクロール（仮想スクロールが効いていれば DOM は増えない）。
      await page.getByTestId('unified-list-filter').fill('');
      await expect(page.getByTestId('unified-list-count')).toHaveText('5000件');
      for (const top of [0, 28 * 1000, 28 * 4000, 0]) {
        await page.getByTestId('ledger-scroller').evaluate((el, y) => {
          el.scrollTop = y;
        }, top);
        await page.waitForTimeout(120);
        const rows = await page.locator('[data-testid^="ledger-row-"]').count();
        if (rows > 20) record('virtual-scroll-broken', `scrollTop=${String(top)} で DOM 行が ${String(rows)}`);
        if (rows === 0) record('virtual-scroll-empty', `scrollTop=${String(top)} で DOM 行が 0`);
      }
    } finally {
      await app.close();
    }
    expect(
      findings.map((f) => `[異常] ${f.tag}: ${f.detail}`),
      '探索で見つけたもの',
    ).toEqual([]);
  });
});
