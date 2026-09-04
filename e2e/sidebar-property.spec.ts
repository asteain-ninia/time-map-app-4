// HB-3 回帰ロック — behavioural E2E: the right sidebar mounts the property /
// feature / event panels and the PropertyPanel renders INSIDE the sidebar with its
// fields visible (人間テスト発見バグ「右サイドバーが空・PropertyPanel が画面下部に
// 無スタイルで並ぶ」).
//
// The earlier suites never asserted the sidebar had any content — the slots were
// never wired in the composition root (App.tsx mounted AppShell without the
// `sidebar` prop), so the PropertyPanel was never mounted at all and the sidebar
// shipped empty + green. This spec closes that死角 with REAL input: it commits one
// 面 through the live add flow (which promotes it as the active feature), then
// asserts the PropertyPanel lives inside the sidebar properties panel and its
// basic-info fields are VISIBLE. A `toHaveScreenshot` baseline of the sidebar
// guards against the empty / unstyled regression visually (offscreen決定論描画).

import { test, expect } from '@playwright/test';

import { commitOneFace, launchApp, openPropertySection } from './helpers';

test.describe('HB-3: 右サイドバーにプロパティ/地物/イベントパネルが結線される', () => {
  test('the sidebar mounts the three panels and the PropertyPanel is inside it', async () => {
    const { app, page } = await launchApp();
    try {
      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar).toBeVisible();

      // The property panel is mounted INSIDE the sidebar's properties panel — not
      // leaked to the page bottom (the HB-3 symptom). The default active section is
      // プロパティ, so it is visible on boot.
      const propertiesPanel = page.getByTestId('sidebar-panel-properties');
      const propertyPanel = propertiesPanel.getByTestId('property-panel');
      await expect(propertyPanel).toBeVisible();

      // HB6: 地物一覧 / 錨一覧 are unified into the「一覧」slot with a 現在時刻 / 通史
      // mode toggle. The unified list + both mode toggles are mounted in the panel.
      const listPanel = page.getByTestId('sidebar-panel-list');
      await expect(listPanel.getByTestId('list-mode-current')).toBeAttached();
      await expect(listPanel.getByTestId('list-mode-history')).toBeAttached();
      await expect(listPanel.getByTestId('unified-list')).toBeAttached();
    } finally {
      await app.close();
    }
  });

  test('selecting a feature shows the PropertyPanel fields visible in the sidebar', async () => {
    const { app, page } = await launchApp();
    try {
      // Commit one real 面 through the live add flow; the live selection
      // re-resolves to it (app-active-feature marker becomes non-empty).
      await commitOneFace(page);

      // The property panel re-resolved to the committed feature: its basic-info
      // form (a field host) is now VISIBLE inside the sidebar properties panel,
      // not at the page bottom.
      const propertiesPanel = page.getByTestId('sidebar-panel-properties');
      const basicInfo = propertiesPanel.getByTestId('basic-info');
      await expect(basicInfo).toBeVisible();

      // A concrete editable field is visible (proof the fields render, not just a
      // guidance message) — the 名前 input.
      const nameField = basicInfo.getByLabel('名前');
      await expect(nameField).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // 増分 2 の手直し D1 — 素性欄に **横スクロールバーが出ない**（バグ狩り #10 / 設計 A3）。
  //
  // これは jsdom では測れない（レイアウトが無く矩形が常に 0、開発ガイド §5.49）。実測では
  // 内容幅 182px の欄に 233px の中身が入っており、犯人は fieldset の既定
  // `min-inline-size: min-content` を持つ `.style-section__color` だった。
  // **画像ではなく寸法で押さえる**（基準画像は不具合が写ったまま固定されうる）。
  test('素性欄に横スクロールが出ない（畳んだ状態でも開いた状態でも）', async () => {
    const { app, page } = await launchApp();
    try {
      await commitOneFace(page);
      const propertiesPanel = page.getByTestId('sidebar-panel-properties');
      const panel = propertiesPanel.getByTestId('property-panel');
      await expect(panel).toBeVisible();

      const overflow = async (): Promise<{ scrollWidth: number; clientWidth: number }> =>
        panel.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));

      const collapsed = await overflow();
      expect(collapsed.clientWidth).toBeGreaterThan(0);
      expect(collapsed.scrollWidth).toBeLessThanOrEqual(collapsed.clientWidth);

      // 節を全部開いても収まる（見た目の節に色見本とスライダーが入る）。
      for (const id of ['style-section', 'anchor-section', 'detail-document-section']) {
        await openPropertySection(page, id);
      }
      const opened = await overflow();
      expect(opened.scrollWidth).toBeLessThanOrEqual(opened.clientWidth);
    } finally {
      await app.close();
    }
  });

  test('visual regression: the empty sidebar renders its chrome (not blank)', async () => {
    const { app, page } = await launchApp();
    try {
      // Let post-mount layout + first paint settle so the capture is stable.
      await page.waitForTimeout(1000);
      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar).toBeVisible();
      // Baseline-compare the empty sidebar region (tabs + guidance). A blank /
      // unstyled sidebar (the HB-3 regression) would differ from this baseline.
      await expect(sidebar).toHaveScreenshot('sidebar-empty.png', {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await app.close();
    }
  });

  test('visual regression: the populated property panel is styled (basic-info visible)', async () => {
    const { app, page } = await launchApp();
    try {
      // Commit one 面 so the property panel renders its full chrome — the
      // basic-info form + style + anchor sections (the parts that shipped with NO
      // CSS pre-HB-3). This baseline guards against那些 styles being dropped.
      await commitOneFace(page);
      const propertiesPanel = page.getByTestId('sidebar-panel-properties');
      await expect(propertiesPanel.getByTestId('basic-info')).toBeVisible();
      await page.waitForTimeout(500);
      await expect(propertiesPanel).toHaveScreenshot('sidebar-property-populated.png', {
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await app.close();
    }
  });
});
