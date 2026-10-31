// 画面の文言の巡回（案/文言総点検-やり方の提案.md §2.3 / §6 の 4）。
//
// **毎回の検査ではない。** playwright の project `tour` だけが走らせる（`npm run e2e:tour`。
// `main` と `explore` からは外してある）。文言の総点検で「どの場面にどの文が出るか」を集める道具で、
// 画面の文が変わっても赤くならない ―― 場面を作れなかったときも止めずに記録し、最後に
// 作れた場面の数だけを確かめる（探索の作法: 観察を集めてから最後にまとめて判定する）。
//
// 各場面で書き出すもの（`UI_TEXT_TOUR_OUT`。既定はリポジトリの外の OS の一時ディレクトリ）:
//   - `scenes/<番号>-<名前>.png` … 画面の写真
//   - `scenes/<番号>-<名前>.json` … 画面に見えている文字（`document.body.innerText`）と、
//     表示されている要素の `aria-label` / `title` / `placeholder` / `alt` の値、ウィンドウのタイトル
//   - `scenes/<番号>-<名前>.json` の `controls` / `headings` … 見えている操作部品と見出しの実寸・計算済みの
//     スタイル（見た目の点検用。`UI_TEXT_TOUR_SIZE=800x600` で窓の大きさを変えて撮れる）
//   - `user-words.json` … 巡回が入れた利用者のデータの語（合成データの名前など。突き合わせで取り除く）
// 突き合わせは `npm run ui-text:tour-match`（`scripts/ui-text-tour-match-cli.ts`）。
//
// **巡回で写せないもの**: OS のダイアログ（応答なしの確認）、ホバーしないと出ない吹き出し（1 場面だけ
// ホバーして撮る）、地図に描く文字（キャンバス）。突き合わせの側で「写せない所」として分けて数える。
//
// 実データは本体の `derle-import/` の複写を `DERLE_TMAP_DIR` で渡す。⚠️ 正準ファイルはアプリで
// 直接開かない（教訓 5.48）。ここでもさらに一時ディレクトリへ複写してから開く。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  addInputLayerBox,
  armAddAreaTool,
  commitOneFace,
  dismissFirstRunGuide,
  drawFace,
  enterEditMode,
  jumpToYear,
  launchApp,
  launchAppWithProject,
  leaveViewMode,
  loadProject,
  openDepthOptions,
  openPreSaveBoard,
  openVertexCandidatesOnTinySquare,
  readControlMetrics,
  controlProblems,
  type ControlMetrics,
  type LaunchedApp,
  type ScreenPoint,
} from '../helpers';

const OUT = resolve(process.env['UI_TEXT_TOUR_OUT'] ?? join(tmpdir(), 'gimoza-ui-text-tour'));
const SCENE_DIR = join(OUT, 'scenes');
const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** 巡回で作れた場面がこれより少なければ失敗にする（提案書 §2.3 は 30〜40 場面）。 */
const MIN_SCENES = 30;

/** 巡回が入れる利用者のデータの語（突き合わせで取り除く）。 */
const USER_WORDS: string[] = ['巡回の横長', '巡回の縦長'];
for (let i = 0; i < 60; i += 1) USER_WORDS.push(`合成地物${String(i).padStart(4, '0')}`);
for (let i = 1; i <= 40; i += 1) USER_WORDS.push(`合成州 ${String(i).padStart(2, '0')}`);
USER_WORDS.push('合成の州', '合成の国', '合成の連邦', '合成の外の国', '合成のまとめ役', '合成の錨だらけ');

/** `UI_TEXT_TOUR_SIZE=幅x高さ` で窓を変える（見た目の点検で最小の窓を撮る）。無ければ既定の窓のまま。 */
const TOUR_SIZE = ((): { width: number; height: number } | null => {
  const m = /^(\d+)x(\d+)$/.exec(process.env['UI_TEXT_TOUR_SIZE'] ?? '');
  return m === null ? null : { width: Number(m[1]), height: Number(m[2]) };
})();

/**
 * 窓の大きさを、地図の座標を取る前に決めて起動する。起動のあとで面を描いてから窓を縮めると、描いたときの
 * 座標が地図の外になって、右クリックが地図へ届かない（C01・C04 が 800×600 で作れなかった原因）。
 */
async function launchSized(open: () => Promise<LaunchedApp>): Promise<LaunchedApp> {
  const launched = await open();
  if (TOUR_SIZE !== null) await launched.page.setViewportSize(TOUR_SIZE);
  return launched;
}

