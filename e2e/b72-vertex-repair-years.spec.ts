// B72: 読み込みの修復「頂点の座標の食い違いを揃える」を実アプリの板から当てても、
// 正しく動かした年の座標が巻き戻らないこと。
//
// 単体（`src/domain/persistence/repair.vertex-time.test.ts`）は修復の中身を、ここは
// ファイルを開く → 修復の板 → 適用 → 年ごとの形、の経路を見る。
// 食い違いは今のアプリの操作では作れない（古いファイルの形）ので、保存したファイルの
// 地物を手で組んだ記録へ差し替えて開く。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  jumpToYear,
  launchApp,
  leafReport,
  loadProject,
  squareCorners,
} from './helpers';

type Pt = readonly [string, number, number];

test.describe('B72 — 頂点を揃える修復は、動かした年の座標を巻き戻さない', () => {
  test('板で適用しても、F の角 a2 は 1500 年の座標のまま、共有の a1 は 1500 年から揃う', async () => {
    test.setTimeout(120_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b72-'));
    const template = join(workDir, 'template.gimoza');
    const tampered = join(workDir, 'tampered.gimoza');
    const { app, page } = await launchApp({ extraEnv: { E2E_SAVE_AS_PATH: template } });
    try {
      // 保存して、設定と地物の書式の見本を得る。
      await armAddAreaTool(page);
      const b = await addInputLayerBox(page);
      await drawFace(page, squareCorners(b.x + b.width / 2, b.y + b.height / 2, 60), { name: '見本' });
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('statusbar-result')).toContainText('保存しました');

      const zip = unzipSync(new Uint8Array(readFileSync(template)));
      const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as Record<string, unknown>;
      const sample = (manifest['histories'] as readonly {
        entries: readonly { anchor: { snapshot: { features: readonly Record<string, unknown>[] } } }[];
      }[])[0]!.entries[0]!.anchor.snapshot.features[0]!;

      const entry = (id: string, anchorId: string, points: readonly Pt[], start: number, end: number | null) => ({
        anchor: {
          id: anchorId,
          snapshot: {
            features: [
              {
                ...sample,
                id,
                attributes: { name: id, startYear: 0, endYear: 9999 },
                shape: {
                  rings: [
                    { kind: 'territory', id: `${id}-r`, vertexIds: points.map((p) => p[0]) },
                  ],
                },
              },
            ],
            vertices: points.map(([vid, lon, lat]) => ({ id: vid, coordinate: { lon, lat } })),
          },
        },
        start: { granularity: 'year', year: start },
        end: end === null ? null : { granularity: 'year', year: end },
      });
      const f = (a2: readonly [number, number]): Pt[] => [
        ['a0', 0, 0],
        ['a1', 10, 0],
        ['a2', a2[0], a2[1]],
        ['a3', 0, 10],
      ];
      const g: Pt[] = [
        ['a1', 10, -1],
        ['g1', 20, 0],
        ['g2', 20, -10],
        ['g3', 10, -10],
      ];
      manifest['histories'] = [
        {
          featureId: 'F',
          entries: [entry('F', 'f0', f([10, 10]), 1000, 1500), entry('F', 'f1', f([12, 12]), 1500, null)],
        },
        { featureId: 'G', entries: [entry('G', 'g0', g, 1500, null)] },
      ];
      zip['manifest.json'] = strToU8(JSON.stringify(manifest));
      writeFileSync(tampered, zipSync(zip));

      const loading = loadProject(page, tampered).catch((e: unknown) => String(e));
      const board = page.getByTestId('repair-dialog');
      await expect(board).toBeVisible();
      // 修復の方法は 1 つなので選ばせない（行には直し方の文だけが出る）。
      await expect(page.getByTestId('repair-fix-0')).toBeVisible();
      await page.getByTestId('repair-apply').click();
      expect(await loading).toBe('loaded');
      await expect(board).toBeHidden();

      // 修復の結果をドメインの値で読む。面積は手で組んだ形から決まる（赤道の近くなので、度の
      // 正方形どうしの比がほぼそのまま出る）。F の 1000 年は 10×10＝100。1500 年は a2 が (12,12) なので
      // 外積の合計から 120。G は a1 が (10,0) へ揃えば F の 1000 年と南北対称で同じ 100（揃わなければ 95）。
      await jumpToYear(page, 1000);
      const f1000 = (await leafReport(page, { ids: ['F'] })).entries[0]!.areaKm2!;
      await jumpToYear(page, 1500);
      const f1500 = (await leafReport(page, { ids: ['F'] })).entries[0]!.areaKm2!;
      const g1500 = (await leafReport(page, { ids: ['G'] })).entries[0]!.areaKm2!;
      expect(f1500 / f1000).toBeGreaterThan(1.18);
      expect(g1500 / f1000).toBeCloseTo(1, 2);
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
