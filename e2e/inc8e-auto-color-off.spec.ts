// 増分 8E — G-15（FR-100）: 自動配色を OFF にしたとき、いま塗られている色を手動色として残す。
//
// 素性欄「見た目」の［自動配色を許可］を外して保存すると、地図の色は変わらず（既定色へ
// 戻らない）、色の欄がその色のまま手で直せるようになる。

import { test, expect, type Locator, type Page } from '@playwright/test';

import { commitOneFace, jumpToYear, launchApp, openPropertySection, requestYear } from './helpers';

/** その地物が地図で実際に塗られている色（描画と同じ解決を通る観測口）。 */
async function drawnFill(page: Page, featureId: string): Promise<string | undefined> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          __E2E__: { getDrawnFeatureFills: () => Record<string, string> };
        }
      ).__E2E__.getDrawnFeatureFills()[id],
    featureId,
  );
}

test.describe('増分 8E — G-15: 自動配色を OFF にしても、いまの色が残る', () => {
  test('［自動配色を許可］を外して保存すると、地図の色はそのままで、色の欄が手で直せるようになる', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();

      await openPropertySection(page, 'style-section');
      const section = page.getByTestId('style-section');
      const auto = section.getByLabel('自動配色を許可');
      const fillPicker = section.getByLabel('通常表示色', { exact: true });
      // 新しい面は自動配色で塗られている（色の欄は閲覧のみ）。
      await expect(auto).toBeChecked();
      await expect(fillPicker).toBeDisabled();
      const before = await drawnFill(page, faceId);
      const pickerBefore = await fillPicker.inputValue();
      expect(before).toBeDefined();

      await auto.uncheck();
      // 外した瞬間から、色の欄はいまの色のまま手で直せる。
      await expect(fillPicker).toBeEnabled();
      await expect(fillPicker).toHaveValue(pickerBefore);
      await page.getByTestId('save-button').click();

      // 保存しても地図の色は変わらない（既定色へ戻らない）。
      await expect(auto).not.toBeChecked();
      await expect.poll(async () => drawnFill(page, faceId)).toBe(before);
      await expect(fillPicker).toHaveValue(pickerBefore);
    } finally {
      await app.close();
    }
  });

  // 増分 8E の手直し（GPT 重 3）: 切り替えを往復しても、打ち込んだ手動色・透過を失わない。
  test('OFF にして色と透過を打ち、ON → OFF と往復しても、打った値が残り、そのまま保存される', async () => {
    const { app, page } = await launchApp();
    try {
      const { faceId } = await commitOneFace(page);
      await page.getByTestId('tool-edit.select').click();
      await openPropertySection(page, 'style-section');
      const section = page.getByTestId('style-section');
      const auto = section.getByLabel('自動配色を許可');
      const fillPicker = section.getByLabel('通常表示色', { exact: true });
      const fillOpacity = section.getByLabel('通常表示色透過', { exact: true });
      const selectedPicker = section.getByLabel('選択表示色', { exact: true });
      const selectedOpacity = section.getByLabel('選択表示色透過', { exact: true });

      await auto.uncheck();
      await expect(fillPicker).toBeEnabled();
      await fillPicker.fill('#123456');
      await setRange(fillOpacity, '0.3');
      await selectedPicker.fill('#654321');
      await setRange(selectedOpacity, '0.4');

      // 往復する（ON の間は色の欄を触れない）。
      await auto.check();
      await expect(fillPicker).toBeDisabled();
      await auto.uncheck();

      await expect(fillPicker).toHaveValue('#123456');
      await expect(fillOpacity).toHaveValue('0.3');
      await expect(selectedPicker).toHaveValue('#654321');
      await expect(selectedOpacity).toHaveValue('0.4');

      // 保存すると、打った色で地図が塗られる。
      await page.getByTestId('save-button').click();
      await expect(auto).not.toBeChecked();
      await expect(fillPicker).toHaveValue('#123456');
      await expect(fillOpacity).toHaveValue('0.3');
      // 選んでいる面は選択表示色で塗られることがあるので、打ったどちらかの色であることを見る。
      await expect
        .poll(async () => drawnFill(page, faceId))
        .toMatch(/#123456|#654321|18, ?52, ?86|101, ?67, ?33/i);
    } finally {
      await app.close();
    }
  });
});

// 増分 8E の再手直し（再検証 3-1）: 「見た目」の欄が外れて付き直っても（選択を外す・居ない年へ
// 動く →［残す］で戻る）、往復で打った色が消えない。覚えを欄の部品に持っていた版では、戻った
// あとの ON → OFF で、打った #123456・0.3 が地図に塗られている色へ置き換わっていた。
test.describe('増分 8E — G-15: 欄が外れて付き直ったあとの往復', () => {
  for (const way of ['居ない年へ動く', '地図の空いた所を押して選択を外す'] as const) {
    test(`${way} →［残す］で戻ったあと、ON → OFF と往復しても打った色と透過が残る`, async () => {
      const { app, page } = await launchApp();
      try {
        await jumpToYear(page, 1200);
        const { cx, cy } = await commitOneFace(page);
        await page.getByTestId('tool-edit.select').click();
        await openPropertySection(page, 'style-section');
        const section = page.getByTestId('style-section');
        const auto = section.getByLabel('自動配色を許可');
        const fillPicker = section.getByLabel('通常表示色', { exact: true });
        const fillOpacity = section.getByLabel('通常表示色透過', { exact: true });
        await auto.uncheck();
        await fillPicker.fill('#123456');
        await setRange(fillOpacity, '0.3');

        if (way === '居ない年へ動く') {
          await requestYear(page, 1000);
        } else {
          await page.mouse.click(cx + 220, cy + 160);
        }
        await expect(page.getByTestId('draft-discard-confirm')).toBeVisible();
        await page.getByTestId('draft-discard-keep').click();
        await expect(page.getByTestId('draft-discard-confirm')).toHaveCount(0);
        await openPropertySection(page, 'style-section');
        await expect(fillPicker).toHaveValue('#123456');

        await auto.check();
        await auto.uncheck();
        await expect(fillPicker).toHaveValue('#123456');
        await expect(fillOpacity).toHaveValue('0.3');
      } finally {
        await app.close();
      }
    });
  }
});

/** 範囲の欄（`type="range"`）に値を入れる（Playwright の fill は range を受けない）。 */
async function setRange(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