interface Capture {
  readonly pageTitle: string;
  readonly innerText: string;
  readonly attributes: { attr: string; value: string; tag: string; testid: string | null }[];
}

/** 画面に見えている文字と、表示されている要素の属性の値を集める。 */
async function captureText(page: Page): Promise<Capture> {
  return page.evaluate(() => {
    const attributes: { attr: string; value: string; tag: string; testid: string | null }[] = [];
    for (const el of Array.from(document.querySelectorAll('[aria-label],[title],[placeholder],[alt]'))) {
      // 表示されていない要素（display:none の中など）は画面に出ていない
      if (el.getClientRects().length === 0) continue;
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = el.getAttribute(attr);
        if (value !== null && value.trim() !== '') {
          attributes.push({ attr, value, tag: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid') });
        }
      }
    }
    return { pageTitle: document.title, innerText: document.body.innerText, attributes };
  });
}

let sceneCount = 0;

/**
 * 1 場面を作って撮る。作れなかったら記録して先へ進む（止めない）。
 * `cleanup` は撮ったあと・失敗したあとのどちらでも走る（板を閉じて次の場面へ持ち越さない）。
 */
async function scene(
  page: Page,
  id: string,
  title: string,
  setup: () => Promise<void>,
  cleanup: () => Promise<void> = () => closeOverlays(page),
): Promise<void> {
  const base = join(SCENE_DIR, id);
  try {
    await setup();
    await page.waitForTimeout(200);
    const captured = await captureText(page);
    const metrics = await readControlMetrics(page);
    await page.screenshot({ path: `${base}.png` });
    writeFileSync(`${base}.json`, `${JSON.stringify({ id, title, ok: true, ...captured, ...metrics }, null, 1)}\n`);
    sceneCount += 1;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    writeFileSync(`${base}.json`, `${JSON.stringify({ id, title, ok: false, error: message }, null, 1)}\n`);
  } finally {
    await cleanup().catch(() => undefined);
  }
}

/** 開いている板・メニュー・ポップオーバーを閉じる（Escape を 2 回。何も無ければ何も起きない）。 */
async function closeOverlays(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

/** 狭い窓で「≫」へ畳まれた部品を、開いてから押せるようにする。畳まれていなければ何もしない。 */
async function unfoldIfNeeded(page: Page, testid: string, overflowTestid: string): Promise<void> {
  if (await page.getByTestId(testid).isVisible()) return;
  await page.getByTestId(overflowTestid).click();
  await expect(page.getByTestId(testid)).toBeVisible();
}

async function openMenuCommand(page: Page, menu: string, commandId: string): Promise<void> {
  await page.getByTestId(`menu-${menu}`).click();
  const item = page.getByTestId(`menu-items-${menu}`).locator(`[data-command="${commandId}"]`);
  await expect(item).toBeEnabled();
  await item.click();
}

/** 実データを一時ディレクトリへ複写する（開いたファイルの隣に世代が書かれるため）。 */
function copyRealData(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tmap-tour-'));
  const path = join(dir, REAL_DATA_FILE);
  copyFileSync(canonicalPath, path);
  return { dir, path };
}

test.describe('画面の文言の巡回（project: tour）', () => {
  test.beforeAll(() => {
    rmSync(SCENE_DIR, { recursive: true, force: true });
    mkdirSync(SCENE_DIR, { recursive: true });
    writeFileSync(join(OUT, 'user-words.json'), `${JSON.stringify(USER_WORDS, null, 1)}\n`);
  });

  test('A. 起動直後・メニュー・設定・ヘルプ・道具', async () => {
    const { app, page } = await launchSized(() => launchApp({ keepFirstRunGuide: true }));
    try {
      await scene(page, 'A01-first-run-guide', '初回起動のガイド', async () => {
        await expect(page.getByTestId('first-run-guide')).toBeVisible();
      }, async () => dismissFirstRunGuide(page));
      await scene(page, 'A02-empty', '空の画面（読むだけ）', async () => {
        await expect(page.getByTestId('app-shell')).toBeVisible();
      });
      const menus = await page
        .getByTestId('menubar')
        .locator('[data-testid^="menu-"]:not([data-testid^="menu-items-"])')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
      let n = 3;
      for (const testid of menus) {
        const menu = testid.replace(/^menu-/, '');
        await scene(page, `A${String(n).padStart(2, '0')}-menu-${menu}`, `メニュー「${menu}」を開いた`, async () => {
          await page.getByTestId(testid).click();
          await expect(page.getByTestId(`menu-items-${menu}`)).toBeVisible();
        });
        n += 1;
      }
      await scene(page, 'A10-settings-project', '設定（プロジェクト）', async () => {
        await openMenuCommand(page, 'tools', 'tools.settings');
        await expect(page.getByTestId('settings-dialog')).toBeVisible();
        await page.getByTestId('settings-tab-project').click();
      }, async () => undefined);
      await scene(page, 'A11-settings-app', '設定（アプリ）', async () => {
        await page.getByTestId('settings-tab-app').click();
        await expect(page.getByTestId('settings-app')).toBeVisible();
      }, async () => undefined);
      await scene(page, 'A12-settings-backup', '設定（保存とバックアップ）', async () => {
        await page.getByTestId('settings-tab-backup').click();
      }, async () => {
        await page.getByTestId('settings-cancel').click();
      });
      await scene(page, 'A13-about', 'バージョン情報', async () => {
        await openMenuCommand(page, 'help', 'help.about');
        await expect(page.getByTestId('about-panel-version')).toBeVisible();
      });
      await scene(page, 'A14-shortcuts', 'ショートカット一覧', async () => {
        await openMenuCommand(page, 'help', 'help.shortcuts');
        await expect(page.getByTestId('shortcuts-panel-row').first()).toBeVisible();
      });
      await scene(page, 'A15-diagnostics', '診断情報', async () => {
        await openMenuCommand(page, 'help', 'help.diagnostics');
        await expect(page.getByTestId('diagnostics-unsaved')).toBeVisible();
      });
      await scene(page, 'A16-jump', 'どこへでも移動', async () => {
        await openMenuCommand(page, 'tools', 'tools.jump');
        await expect(page.getByTestId('jump-palette')).toBeVisible();
      });
      await leaveViewMode(page);
      await scene(page, 'A17-tooltip', '道具の吹き出し（所属を変える）', async () => {
        await page.getByTestId('tool-edit.reparent').hover();
        // 吹き出しは道具ごとに DOM に居て、hidden で隠れている。いま出ている 1 つだけを見る
        await expect(page.locator('[data-testid="tooltip-bubble"]:not([hidden])')).toBeVisible();
      }, async () => {
        await page.mouse.move(1, 1);
      });
      await scene(page, 'A18-unlocked', '直せる（鍵を開けた・何も選んでいない）', async () => {
        await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'false');
      });
      for (const [i, tool, label] of [
        [19, 'add.area', '面を描く'],
        [20, 'add.line', '線を描く'],
        [21, 'add.point', '点を描く'],
      ] as const) {
        await scene(page, `A${i}-tool-${tool}`, `道具「${label}」を構えた`, async () => {
          await page.getByTestId(`tool-${tool}`).click();
          await expect(page.getByTestId(`tool-${tool}`)).toHaveAttribute('aria-pressed', 'true');
        }, async () => undefined);
      }
      await scene(page, 'A22-snap-options', '面を描く道具の吸着 ▾', async () => {
        await page.getByTestId('tool-add.area').click();
        await page.getByTestId('option-snap-button').click();
      });
      await page.getByTestId('tool-edit.select').click();
      await scene(page, 'A23-survey', '測量を始めた', async () => {
        await page.getByTestId('survey-toggle').click();
        await expect(page.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');
      }, async () => undefined);
      await scene(page, 'A24-survey-coords', '測量の座標 ▾', async () => {
        await unfoldIfNeeded(page, 'survey-coords-button', 'option-bar-overflow');
        await page.getByTestId('survey-coords-button').click();
      }, async () => {
        await closeOverlays(page);
        // Escape が測量まで降ろしたときに、押して測量へ戻してしまわない
        const toggle = page.getByTestId('survey-toggle');
        if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
      });
      await scene(page, 'A25-display', '表示 ▾', async () => {
        await unfoldIfNeeded(page, 'option-display-button', 'option-bar-overflow');
        await page.getByTestId('option-display-button').click();
      });
      await scene(page, 'A26-depth', '深さ ▾', async () => {
        await unfoldIfNeeded(page, 'option-depth-button', 'option-bar-overflow');
        await openDepthOptions(page);
      });
      await scene(page, 'A27-rail-ymd', '時刻レールの月日 ▾', async () => {
        await unfoldIfNeeded(page, 'rail-ymd-button', 'rail-overflow-button');
        await page.getByTestId('rail-ymd-button').click();
        await expect(page.getByTestId('rail-ymd-panel')).toBeVisible();
      });
    } finally {
      await app.close();
    }
  });

  test('B. 実データ（デーレ界）を開いて選ぶ・道具を構える', async () => {
    test.skip(!existsSync(canonicalPath), `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`);
    const copy = copyRealData();
    const { app, page } = await launchSized(() => launchAppWithProject(copy.path));
    try {
      await scene(page, 'B01-opened', '実データを開いた直後（読むだけ）', async () => {
        await expect(page.getByTestId('app-identity-file')).toHaveText(REAL_DATA_FILE);
      });
      await scene(page, 'B02-list', '地物一覧', async () => {
        await page.getByTestId('sidebar-tab-list').click();
        await expect(page.locator('[data-testid^="feature-list-item-"]').first()).toBeVisible();
      }, async () => undefined);
      await scene(page, 'B03-selected', '地物を選んだ（素性欄）', async () => {
        await page.locator('[data-testid^="feature-list-item-"]').first().click();
        await expect(page.getByTestId('app-active-feature')).toHaveText(/\S/);
        await page.getByTestId('sidebar-tab-properties').click();
      }, async () => undefined);
      await scene(page, 'B04-detail', '詳細の板', async () => {
        await page.getByTestId('open-detail-button').click();
        await expect(page.locator('[data-testid^="detail-panel-"]').first()).toBeVisible();
      });
      await leaveViewMode(page);
      await scene(page, 'B05-unlocked-selected', '直せる・地物を選んでいる（素性欄）', async () => {
        await expect(page.getByTestId('mode-view')).toHaveAttribute('aria-pressed', 'false');
      }, async () => undefined);
      await scene(page, 'B06-list-filtered', '地物一覧を平らにして名前で絞り込んだ', async () => {
        await page.getByTestId('sidebar-tab-list').click();
        await page.getByTestId('list-mode-current').click();
        await page.getByTestId('list-shape-flat').click();
        await page.getByTestId('unified-list-filter').fill('デーレ');
        await expect(page.getByTestId('unified-list-count')).toBeVisible();
      }, async () => {
        await page.getByTestId('unified-list-filter').fill('');
        await page.getByTestId('sidebar-tab-properties').click();
      });
      for (const [i, tool, label] of [
        [7, 'edit.reparent', '所属を変える'],
        [8, 'edit.merge', '結合'],
        [9, 'edit.knife', '分ける'],
        [10, 'edit.drill', '穴あけ'],
        [11, 'edit.ring', '輪郭'],
        [12, 'edit.vertex', '頂点'],
        [13, 'edit.move', '動かす'],
      ] as const) {
        await scene(page, `B${String(i).padStart(2, '0')}-tool-${tool}`, `選んだまま道具「${label}」を構えた`, async () => {
          await page.getByTestId(`tool-${tool}`).click();
          await expect(page.getByTestId(`tool-${tool}`)).toHaveAttribute('aria-pressed', 'true');
        }, async () => {
          await closeOverlays(page);
          await page.getByTestId('tool-edit.select').click();
        });
      }
      await scene(page, 'B15-rail-context-menu', '時刻レールの右クリック', async () => {
        await page.getByTestId('rail-lane').click({ button: 'right' });
        await expect(page.getByTestId('context-menu').or(page.locator('[role="menu"]')).first()).toBeVisible();
      });
      await scene(page, 'B16-rail-overflow', '時刻レールの ≫', async () => {
        await page.getByTestId('rail-overflow-button').click();
      });
      await scene(page, 'B17-backups', '以前の保存から開く', async () => {
        await openMenuCommand(page, 'file', 'file.openBackup');
        await expect(page.getByTestId('backup-dialog')).toBeVisible();
      });
    } finally {
      await app.close();
      rmSync(copy.dir, { recursive: true, force: true });
    }
  });

  test('C. 合成データの面: 右クリック・未保存の確認', async () => {
    const { app, page } = await launchSized(() => launchApp());
    try {
      const { cx, cy } = await commitOneFace(page);
      await enterEditMode(page);
      await scene(page, 'C01-map-context-menu', '地図の右クリック（面の上）', async () => {
        await page.mouse.click(cx, cy, { button: 'right' });
        await expect(page.getByTestId('context-menu')).toBeVisible();
      });
      // 削除の影響の板は右クリックの「全部の年から消す」から出す（実データの素性欄からは、選んだ
      // 地物によって削除のボタンが窓の外や無効になり、場面が安定しなかった）
      await scene(page, 'C04-delete-impact', '削除の確認の板（右クリックから）', async () => {
        await page.mouse.click(cx, cy, { button: 'right' });
        await page.getByTestId('context-menu').locator('[data-item-kind="delete"]').click();
        await expect(page.getByTestId('delete-impact').or(page.getByTestId('delete-confirm')).first()).toBeVisible();
      });
      await scene(page, 'C02-status-after-add', '面を足した直後（状態行の知らせ）', async () => {
        await expect(page.getByTestId('app-shell')).toBeVisible();
      });
      await scene(page, 'C03-unsaved', '未保存の確認（新規を押した）', async () => {
        await openMenuCommand(page, 'file', 'file.new');
        await expect(page.getByTestId('unsaved-body')).toBeVisible();
      }, async () => {
        await page.getByTestId('unsaved-cancel').click();
      });
    } finally {
      await app.close();
    }
  });

  test('D. 頂点の候補の一覧', async () => {
    const { app, page } = await launchSized(() => launchApp());
    try {
      await scene(page, 'D01-vertex-candidates', '頂点の候補の一覧', async () => {
        await openVertexCandidatesOnTinySquare(page);
      });
    } finally {
      await app.close();
    }
  });

  test('E. 保存の前の確認の板', async () => {
    const { app, page } = await launchSized(() => launchApp());
    try {
      await scene(page, 'E01-pre-save', '保存の前の確認の板', async () => {
        await openPreSaveBoard(page);
      });
    } finally {
      await app.close();
    }
  });

  test('F. 重なりの解決', async () => {
    const { app, page } = await launchSized(() => launchApp());
    try {
      await scene(page, 'F01-conflict', '重なりの解決の板', async () => {
        const rect = (cx: number, cy: number, hw: number, hh: number): readonly ScreenPoint[] => [
          [cx - hw, cy - hh],
          [cx + hw, cy - hh],
          [cx + hw, cy + hh],
          [cx - hw, cy + hh],
        ];
        await jumpToYear(page, 1200);
        await armAddAreaTool(page);
        const b = await addInputLayerBox(page);
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        await drawFace(page, rect(cx, cy, 150, 40), { name: '巡回の横長' });
        await armAddAreaTool(page);
        await drawFace(page, rect(cx, cy, 40, 140), { name: '巡回の縦長', waitForSelection: false });
        await expect(page.getByTestId('conflict-dialog')).toBeVisible();
      }, async () => undefined);
    } finally {
      await app.close();
    }
  });

  test('G. 読み込みの修復の板', async () => {
    test.skip(!existsSync(canonicalPath), `実データが無い (${canonicalPath})`);
    const copy = copyRealData();
    const broken = join(copy.dir, 'broken.gimoza');
    // 同じ地物の歴史を 2 本にした（形式は正しいが中身が矛盾する）ファイル。inc8d-recovery と同じ作り方。
    const entries = unzipSync(readFileSync(copy.path));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as { histories: unknown[] };
    manifest.histories.push(manifest.histories[0]);
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(broken, zipSync(entries));
    const { app, page } = await launchSized(() => launchApp());
    try {
      await scene(page, 'G01-repair', '読み込みの修復の板', async () => {
        void loadProject(page, broken).catch(() => undefined);
        await expect(page.getByTestId('repair-dialog')).toBeVisible({ timeout: 60_000 });
      }, async () => undefined);
    } finally {
      await app.close();
      rmSync(copy.dir, { recursive: true, force: true });
    }
  });

  test('作れた場面の数', () => {
    const files = readdirSync(SCENE_DIR).filter((n) => n.endsWith('.json'));
    // eslint-disable-next-line no-restricted-syntax -- この巡回が書き出した JSON を読む。ソースや CSS ではなく、改行に左右されない
    const ok = files.filter((n) => (JSON.parse(readFileSync(join(SCENE_DIR, n), 'utf8')) as { ok: boolean }).ok);
    writeFileSync(
      join(OUT, 'summary.json'),
      `${JSON.stringify({ scenes: files.length, ok: ok.length, sceneCountInThisRun: sceneCount }, null, 1)}\n`,
    );
    expect(ok.length, `作れた場面 ${ok.length} / ${files.length}`).toBeGreaterThanOrEqual(MIN_SCENES);
  });

  test('全部の場面の操作部品が見た目の決まりに沿う', () => {
    const problems = new Set<string>();
    for (const name of readdirSync(SCENE_DIR).filter((n) => n.endsWith('.json'))) {
      // eslint-disable-next-line no-restricted-syntax -- この巡回が書き出した JSON を読む。ソースや CSS ではなく、改行に左右されない
      const scene = JSON.parse(readFileSync(join(SCENE_DIR, name), 'utf8')) as {
        id: string;
        controls?: ControlMetrics[];
      };
      for (const problem of controlProblems(scene.controls ?? [])) problems.add(`${scene.id} ${problem}`);
    }
    expect([...problems]).toEqual([]);
  });
});
