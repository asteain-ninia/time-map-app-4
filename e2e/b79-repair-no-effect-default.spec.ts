// B79: 修復の板の既定（各行の先頭）に、効かない方法を出さない。
//
// 一度も子を持たない集約地物には「子の居ない年の間だけ無くす」は効かない。これが先頭だと、何も
// 触らずに押すと「解消できませんでした」になり、もう一度押すと読み込みが止まった。今は既定が
// 「そのまま残す」で、押すと開き、記録は消えない。この形は今のアプリの操作では作れない
// （古いファイルの形）ので、保存したファイルの中身を手で組んだ記録へ差し替えて開く。
// 単体は `src/ui/file-ops/repair-flow-no-effect.test.ts`。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  drawFace,
  launchApp,
  loadProject,
  squareCorners,
} from './helpers';

test.describe('B79 — 修復の板の既定に効かない方法を出さない', () => {
  test('一度も子を持たない集約地物: 既定の「そのまま残す」で開け、見本の面も残る', async () => {
    test.setTimeout(120_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-b79-'));
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
      const histories = manifest['histories'] as readonly Record<string, unknown>[];
      const sample = (histories[0] as {
        entries: readonly { anchor: { snapshot: { features: readonly Record<string, unknown>[] } } }[];
      }).entries[0]!.anchor.snapshot.features[0]!;
      const { shape: _shape, ...withoutShape } = sample;
      const lonely = {
        ...withoutShape,
        kind: 'aggregate',
        id: 'L',
        childIds: [],
        attributes: { name: '子の居ない国', startYear: 0, endYear: 9999 },
      };
      manifest['histories'] = [
        ...histories,
        {
          featureId: 'L',
          entries: [
            {
              anchor: { id: 'anchor-L', snapshot: { features: [lonely], vertices: [] } },
              start: { granularity: 'year', year: 1000 },
              end: null,
            },
          ],
        },
      ];
      zip['manifest.json'] = strToU8(JSON.stringify(manifest));
      writeFileSync(tampered, zipSync(zip));

      const loading = loadProject(page, tampered).catch((e: unknown) => String(e));
      const board = page.getByTestId('repair-dialog');
      await expect(board).toBeVisible();
      // 効かない方法は無く、既定は「そのまま残す」。なぜ外したかの 1 行も出る。
      await expect(page.getByTestId('repair-option-0-remove-empty-aggregate-intervals')).toHaveCount(0);
      await expect(page.getByTestId('repair-option-0-keep-empty-aggregate')).toBeChecked();
      await expect(page.getByTestId('repair-note-0')).toBeVisible();

      // 何も触らずに押すと開く（以前は「解消できませんでした」の板が出直した）。
      await page.getByTestId('repair-apply').click();
      expect(await loading).toBe('loaded');
      await expect(board).toBeHidden();
      await expect(page.getByTestId('repair-unresolved')).toHaveCount(0);
      await expect(page.getByTestId('statusbar-result')).toContainText('そのまま残した');
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
