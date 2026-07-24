// HB4-1 回帰ロック — behavioural + screenshot E2E: 継承先選択モーダル (FR-93) の
// 分断プレビューが **赤道をまたがない地物でも** 描かれ、かつ **北が上** であること.
//
// 実機報告 (D56):「ナイフツール実行時、地物のプレビューが表示されない。四角だけ出る」。
// 真因は InheritorModal の SVG 座標空間不一致 — viewBox と`knife-smaller-box` の <rect>
// は -lat 空間、片の <path> だけが +lat 空間で書かれていた。両者の y 区間が重なるのは
// `minLat ≤ 0 ≤ maxLat`、つまり **赤道をまたぐ地物だけ**。北半球に閉じた地物では片が
// viewBox の外に落ちて 1px も描かれず、-lat 空間で正しく書かれた赤い点線の <rect> だけが
// 残る = 「四角だけ出る」。
//
// 既存 E2E (knife-nway) が緑のままだったのは、面を **地図セルの中央 = 緯度 0** に作る
// フィクスチャ単一文化のせいで、片が偶然 viewBox に収まっていたため。本 spec はその盲点を
// 塞ぐ: 面を画面中央より十分上に作り、緯度帯が北半球に閉じていることをログで裏取りしてから
// 縦一直線に切断し、モーダルの実 DOM (viewBox / path d) を数値照合する。
//
// 向きの検証 (診断 §6 注意): -lat 空間に統一した以上、<svg> に CSS `scaleY(-1)` を
// 掛けると二重反転で上下逆さになる。幾何アサーションだけでは上下逆さを検出できないので、
// 「北端の SVG y < 南端の SVG y」と「CSS 反転が無いこと」の両方を固定する。

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { test, expect, type Page } from '@playwright/test';

import { launchApp } from './helpers';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = resolve(projectRoot, 'screenshots');
mkdirSync(shotDir, { recursive: true });

/** Leave 閲覧モード so a tool mode can be entered. */
async function leaveView(page: Page): Promise<void> {
  const viewToggle = page.getByTestId('mode-view');
  await expect(viewToggle).toBeVisible();
  if ((await viewToggle.getAttribute('aria-pressed')) === 'true') await viewToggle.click();
}

async function enterAddArea(page: Page): Promise<void> {
  await leaveView(page);
  const addMode = page.getByTestId('mode-add');
  await expect(addMode).toBeEnabled();
  if ((await addMode.getAttribute('aria-pressed')) !== 'true') await addMode.click();
  await expect(addMode).toHaveAttribute('aria-pressed', 'true');
  const areaTool = page.getByTestId('tool-add.area');
  await expect(areaTool).toBeVisible();
  if ((await areaTool.getAttribute('aria-pressed')) === 'true') await areaTool.click();
  await areaTool.click();
  await expect(areaTool).toHaveAttribute('aria-pressed', 'true');
}

async function armKnife(page: Page): Promise<void> {
  await leaveView(page);
  const editMode = page.getByTestId('mode-edit');
  await expect(editMode).toBeEnabled();
  if ((await editMode.getAttribute('aria-pressed')) !== 'true') await editMode.click();
  await expect(editMode).toHaveAttribute('aria-pressed', 'true');
  const knifeTool = page.getByTestId('tool-edit.knife');
  await expect(knifeTool).toBeEnabled();
  if ((await knifeTool.getAttribute('aria-pressed')) !== 'true') await knifeTool.click();
  await expect(knifeTool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('knife-input-layer')).toBeVisible();
}

/**
 * Every numeric pair of an `M`/`L` command (the only ones `pathFor` emits).
 *
 * The number pattern MUST accept exponent notation: `pathFor` interpolates
 * `${-c.lat}` and JS renders |x| < 1e-6 as `-1e-7`, which a `-?[\d.]+` pattern
 * would read back as `-1` (レビュー指摘 #3).
 */
const NUM = String.raw`-?[\d.]+(?:[eE][-+]?\d+)?`;

