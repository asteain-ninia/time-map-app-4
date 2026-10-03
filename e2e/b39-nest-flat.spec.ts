// B39（面の下に子を作ると、開き直しのたびに修復を聞かれる）— **B39 前の期待**を実アプリで固定する。
//
// 2026-10-04 に「子を確定した時点で親を集約化する」後始末を入れ直したが、再検証
// （docs/ui-redesign/審査/B39-手直し2-再検証Opus.md）で、年を変えて子を描く形などで開き直しの
// 修復が利用者の描いた子を消す道が見つかり、後始末は戻した。いまの約束は次のとおり:
//
//   - 確定では親を作り替えない（親は「形を持ったまま子を持つ」末端のまま）。
//   - 開き直すと修復の板が出て、勧められるまま（各行の先頭）押すと、親 →［子…, 直轄領］の
//     平らな形で開く。何も消えない。
//   - 親を描いた年と違う年に子を描いても、修復で解けて開ける（再検証 3-1。以前は修復が親の錨の
//     始まりの年にしか子を探さず、解けずに読み込みが止まった）。
//   - 子が途中で終わる形は、勧められる既定が「そのまま残す」（理由の 1 行つき）で、何も変えずに
//     開く。「直轄領を生成」を選べば、子の居た年だけ平らになり、子の居なくなった年から親は元の形の
//     まま（2026-10-04、B39 の戻しの再検証の守り B と幾何の直し）。
//
// 単体（`src/domain/persistence/repair-leaf-with-children-later.test.ts`）はドメインの修復を、
// ここは実アプリの描く → 保存 → 開き直す → 修復の経路を見る。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  jumpToYear,
  launchApp,
  leafReport,
  loadProject,
  placeVertices,
  squareCorners,
  type LoadProjectOutcome,
} from './helpers';

interface SavedFeature {
  readonly id: string;
  readonly kind: string;
  readonly parentId?: string;
  readonly directDomain?: true;
  readonly attributes?: { readonly name?: string };
}

/** 書き出したファイルの地物を全部（同じ id は最後に見たもの）拾う。 */
function savedFeatures(path: string): Map<string, SavedFeature> {
  const manifest = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['manifest.json']!),
  ) as unknown;
  const out = new Map<string, SavedFeature>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (
      typeof o['id'] === 'string' &&
      (o['kind'] === 'leaf' || o['kind'] === 'aggregate') &&
      typeof o['attributes'] === 'object'
    ) {
      out.set(o['id'], o as unknown as SavedFeature);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(manifest);
  return out;
}

/**
 * 開き直し、修復の板が出たら各行の先頭（＝勧められる方法）を選んで適用する。やり直しの板が
 * 出たら失敗にする（勧められるまま 1 回で解けることを見る）。板に出た行の数を返す。
 */
async function reopenWithRecommendedRepairs(
  page: Page,
  path: string,
): Promise<{ readonly outcome: LoadProjectOutcome; readonly rows: number }> {
  const loading = loadProject(page, path);
  const board = page.getByTestId('repair-dialog');
  const shown = await board
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  let count = 0;
  if (shown) {
    const rows = page.locator('[data-testid^="repair-row-"]');
    count = await rows.count();
    for (let i = 0; i < count; i += 1) {
      await rows.nth(i).locator('[data-testid^="repair-option-"]').first().check();
    }
    await page.getByTestId('repair-apply').click();
    // 勧められるまま 1 回で解ける（やり直しの板が出ない）。
    await expect(board).toHaveCount(0);
  }
  return { outcome: await loading, rows: count };
}

/** 親の内側に子を描いて保存する（上位領域の欄の既定のまま）。上位領域の既定を返す。 */
async function drawChild(
  page: Page,
  at: { readonly x: number; readonly y: number; readonly half: number },
  name: string,
): Promise<string> {
  await armAddAreaTool(page);
  await placeVertices(page, squareCorners(at.x, at.y, at.half));
  await page.getByTestId('add-complete').click();
  const select = page.getByTestId('add-parent');
  await expect(select).toBeVisible();
  const defaultParent = await select.inputValue();
  await page.getByTestId('add-name').fill(name);
  await page.getByTestId('add-save').click();
  // 保存は 1 コマ遅れて走る。素性欄が閉じる（＝保存が走り終えた）のを待つ。
  await expect(page.getByTestId('add-property-form')).toHaveCount(0);
  return defaultParent;
}

/** 平らな形（親 →［子…, 直轄領］）で保存されているか。 */
function expectFlat(saved: Map<string, SavedFeature>, parentId: string, childNames: string[]): void {
  expect(saved.get(parentId)?.kind).toBe('aggregate');
  const under = [...saved.values()].filter((f) => f.parentId === parentId);
  expect(under.map((f) => f.attributes?.name ?? '').sort()).toEqual([...childNames, '親 直轄領'].sort());
  expect([...saved.values()].filter((f) => f.directDomain === true)).toHaveLength(1);
}

