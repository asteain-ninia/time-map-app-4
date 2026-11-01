// B42: 共有頂点の最初の持ち主が隠れていても、見えている別の地物が引いていれば、その頂点は
// 描かれていて吸着できる。単体は `src/ui/map/live-hit-test.test.tsx` の「共有頂点の最初の持ち主が
// 隠れている」。ここは、面を隠す → 隣の国の角に吸着して描く → 保存して開き直す、の経路を見る。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  loadProject,
  selectedVertexIds,
  squareCorners,
  worldToClient,
} from './helpers';

type Pt = readonly [string, number, number];

interface SavedFeature {
  readonly id: string;
  readonly shape?: { readonly rings: readonly { readonly vertexIds: readonly string[] }[] };
}
interface SavedHistory {
  readonly featureId: string;
  readonly entries: readonly { readonly anchor: { readonly snapshot: { readonly features: readonly SavedFeature[] } } }[];
}

test.describe('B42 — 隠れた持ち主の共有頂点も、見えている地物の頂点として吸着する', () => {
  test('最初の持ち主を隠しても、隣の国の角へ吸着して描ける。開き直して修復を聞かれない', async () => {
    test.setTimeout(120_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b42-'));
    const template = join(workDir, 'template.gimoza');
    const tampered = join(workDir, 'tampered.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: template } });
    try {
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      await drawFace(page, squareCorners(b.x + b.width / 2, b.y + b.height / 2, 60), { name: '見本' });
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');

      const zip = unzipSync(new Uint8Array(readFileSync(template)));
      const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as Record<string, unknown>;
      const sample = (manifest['histories'] as readonly SavedHistory[])[0]!.entries[0]!.anchor.snapshot
        .features[0]!;
      const history = (id: string, points: readonly Pt[]) => ({
        featureId: id,
        entries: [
          {
            anchor: {
              id: `anchor-${id}`,
              snapshot: {
                features: [
                  {
                    ...sample,
                    id,
                    attributes: { name: id, startYear: 0, endYear: 9999 },
                    shape: { rings: [{ kind: 'territory', id: `${id}-r`, vertexIds: points.map((p) => p[0]) }] },
                  },
                ],
                vertices: points.map(([vid, lon, lat]) => ({ id: vid, coordinate: { lon, lat } })),
              },
            },
            start: { granularity: 'year', year: 1000 },
            end: null,
          },
        ],
      });
      // A と B は s1・s2 を共有する。索引の最初の持ち主は A。
      manifest['histories'] = [
        history('A', [['a0', 0, 0], ['s1', 20, 0], ['s2', 20, 20], ['a3', 0, 20]]),
        history('B', [['s1', 20, 0], ['b1', 40, 0], ['b2', 40, 20], ['s2', 20, 20]]),
      ];
      zip['manifest.json'] = strToU8(JSON.stringify(manifest));
      writeFileSync(tampered, zipSync(zip));
      expect(await loadProject(page, tampered)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);

      // A を隠して、選択を外す。
      await jumpToYear(page, 1000);
      await enterEditMode(page);
      const centerA = await worldToClient(page, { lon: 10, lat: 10 });
      await page.mouse.click(centerA.x, centerA.y, { button: 'right' });
      await page.getByTestId('context-menu').locator('[data-item-kind="hideFeature"]').click();
      const empty = await worldToClient(page, { lon: 100, lat: 60 });
      await page.mouse.click(empty.x, empty.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      // 共有の角を右クリックすると、見えている B が相手になる（隠れている A に向かない）。
      await page.getByTestId('tool-edit.vertex').click();
      const cornerForMenu = await worldToClient(page, { lon: 20, lat: 0 });
      await page.mouse.click(cornerForMenu.x, cornerForMenu.y, { button: 'right' });
      const menu = page.getByTestId('context-menu');
      await expect(menu).toBeVisible();
      await expect(page.getByTestId('app-active-feature')).toHaveText('B');
      await menu.locator('[data-item-kind="hideFeature"]').click();
      await expect(page.getByTestId('ledger-row-B')).toHaveAttribute('data-hidden', 'true');
      await expect(page.getByTestId('ledger-row-A')).toHaveAttribute('data-hidden', 'true');
      // B を見える状態へ戻して先へ進む（A は隠したまま）。
      await page.getByTestId('ledger-eye-B').click();
      // 左クリックで掴むと B の頂点が選ばれ、年を動かして戻っても持ち主は B のまま（選択の見直しが
      // 隠れた A へ付け替えない）。
      await page.mouse.click(cornerForMenu.x, cornerForMenu.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText('B');
      await expect.poll(async () => selectedVertexIds(page)).toEqual(['s1']);
      await jumpToYear(page, 1200);
      await jumpToYear(page, 1000);
      await expect(page.getByTestId('app-active-feature')).toHaveText('B');
      await expect.poll(async () => selectedVertexIds(page)).toEqual(['s1']);
      await page.getByTestId('tool-edit.select').click();
      await page.mouse.click(empty.x, empty.y);
      await expect(page.getByTestId('app-active-feature')).toHaveText('');

      // 新しい面の 1 点目を、共有の角 s1 に置く。
      await armAddAreaTool(page);
      const corner = await worldToClient(page, { lon: 20, lat: 0 });
      const p2 = await worldToClient(page, { lon: 30, lat: -20 });
      const p3 = await worldToClient(page, { lon: 10, lat: -20 });
      await drawFace(page, [[corner.x, corner.y], [p2.x, p2.y], [p3.x, p3.y]], { name: '新しい面' });
      await expect(page.getByTestId('statusbar-result')).toContainText('既存の頂点 1 個を共有');

      // 入力欄から焦点を外して保存する（教訓 5.54）。読み込んだ先への初回の上書きは必ず確認される。
      await page.getByTestId('statusbar').click();
      await page.keyboard.press('Control+s');
      await page.getByTestId('overwrite-confirm').click();
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');
      const saved = JSON.parse(
        strFromU8(unzipSync(new Uint8Array(readFileSync(tampered)))['manifest.json']!),
      ) as { histories: readonly SavedHistory[] };
      const created = saved.histories
        .flatMap((h) => h.entries.flatMap((e) => e.anchor.snapshot.features))
        .find((f) => f.id !== 'A' && f.id !== 'B');
      // 吸着したので、同じ頂点 id を引く（座標が同じだけの別の頂点ではない）。
      expect(created?.shape?.rings[0]?.vertexIds).toContain('s1');

      // 開き直す → 修復を聞かれない（読み込みの検査が何も言わない）。
      expect(await loadProject(page, tampered)).toBe('loaded');
      await expect(page.getByTestId('repair-dialog')).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
