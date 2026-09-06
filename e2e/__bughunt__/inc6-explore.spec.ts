// 増分 6 の探索的バグ狩り（実装計画 §6 の末尾 / §0.3）。
//
// **実データのコピーで「1 地物に 5 つの錨」を作り、レールから錨を辿る。** 掃くのは
// 実装計画が名指しした 5 つ:
//   ① 印の位置が錨表の年と一致するか
//   ② ズームしてもずれないか
//   ③ 束の吹き出しの件数が合っているか
//   ④ 再生中に固まらないか
//   ⑤ `[` `]` が端で止まるか
//
// **`[異常]` が出たら落ちる形**（増分 2〜5 の作法）。探索なので途中で止めず、観察を
// 集めてから最後にまとめて判定する。
//
// ⚠️ 正準ファイルはアプリで直接開かない（教訓 5.48）。必ず一時コピーを開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import {
  launchAppWithProject,
  leaveViewMode,
  openPropertySection,
  railLaneStats,
  railMarkPositions,
  railView,
} from '../helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/**
 * まとめ役の子（親の系列を借りる側）。最後の節で掃く。
 *
 * **錨を 5 本足す相手には向かない。** Ctrl+K で足した錨は親の系列へ書かれ、値が何も
 * 変わっていないので「その子に関わる錨」に選ばれず、子の錨表にもレーンにも出ない
 * （裁定 §N-15 の (A) の帰結）。相手は **自分の履歴を持つ地物**から選ぶ（下の
 * `selectFeatureWithOwnHistory`）。
 */
const CHILD_NAME = 'アアウェン州';
/** そこへ足す 5 つの錨の年（0 年の既存の錨と合わせて 6 本になる）。 */
const ANCHOR_YEARS = [1200, 1400, 1600, 1800, 2000] as const;

interface Finding {
  readonly tag: string;
  readonly detail: string;
}

async function selectByName(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-mode-current').click();
  await page.getByTestId('list-shape-flat').click();
  await page.getByTestId('unified-list-filter').fill(name);
  const row = page.locator('[data-testid^="feature-list-item-"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
}

/**
 * **自分の履歴を持つ地物**を 1 つ選ぶ（実データの 775 件のうち 689 件がこれ）。
 *
 * 名前で決め打ちにしない ―― 実データのどれが「親の系列を借りる側」なのかは
 * ファイルの中身で決まるので、**レーンの観測（`inherited`）に聞く**のがいちばん確かで
 * ある（教訓 5.46: 結果を実際に決めている経路を確かめる）。返すのは選んだ行の文字。
 */
async function selectFeatureWithOwnHistory(page: Page): Promise<string> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-mode-current').click();
  await page.getByTestId('list-shape-flat').click();
  await page.getByTestId('unified-list-filter').fill('');
  const rows = page.locator('[data-testid^="feature-list-item-"]');
  await expect(rows.first()).toBeVisible();
  const count = Math.min(await rows.count(), 20);
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    await row.click();
    await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
    const stats = await railLaneStats(page);
    if (!stats.inherited && stats.anchorCount > 0) {
      return ((await row.textContent()) ?? '').trim();
    }
  }
  throw new Error('自分の履歴を持つ地物が一覧の先頭 20 行に見つからない');
}

/** 年の欄から焦点を外す（単一キーの割り振りは文字の欄では立ち止まる ―― §I.1）。 */
async function blurYearField(page: Page): Promise<void> {
  await page.getByLabel('直接ジャンプ 年', { exact: true }).blur();
}

/** 直接ジャンプ欄でその年へ移る。 */
async function goToYear(page: Page, year: number): Promise<void> {
  const field = page.getByLabel('直接ジャンプ 年', { exact: true });
  await field.fill(String(year));
  await field.press('Enter');
  await expect(page.getByTestId('timeline-current')).toHaveText(`${String(year)}年`);
}

/** 錨表に出ている年の一覧（素性欄の側の真実）。 */
async function anchorYearsInList(page: Page): Promise<number[]> {
  await page.getByTestId('sidebar-tab-properties').click();
  await openPropertySection(page, 'anchor-section');
  const rows = page.locator('[data-testid^="anchor-row-"]');
  await expect(rows.first()).toBeVisible();
  // **行の本文から年を読む**（内側のクラス名に頼らない ―― 見た目を触ったときに
  // 検査だけが静かに空を返す）。行の先頭に「1200年」の形で出ている。
  const texts = await rows.allTextContents();
  return texts
    .map((t) => Number(/(-?\d+)年/.exec(t.trim())?.[1] ?? Number.NaN))
    .filter((n) => Number.isFinite(n));
}