function pathYs(d: string): number[] {
  const ys: number[] = [];
  const re = new RegExp(String.raw`[ML]\s*${NUM}\s+(${NUM})`, 'g');
  let m = re.exec(d);
  while (m !== null) {
    ys.push(Number(m[1]));
    m = re.exec(d);
  }
  return ys;
}

/**
 * Does a **computed** CSS transform flip the element vertically?
 *
 * `style.transform` only sees the inline attribute, so a `transform: scaleY(-1)`
 * added to `.knife-preview` in knife.css would sail straight through the guard
 * (レビュー指摘 #1). Chromium resolves the cascade into a matrix, so read the
 * computed value and inspect the vertical scale component: `matrix(a,b,c,d,e,f)`
 * → `d`; `matrix3d(...)` → index 5. Negative = flipped = double inversion on top
 * of the -lat geometry.
 */
function isVerticallyFlipped(computedTransform: string): boolean {
  const t = computedTransform.trim();
  if (t === '' || t === 'none') return false;
  if (/scaleY\s*\(\s*-/.test(t)) return true;
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(t);
  if (m === null) return false; // unknown form: let the textual guard above decide
  const n = (m[2] ?? '').split(',').map((s) => Number(s.trim()));
  const yScale = m[1] === '3d' ? n[5] : n[3];
  return yScale !== undefined && Number.isFinite(yScale) && yScale < 0;
}

test.describe('HB4-1 — 継承先モーダルの分断プレビュー(北半球の地物でも描かれ、北が上)', () => {
  test('赤道をまたがない面を縦に切断 → 片の形が viewBox 内に描かれ、北が上を向く', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // --- 1. 画面中央より十分上に面を作る(既定カメラでは画面中央 = 緯度 0)。 ---
      // 形は **北を向いた三角形**。上下対称な矩形だと「北が上」かどうかが
      // スクショで判別できず、上下逆さのデグレを目視で見逃すため(診断 §6)。
      await enterAddArea(page);
      const addLayer = page.getByTestId('add-input-layer');
      await expect(addLayer).toBeVisible();
      const b = (await addLayer.boundingBox())!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const top = cy - 200; // 頂点(北の尖り)
      const bottom = cy - 70; // 底辺(南)
      for (const [px, py] of [
        [cx, top],
        [cx + 100, bottom],
        [cx - 100, bottom],
      ] as const) {
        await page.mouse.click(px, py);
      }
      await expect(page.getByTestId('add-vertex-count')).toHaveText('3');
      await page.getByTestId('add-complete').click();
      await page.getByTestId('add-save').click();
      await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);

      // --- 2. 緯度帯が北半球に閉じている(= 旧バグの発火条件)ことを裏取りする。 ---
      const latBand = await page.evaluate(
        ([yTop, yBottom, x]) => {
          const w = window as unknown as {
            __E2E__: {
              screenToWorld: (sx: number, sy: number) => { lon: number; lat: number } | null;
            };
          };
          return {
            top: w.__E2E__.screenToWorld(x, yTop),
            bottom: w.__E2E__.screenToWorld(x, yBottom),
          };
        },
        [top, bottom, cx] as const,
      );
      console.log(`KNIFE-PREVIEW-NORTH: latBand=${JSON.stringify(latBand)}`);
      expect(latBand.bottom, 'screenToWorld(bottom) returned null').not.toBeNull();
      // 面全体が赤道より北 = viewBox の y 窓と片の y 範囲が分離しうる条件。
      expect(latBand.bottom!.lat).toBeGreaterThan(0);
      expect(latBand.top!.lat).toBeGreaterThan(latBand.bottom!.lat);

      // --- 3. ナイフで面の上下を貫く縦一直線を引く(境界を 2 回跨ぐ → 2 片)。 ---
      // x は頂点から少しずらす(頂点を通す縮退切断を避ける)。斜辺と底辺を 1 回ずつ
      // 跨ぐので 2 片になり、どちらの片も上下非対称に残る。
      const cutX = cx + 35;
      await armKnife(page);
      await page.mouse.click(cx, bottom - 40);
      await page.mouse.click(cutX, top - 30);
      await page.mouse.click(cutX, bottom + 30);
      await expect(page.getByTestId('knife-cut-count')).toHaveText('2');

      await page.getByTestId('knife-confirm-cut').click();
      const rejected = page.getByTestId('knife-rejected');
      if ((await rejected.count()) > 0) {
        throw new Error(`knife cut was rejected: ${((await rejected.textContent()) ?? '').trim()}`);
      }
      await expect(page.getByTestId('knife-inheritor-modal-root')).toBeVisible();

      // --- 4. モーダルの実 DOM を数値照合する。 ---
      const geom = await page.evaluate(() => {
        const svg = document.querySelector('[data-testid="knife-preview"]');
        const rect = document.querySelector('[data-testid="knife-smaller-box"]');
        return {
          viewBox: (svg?.getAttribute('viewBox') ?? '').trim().split(/\s+/).map(Number),
          // COMPUTED (not inline): catches a scaleY(-1) arriving via knife.css.
          transform: svg === null ? '' : getComputedStyle(svg).transform,
          paths: Array.from(document.querySelectorAll('[data-testid^="knife-preview-"]')).map(
            (p) => p.getAttribute('d') ?? '',
          ),
          rect: { y: Number(rect?.getAttribute('y')), h: Number(rect?.getAttribute('height')) },
        };
      });
      console.log(`KNIFE-PREVIEW-NORTH: geom=${JSON.stringify(geom).slice(0, 800)}`);

      const [, vbY, , vbH] = geom.viewBox as [number, number, number, number];
      expect(geom.paths.length).toBe(2);
      const ys = geom.paths.flatMap((d) => pathYs(d));
      expect(ys.length).toBeGreaterThan(0);

      // 実機の緯度は割り切れない値なので `vbY + vbH` は片の座標と ~1e-15 ずれる。
      // 窓の高さに比例した許容量で丸めを吸収する(旧バグのズレは「窓の高さ 1 個分
      // 以上」= 数十度 なので、この許容量でも取りこぼさない)。
      const eps = Math.abs(vbH) * 1e-9;

      // THE ASSERTION: 片の座標は viewBox の y 窓の内側 = 実際に描画される。
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(vbY - eps);
        expect(y).toBeLessThanOrEqual(vbY + vbH + eps);
      }
      // 小さい方ボックスも同じ空間(修正前はこれ「だけ」が残っていた)。
      expect(geom.rect.y).toBeGreaterThanOrEqual(vbY - eps);
      expect(geom.rect.y + geom.rect.h).toBeLessThanOrEqual(vbY + vbH + eps);

      // 北が上: 面は北半球に閉じている(lat > 0)ので -lat 空間の y はすべて負。
      // SVG は y-down なので、より北 (= より小さい y) が画面上側に来る。
      expect(Math.max(...ys)).toBeLessThan(0);
      // CSS 反転が掛かっていたら二重反転で上下逆さになる(幾何だけでは検出不能)。
      // インライン style だけでなく **合成後** の値を見るので、knife.css 経由の
      // `.knife-preview { transform: scaleY(-1) }` も捕まる(レビュー指摘 #1)。
      expect(
        isVerticallyFlipped(geom.transform),
        `preview <svg> computed transform "${geom.transform}" flips y (二重反転)`,
      ).toBe(false);

      // --- 5. 目視用スクショ(片の形が出ていること / 北が上であること)。 ---
      await page.screenshot({ path: resolve(shotDir, 'knife-preview-north-modal.png') });
      await page
        .getByTestId('knife-inheritor-dialog')
        .screenshot({ path: resolve(shotDir, 'knife-preview-north-dialog.png') });
    } finally {
      await app.close();
    }
  });
});