test.describe('B39 前の期待 — 面の中に子を描くと、開き直しの修復で平らな形になる（何も消えない）', () => {
  test('同じ年に子 3 人（居続ける） → 保存 → 開き直し → 勧められる修復 1 回で 親 →［子1, 子2, 子3, 直轄領］', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b39-'));
    const target = join(workDir, 'b39.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const parentId = await drawFace(page, squareCorners(cx + 60, cy, 150), { name: '親' });
      expect(parentId).not.toBe('');
      // 確定では親を作り替えない: 既定は 3 人とも親（親は形を持つ末端のまま）。
      expect(await drawChild(page, { x: cx + 10, y: cy - 70, half: 30 }, '子1')).toBe(parentId);
      expect(await drawChild(page, { x: cx + 110, y: cy - 70, half: 30 }, '子2')).toBe(parentId);
      expect(await drawChild(page, { x: cx + 60, y: cy + 70, half: 30 }, '子3')).toBe(parentId);
      expect((await leafReport(page, { names: ['親'] })).entries).toHaveLength(1);

      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(existsSync(target)).toBe(true);

      const reopened = await reopenWithRecommendedRepairs(page, target);
      expect(reopened.outcome).toBe('loaded');
      expect(reopened.rows).toBeGreaterThan(0);
      // 修復した姿で保存し直して、平らな形を確かめる。
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expectFlat(savedFeatures(target), parentId, ['子1', '子2', '子3']);
      const report = await leafReport(page, { names: ['子1', '子2', '子3', '親 直轄領'] });
      expect(report.entries).toHaveLength(4);
      expect(report.maxPairOverlapKm2).toBe(0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('1000 年に親・1100 年に子（居続ける） → 保存 → 開き直し → 勧められる修復 1 回で解けて開き、1100 年から 親 →［子, 直轄領］', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b39y-'));
    const target = join(workDir, 'b39y.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await jumpToYear(page, 1000);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const parentId = await drawFace(page, squareCorners(cx + 60, cy, 150), { name: '親' });
      await jumpToYear(page, 1100);
      expect(await drawChild(page, { x: cx + 10, y: cy - 70, half: 30 }, '子')).toBe(parentId);

      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');

      // 以前はここで修復が解けず、2 枚目の板のあと読み込みが止まった（再検証 3-1）。
      const reopened = await reopenWithRecommendedRepairs(page, target);
      expect(reopened.outcome).toBe('loaded');
      await jumpToYear(page, 1100);
      const at1100 = await leafReport(page, { names: ['親', '子', '親 直轄領'] });
      expect(at1100.entries.map((e) => e.name).sort()).toEqual(['子', '親 直轄領'].sort());
      expect(at1100.maxPairOverlapKm2).toBe(0);
      // 1050 年（子が居ない年）の親は形を持つ末端のまま。
      await jumpToYear(page, 1050);
      const at1050 = await leafReport(page, { names: ['親', '子', '親 直轄領'] });
      expect(at1050.entries.map((e) => e.name)).toEqual(['親']);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // 2026-10-04（B39 の戻しの再検証）: 子が途中で終わる形は、勧められる修復 1 回で解けるとは限らない
  // （守り B: 分け残しを作っても解けきらないかもしれない形は、既定を「そのまま残す」にして理由を出す）。
  // ここでは ① 勧められるまま（そのまま残す）で何も変えずに開くこと、② 2 番目の「直轄領を生成」を
  // 選べば幾何の直しで解けること（子の居なくなった年から親は元の形のまま）を見る。
  test('子が途中で終わる形 → 開き直し: 既定は「そのまま残す」で何も変えずに開き、「直轄領を生成」を選べば解ける', async () => {
    test.setTimeout(240_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b39e-'));
    const target = join(workDir, 'b39e.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: target } });
    try {
      await jumpToYear(page, 1000);
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const parentId = await drawFace(page, squareCorners(cx + 60, cy, 150), { name: '親' });
      await jumpToYear(page, 1100);
      expect(await drawChild(page, { x: cx + 10, y: cy - 70, half: 30 }, '子')).toBe(parentId);
      // 子を 1200 年で終わらせる（素性欄の「この年に終わったことにする」）。
      await jumpToYear(page, 1200);
      await page.getByTestId('sidebar-tab-properties').click();
      await page.getByTestId('end-here').click();
      const impact = page.getByTestId('end-here-impact');
      if ((await impact.count()) > 0) await page.getByTestId('end-here-impact-confirm').click();
      await expect.poll(async () => (await leafReport(page, { names: ['子'] })).entries.length).toBe(0);
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');

      // ① 勧められるまま: 既定は「そのまま残す」で、理由の 1 行が出る。何も変えずに開く。
      const loading = loadProject(page, target);
      const board = page.getByTestId('repair-dialog');
      await expect(board).toBeVisible();
      await expect(page.getByTestId('repair-note-0')).toContainText('自動では整わない');
      await expect(page.getByTestId('repair-option-0-keep-leaf-with-children')).toBeChecked();
      await page.getByTestId('repair-apply').click();
      expect(await loading).toBe('loaded');
      await expect(page.getByTestId('statusbar-result')).toContainText('そのまま残した');
      await jumpToYear(page, 1100);
      expect((await leafReport(page, { names: ['親', '子'] })).entries.map((e) => e.name).sort()).toEqual(
        ['子', '親'].sort(),
      );

      // ② もう一度開き直して「直轄領を生成」を選ぶ → 1 回で解ける（やり直しの板が出ない）。
      const loading2 = loadProject(page, target);
      await expect(board).toBeVisible();
      await page.getByTestId('repair-option-0-materialize-direct-domain').check();
      await page.getByTestId('repair-apply').click();
      await expect(board).toHaveCount(0);
      expect(await loading2).toBe('loaded');
      await jumpToYear(page, 1150);
      const at1150 = await leafReport(page, { names: ['親', '子', '親 直轄領'] });
      expect(at1150.entries.map((e) => e.name).sort()).toEqual(['子', '親 直轄領'].sort());
      // 子の居なくなった年から、親は元の形（穴なし）のまま。
      await jumpToYear(page, 1300);
      const at1300 = await leafReport(page, { names: ['親', '子', '親 直轄領'] });
      expect(at1300.entries.map((e) => e.name)).toEqual(['親']);
      await jumpToYear(page, 1050);
      const at1050 = await leafReport(page, { names: ['親'] });
      expect(at1300.entries[0]!.areaKm2!).toBeCloseTo(at1050.entries[0]!.areaKm2!, 0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