test.describe('増分 6 の探索 — 実データのコピーでレールから錨を辿る', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('1 地物に 5 つの錨を作り、印・ズーム・束・再生・端を掃く', async () => {
    test.setTimeout(300_000);
    const findings: Finding[] = [];
    const record = (tag: string, detail: string): void => {
      findings.push({ tag, detail });
    };

    const canonicalBefore = statSync(canonicalPath);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-inc6-explore-'));
    const copy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, copy);

    const { app, page } = await launchAppWithProject(copy);
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await leaveViewMode(page);
      const targetName = await selectFeatureWithOwnHistory(page);
      record('target', `錨を足す相手: ${targetName}`);

      // --- 5 つの錨を作る（Ctrl+K は「値を変えずに錨だけ増やす」経路）----------
      // **年の欄で Enter した直後の焦点のまま押す**（増分 6 でそこを通した）。
      for (const year of ANCHOR_YEARS) {
        await goToYear(page, year);
        await page.keyboard.press('Control+k');
        await page.waitForTimeout(150);
      }

      const listYears = await anchorYearsInList(page);
      for (const year of ANCHOR_YEARS) {
        if (!listYears.includes(year)) {
          record(
            'anchor-missing',
            `${String(year)}年の錨が錨表に無い（錨表: ${listYears.join(',')}）`,
          );
        }
      }

      // --- ① 印の位置が錨表の年と一致する ------------------------------------
      const stats = await railLaneStats(page);
      if (stats.anchorCount !== listYears.length) {
        record(
          'lane-count',
          `レーンの母数 ${String(stats.anchorCount)} と錨表の行数 ${String(listYears.length)} が違う`,
        );
      }
      if (stats.shapeCount > stats.width) {
        record('lane-shapes', `図形 ${String(stats.shapeCount)} が軸の画素数 ${String(stats.width)} を超えた`);
      }

      const laneBox = (await page.getByTestId('anchor-lane').boundingBox())!;
      const view = await railView(page);
      /** その年が軸のどの画素に来るはずか（表示範囲から素直に出す）。 */
      const expectedPx = (year: number, v: { minYear: number; maxYear: number; pixelLength: number }): number =>
        ((year - v.minYear) / (v.maxYear - v.minYear)) * v.pixelLength;

      const marks = await railMarkPositions(page);
      for (const year of listYears) {
        const want = expectedPx(year, view);
        const hit = marks.some((m) => Math.abs(m - want) <= 2);
        if (!hit) {
          record(
            'mark-position',
            `${String(year)}年の印が ${want.toFixed(1)}px 付近に無い（印: ${marks.join(',')}）`,
          );
        }
      }

      // --- ② ズームしてもずれない --------------------------------------------
      await page.mouse.move(laneBox.x + laneBox.width / 2, laneBox.y + laneBox.height / 2);
      for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -100);
      await page.waitForTimeout(150);
      const zoomedView = await railView(page);
      const zoomedMarks = await railMarkPositions(page);
      if (zoomedView.spanDays >= view.spanDays) {
        record('zoom-noop', 'ホイールで拡大しても表示範囲が狭まらない');
      }
      for (const year of listYears) {
        if (year < zoomedView.minYear || year > zoomedView.maxYear) continue;
        const want = expectedPx(year, zoomedView);
        if (!zoomedMarks.some((m) => Math.abs(m - want) <= 2)) {
          record(
            'mark-position-zoomed',
            `拡大後、${String(year)}年の印が ${want.toFixed(1)}px 付近に無い`,
          );
        }
      }

      // --- ③ 束の吹き出しの件数が合っている ----------------------------------
      // 全体表示へ戻すと 6 本が数画素に重なるので、押すと 1 段拡大 → やがて束が出る。
      await page.getByTestId('rail-zoom-fit').click().catch(async () => {
        await page.getByTestId('rail-zoom-button').click();
        await page.getByTestId('rail-zoom-fit').click();
      });
      await page.waitForTimeout(150);
      let bundleShown = false;
      for (let i = 0; i < 14; i += 1) {
        const v = await railView(page);
        const want = expectedPx(listYears[0] ?? 0, v);
        if (want < 0 || want > v.pixelLength) break;
        await page.mouse.click(laneBox.x + want, laneBox.y + laneBox.height / 2);
        await page.waitForTimeout(90);
        if ((await page.getByTestId('anchor-bundle').count()) > 0) {
          bundleShown = true;
          const title = (await page.getByTestId('anchor-bundle-title').textContent()) ?? '';
          const count = Number(/・(\d+) 件/.exec(title)?.[1] ?? Number.NaN);
          const rows = await page.locator('[data-testid^="anchor-bundle-row-"]').count();
          if (!Number.isFinite(count) || count < rows) {
            record('bundle-count', `束の見出し「${title}」と行数 ${String(rows)} が食い違う`);
          }
          await page.getByTestId('anchor-bundle-close').click();
          break;
        }
      }
      // 束が出ないこと自体は異常ではない（ほどけてしまえば出ない）。観察として残す。
      if (!bundleShown) record('bundle-not-reached', '押し続けても束の吹き出しに到達しなかった');

      // --- ④ 再生中に固まらない ----------------------------------------------
      await page.getByTestId('rail-zoom-fit').click().catch(() => undefined);
      const beforePlay = await railLaneStats(page);
      await page.getByRole('button', { name: '再生' }).click();
      await page.waitForTimeout(1500);
      const during = await railView(page);
      await page.getByRole('button', { name: '一時停止' }).click();
      const afterPlay = await railLaneStats(page);
      if (during.currentYear === 0) record('play-stuck', '再生しても年が動かない');
      if (afterPlay.aggregateCount !== beforePlay.aggregateCount) {
        record(
          'play-reaggregate',
          `再生中に再集計が ${String(afterPlay.aggregateCount - beforePlay.aggregateCount)} 回走った`,
        );
      }

      // --- ⑤ `[` `]` が端で止まる --------------------------------------------
      await goToYear(page, 0);
      // **年の欄から焦点を外してから押す。** 単一キーの割り振りは文字の欄では
      // 立ち止まる（§I.1）ので、欄に焦点があるあいだ `[` `]` は効かない ―― これは
      // 意図した振る舞いである（`[` は名前欄に打てる文字でもある）。
      // 地図を押して外すと選択が消えるので、欄そのものから外す。
      await blurYearField(page);
      // 端（いちばん前）で `[` を押しても動かず、理由が出る。
      await page.keyboard.press('[');
      await page.waitForTimeout(120);
      const atStart = (await page.getByTestId('timeline-current').textContent()) ?? '';
      if (atStart.trim() !== '0年') record('prev-anchor-edge', `端で '[' が動いた（${atStart}）`);
      const message = (await page.getByTestId('statusbar-result').textContent()) ?? '';
      if (!message.includes('錨はありません')) {
        record('prev-anchor-silent', `端の '[' が黙って終わった（状態行: ${message.trim()}）`);
      }
      // いちばん後ろまで `]` で送り、そこで止まる。
      for (let i = 0; i < ANCHOR_YEARS.length + 3; i += 1) {
        await page.keyboard.press(']');
        await page.waitForTimeout(80);
      }
      const last = (await page.getByTestId('timeline-current').textContent()) ?? '';
      const lastYear = Number(/(-?\d+)年/.exec(last.trim())?.[1] ?? Number.NaN);
      const maxAnchorYear = Math.max(...listYears, ...ANCHOR_YEARS);
      if (lastYear !== maxAnchorYear) {
        record('next-anchor-edge', `']' の終点が ${String(lastYear)}年（最後の錨は ${String(maxAnchorYear)}年）`);
      }

      // --- ⑥ まとめ役の子でもレーンが空にならない（裁定 §N-15 の (A)）---------
      await selectByName(page, CHILD_NAME);
      const childStats = await railLaneStats(page);
      if (!childStats.inherited) {
        record('child-not-inherited', `${CHILD_NAME} が「親の系列を借りている」と出ない`);
      }
      if (childStats.anchorCount === 0) {
        record('child-lane-empty', `${CHILD_NAME} のレーンが空`);
      }
      if ((await page.getByTestId('anchor-lane-owner').count()) === 0) {
        record('child-owner-missing', '借りている持ち主の名前が画面に出ない');
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
      `[増分6探索] 観察 ${String(findings.length)} 件:\n` +
        findings.map((f) => `  - ${f.tag}: ${f.detail}`).join('\n'),
    );
    // **想定内の観察は落とす。** 束は「ほどけてしまえば出ない」ので、到達しないことは
    // 不具合ではない（逃げ道 1 が効いた結果である）。
    const abnormal = findings.filter(
      (f) => f.tag !== 'bundle-not-reached' && f.tag !== 'target',
    );
    expect(abnormal.map((f) => `[異常] ${f.tag}: ${f.detail}`)).toEqual([]);
  });
});
