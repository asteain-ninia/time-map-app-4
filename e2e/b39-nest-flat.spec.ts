// B39 の直し — 面の中に子を描くと、確定した時点で親がまとめ役になり（分け残しが生まれる）、
// 2 人目・3 人目は同じまとめ役の下に平らに並ぶ。保存して開き直しても修復を聞かれない。
// 取り消し 1 回で「子の追加」と「親の集約化（または分け残しの削り）」がまとめて戻る。
//
// 単体（`src/domain/promotion/carve.test.ts`）はドメインの経路を固定する。ここは
// **実アプリの確定の経路**（素性欄の既定・追加の束ねの重なりの検出・取り消しの単位・保存）を
// 通して見る ―― 2 人目で「重なりの解決」の板が出る、既定が分け残しを指す、といった
// 配線の欠陥は単体では緑のまま残る（開発ガイド §5.49）。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterEditMode,
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

/** 開き直す。**修復の板・未保存の確認が出たら失敗にする**（`inc7-fix2.spec.ts` と同じ見方）。 */
async function reopenWithoutBoards(page: Page, path: string): Promise<LoadProjectOutcome> {
  const loading = loadProject(page, path);
  const boardShown = page
    .locator('[data-testid="repair-dialog"],[data-testid="unsaved-dialog"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => 'board' as const)
    .catch(() => 'none' as const);
  const first = await Promise.race([loading, boardShown]);
  if (first === 'board') {
    const text = await page
      .locator('[data-testid="repair-dialog"],[data-testid="unsaved-dialog"]')
      .first()
      .textContent();
    throw new Error(`開き直しで板が出た: ${text ?? ''}`);
  }
  return first === 'none' ? loading : first;
}

async function activeFeature(page: Page): Promise<string> {
  return ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
}

/**
 * 親の内側に子を描いて保存する。上位領域の欄の既定と、保存後に選ばれた地物（＝新しい子）を返す。
 * **重なりの解決の板が出ないこと**もここで見る（2 人目以降は分け残しの中に描くので、
 * 追加の試し当てでは分け残しと必ず重なる ―― 聞かずに分け残しを削るのが今回の直し）。
 */
async function drawChild(
  page: Page,
  at: { readonly x: number; readonly y: number; readonly half: number },
  name: string,
): Promise<{ readonly defaultParent: string; readonly id: string }> {
  const before = await activeFeature(page);
  await armAddAreaTool(page);
  await placeVertices(page, squareCorners(at.x, at.y, at.half));
  await page.getByTestId('add-complete').click();
  const select = page.getByTestId('add-parent');
  await expect(select).toBeVisible();
  const defaultParent = await select.inputValue();
  await page.getByTestId('add-name').fill(name);
  await page.getByTestId('add-save').click();
  await expect.poll(() => activeFeature(page)).not.toBe(before);
  await expect(page.getByTestId('conflict-modal-root')).toHaveCount(0);
  await expect(page.getByTestId('add-property-form')).toHaveCount(0);
  return { defaultParent, id: await activeFeature(page) };
}

test.describe('B39 — 面の中に子を描くと平らに並び、開き直しで修復を聞かれない', () => {
  test('子 3 人: 親 →［子1, 子2, 子3, 分け残し］。保存 → 開き直しで板が出ない', async () => {
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

      const children = [
        await drawChild(page, { x: cx + 10, y: cy - 70, half: 30 }, '子1'),
        await drawChild(page, { x: cx + 110, y: cy - 70, half: 30 }, '子2'),
        await drawChild(page, { x: cx + 60, y: cy + 70, half: 30 }, '子3'),
      ];
      // 既定は 3 人とも親（2 人目以降も、1 人目で生まれた分け残しを指さない）。
      for (const c of children) expect(c.defaultParent).toBe(parentId);

      // 画面の上でも重なりが無い（分け残しは 3 人ぶん削られている）。
      const report = await leafReport(page, { names: ['子1', '子2', '子3', '親 直轄領'] });
      expect(report.entries.map((e) => e.name).sort()).toEqual(
        ['子1', '子2', '子3', '親 直轄領'].sort(),
      );
      expect(report.maxPairOverlapKm2).toBe(0);

      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      expect(existsSync(target)).toBe(true);

      // 書き出したファイル: 親はまとめ役、直下は子 3 人と分け残し 1 つ（平ら）。
      const saved = savedFeatures(target);
      expect(saved.get(parentId)?.kind).toBe('aggregate');
      const under = [...saved.values()].filter((f) => f.parentId === parentId);
      const dds = [...saved.values()].filter((f) => f.directDomain === true);
      expect(dds).toHaveLength(1);
      expect(dds[0]!.parentId).toBe(parentId);
      expect(dds[0]!.attributes?.name).toBe('親 直轄領');
      expect(under.map((f) => f.id).sort()).toEqual(
        [...children.map((c) => c.id), dds[0]!.id].sort(),
      );
      // 分け残しの名前の連鎖が無い。
      expect([...saved.values()].some((f) => (f.attributes?.name ?? '').includes('直轄領 直轄領'))).toBe(
        false,
      );

      // 開き直しで修復の板が出ない（旧 B39 はここで毎回聞かれていた）。
      expect(await reopenWithoutBoards(page, target)).toBe('loaded');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('取り消し 1 回で「子の追加」と「親の集約化／分け残しの削り」がまとめて戻り、やり直しで戻る', async () => {
    test.setTimeout(240_000);
    const { app, page } = await launchApp();
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      await drawFace(page, squareCorners(cx + 60, cy, 150), { name: '親' });
      await drawChild(page, { x: cx + 10, y: cy - 70, half: 30 }, '子1');
      const afterFirst = await leafReport(page, { names: ['親', '親 直轄領', '子1'] });
      const ddAfterFirst = afterFirst.entries.find((e) => e.name === '親 直轄領');
      expect(ddAfterFirst).toBeDefined();
      // 親は末端としては居ない（まとめ役になった）。
      expect(afterFirst.entries.some((e) => e.name === '親')).toBe(false);

      await drawChild(page, { x: cx + 110, y: cy - 70, half: 30 }, '子2');
      const afterSecond = await leafReport(page, { names: ['親 直轄領', '子2'] });
      const ddAfterSecond = afterSecond.entries.find((e) => e.name === '親 直轄領')!;
      expect(ddAfterSecond.areaKm2!).toBeLessThan(ddAfterFirst!.areaKm2!);

      await enterEditMode(page);
      // 1 回目の取り消し: 子2 が消え、分け残しは 1 人目のあとの形へ戻る。
      await page.keyboard.press('Control+z');
      await expect
        .poll(async () => (await leafReport(page, { names: ['子2'] })).entries.length)
        .toBe(0);
      const undone1 = await leafReport(page, { names: ['親 直轄領'] });
      expect(undone1.entries[0]?.areaKm2).toBeCloseTo(ddAfterFirst!.areaKm2!, 3);
      expect(undone1.entries[0]?.ringCount).toBe(ddAfterFirst!.ringCount);

      // 2 回目の取り消し: 子1 と分け残しが消え、親は形を持つ末端へ戻る（中間の姿が無い）。
      await page.keyboard.press('Control+z');
      await expect
        .poll(async () =>
          (await leafReport(page, { names: ['子1', '親 直轄領', '親'] })).entries.map((e) => e.name),
        )
        .toEqual(['親']);

      // やり直し 2 回で 2 人とも戻る。
      await page.keyboard.press('Control+y');
      await page.keyboard.press('Control+y');
      await expect
        .poll(async () =>
          (await leafReport(page, { names: ['子1', '子2', '親 直轄領', '親'] })).entries
            .map((e) => e.name)
            .sort(),
        )
        .toEqual(['子1', '子2', '親 直轄領'].sort());
    } finally {
      await app.close();
    }
  });
});
