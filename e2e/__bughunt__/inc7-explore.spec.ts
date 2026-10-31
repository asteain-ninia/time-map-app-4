// 増分 7 の探索的バグ狩り（実装計画 §7 の末尾 / §0.3）。
//
// **実データのコピーでデーレ共和国の 60 州を実際に組み替える。** 掃くのは実装計画が
// 名指しした 5 つ:
//   ① 連邦化 → 解体 → 再度連邦化で階層が壊れないか
//   ② 直轄領が意図せず増えないか
//   ③ 削除の影響一覧が実際の結果と一致するか
//   ④ 一括編集が 1 回で戻るか（335 件でも形は同じ）
//   ⑤ 確定の 2.8 秒の間に二重クリックできてしまわないか
//
// **順番に意味がある。** ③（削除の影響）を先にやるのは、①でまとめ役を対象にすると
// **そのまとめ役が下位領域を全部失って自動消滅する**（FR-41）ためである ―― 先に組み替えて
// しまうと、消す相手がもう居ない。探索は「実際に起きること」を追う場所なので、順番の
// ほうを実物に合わせる。
//
// **`[異常]` が出たら落ちる形**（増分 2〜6 の作法）。探索なので途中で止めず、観察を
// 集めてから最後にまとめて判定する。
//
// ⚠️ 正準ファイルはアプリで直接開かない（教訓 5.48）。必ず一時コピーを開く。

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { test, expect, type Page } from '@playwright/test';

import { launchAppWithProject, leaveViewMode, openPropertySection, projectStats } from '../helpers';

const REAL_DATA_FILE = 'derle-world-full-2026-08-16.gimoza';
const dataDir =
  process.env['DERLE_TMAP_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'derle-import');
const canonicalPath = join(dataDir, REAL_DATA_FILE);

/** まとめ役の名前（実データで 60 州を束ねている側）。 */
const AGGREGATE_NAME = 'デーレ共和国';
/** 分け残しの既定名称の目印（`domain/promotion/direct-domain.ts` の唯一の規則）。 */
const DIRECT_DOMAIN_SUFFIX = '直轄領';
/** 組み替えに使う下位領域の件数（60 件全部を回すと 1 本の spec が長くなりすぎる）。 */
const SAMPLE_SIZE = 5;

interface Finding {
  readonly tag: string;
  readonly detail: string;
}

/** 一覧を平らにして名前で絞り込む（後始末はしない ―― 呼んだ側が続けて使う）。 */
async function filterList(page: Page, needle: string): Promise<void> {
  await page.getByTestId('sidebar-tab-list').click();
  await page.getByTestId('list-mode-current').click();
  await page.getByTestId('list-shape-flat').click();
  await page.getByTestId('unified-list-filter').fill(needle);
}

/**
 * **名前がちょうど一致する行**を選ぶ。返り値はその地物の id。
 *
 * **先頭の行では駄目である**（探索の 1 回目で踏んだ）。絞り込みは部分一致なので、
 * 「デーレ共和国」で絞ると **「デーレ共和国領海01」** のほうが先に来る ―― まとめ役を
 * 選んだつもりで末端を選び、そこから先の観察が全部ずれた。行の `title` は表示名
 * （同名があるときだけ見分けが付く）なので、ちょうど一致で拾う。
 */
function rowByExactName(page: Page, name: string) {
  return page
    .locator('[data-testid^="feature-list-item-"]')
    .filter({ has: page.locator('.ledger__name-text', { hasText: new RegExp(`^${name}$`) }) })
    .first();
}

/**
 * 絞り込んだうえで、**その行が窓に出るまで一覧をスクロールする**。
 *
 * 一覧は仮想スクロールなので、窓の外の行は DOM に居ない（教訓 5.59）。絞り込みで
 * 件数が減っても、部分一致で先に並ぶ行が多いと目当ての行は窓の外に居る ―― 探索の
 * 1 回目で「デーレ共和国」を探して **「デーレ共和国領海01」** を掴んだのはこれである。
 */
async function revealRowByExactName(page: Page, name: string): Promise<void> {
  await filterList(page, name);
  const row = rowByExactName(page, name);
  const scroller = page.getByTestId('ledger-scroller');
  await expect(scroller).toBeVisible();
  const max = await scroller.evaluate((el) => el.scrollHeight);
  for (let top = 0; top <= max; top += 140) {
    if ((await row.count()) > 0) return;
    await scroller.evaluate((el, t) => {
      el.scrollTop = t;
    }, top);
  }
  await expect(row).toBeVisible();
}

async function selectByName(page: Page, name: string): Promise<string> {
  await revealRowByExactName(page, name);
  const row = rowByExactName(page, name);
  await expect(row).toBeVisible();
  await row.click();
  const active = page.getByTestId('app-active-feature');
  await expect(active).toHaveText(/\S/);
  return ((await active.textContent()) ?? '').trim();
}

/** いま一覧に出ている件数（絞り込み中は一致数）。 */
async function listedCount(page: Page): Promise<number> {
  if ((await page.getByTestId('unified-list-empty').count()) > 0) return 0;
  if ((await page.getByTestId('unified-list-no-match').count()) > 0) return 0;
  const text = (await page.getByTestId('unified-list-count').textContent()) ?? '';
  const m = /^(?:(\d+)\s*\/\s*)?(\d+)件$/.exec(text.trim());
  if (m === null) throw new Error(`一覧の件数表示が読めない: ${JSON.stringify(text)}`);
  return Number(m[1] ?? m[2]);
}

/** 名前で絞り込んだときの件数（絞り込みは後始末する）。 */
async function countByName(page: Page, needle: string): Promise<number> {
  await filterList(page, needle);
  const n = await listedCount(page);
  await page.getByTestId('unified-list-filter').fill('');
  return n;
}

/**
 * **まとめ役の全下位領域に印を付ける**（右クリックの「その全下位領域を対象にする」。
 * FR-48 後半 / 増分 7 の中身 3）。
 *
 * **一覧の升目を 60 回押す形にはしない。** 一覧は仮想スクロールなので、窓に入っていない
 * 行の升目は DOM に居ない ―― id で押しにいくと「見つからない」で止まる（教訓 5.59 の
 * 別の顔）。まとめ役 1 行から広げるほうが、実際の導線とも一致する。
 */
async function markSubtreeOf(
  page: Page,
  aggregateName: string,
): Promise<{ count: number; itemKinds: string[] }> {
  await revealRowByExactName(page, aggregateName);
  const row = rowByExactName(page, aggregateName);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  // **出た項目を控えてから押す。** 出ていなければ探索の記録として残す（黙って落ちない）。
  const itemKinds = (
    await page.locator('[data-item-kind]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-item-kind') ?? ''),
    )
  ).filter((k) => k !== '');
  const item = page.locator('[data-item-kind="markSubtree"]');
  if ((await item.count()) === 0) {
    await page.keyboard.press('Escape');
    await page.getByTestId('unified-list-filter').fill('');
    return { count: Number.NaN, itemKinds };
  }
  await item.click();
  await page.getByTestId('unified-list-filter').fill('');
  const label = (await page.getByTestId('ledger-marked-count').textContent()) ?? '';
  return { count: Number(/対象 (\d+) 件/.exec(label)?.[1] ?? Number.NaN), itemKinds };
}

/**
 * 一覧を `needle` で絞り込み、**窓に出ている先頭 n 行**に印を付ける。返り値はその id。
 * 仮想スクロールなので「窓に出ている」ぶんだけを相手にする。
 */
async function markFirstN(page: Page, needle: string, n: number): Promise<string[]> {
  await filterList(page, needle);
  const boxes = page.locator('[data-testid^="ledger-mark-"]');
  await expect(boxes.first()).toBeVisible();
  const take = Math.min(await boxes.count(), n);
  const ids: string[] = [];
  for (let i = 0; i < take; i += 1) {
    const box = boxes.nth(i);
    const id = ((await box.getAttribute('data-testid')) ?? '').replace('ledger-mark-', '');
    await box.check();
    if (id !== '') ids.push(id);
  }
  await page.getByTestId('unified-list-filter').fill('');
  return ids;
}

/** 所属変更の道具を構える（押されたままなら一度外す）。 */
async function armReparent(page: Page): Promise<void> {
  const tool = page.getByTestId('tool-edit.reparent');
  if ((await tool.getAttribute('aria-pressed')) === 'true') await tool.click();
  await tool.click();
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
}

test.describe('増分 7 の探索 — 実データのコピーで 60 州を組み替える', () => {
  test.skip(
    !existsSync(canonicalPath),
    `実データが無い (${canonicalPath})。DERLE_TMAP_DIR で置き場を指定する`,
  );

  test('削除の影響・連邦化 → 解体 → 再度連邦化・直轄領の増え方・一括編集の取り消し', async () => {
    test.setTimeout(600_000);
    const workDir = mkdtempSync(join(tmpdir(), 'tmap-e2e-inc7-'));
    const workingCopy = join(workDir, REAL_DATA_FILE);
    copyFileSync(canonicalPath, workingCopy);
    const before = statSync(canonicalPath);

    const { app, page } = await launchAppWithProject(workingCopy);
    const findings: Finding[] = [];
    try {
      await leaveViewMode(page);
      const base = await projectStats(page);

      // --- ③ 削除の影響一覧が実際の結果と一致するか ------------------------
      //
      // **先にやる**（見出しの注記）。まとめ役を消すと 60 州は「すべての年で最上位へ
      // 移る」はずである（裁定 §N-3）。板が言った件数と、消したあとの実際の数を突き合わせる。
      await selectByName(page, AGGREGATE_NAME);
      await page.getByTestId('unified-list-filter').fill('');
      await page.getByTestId('sidebar-tab-properties').click();
      await openPropertySection(page, 'danger-zone');
      await page.getByTestId('delete-feature').getByRole('button').click();
      const impact = page.getByTestId('delete-impact');
      await expect(impact).toBeVisible();

      let promised = Number.NaN;
      if ((await page.getByTestId('delete-impact-referenced').count()) === 0) {
        findings.push({
          tag: '[異常] まとめ役を消す板に「他から参照されているところ」が出ない',
          detail: (await impact.textContent()) ?? '',
        });
      } else {
        const referenced =
          (await page.getByTestId('delete-impact-referenced').textContent()) ?? '';
        promised = Number(/下位領域 (\d+) 件/.exec(referenced)?.[1] ?? Number.NaN);
        if (!Number.isFinite(promised)) {
          findings.push({
            tag: '[異常] 影響の一覧に「下位領域 n 件」が出ない',
            detail: referenced,
          });
        }
      }

      await page.getByTestId('delete-impact-confirm').click();
      await expect(impact).toHaveCount(0, { timeout: 120_000 });
      const afterDelete = await projectStats(page);
      // 消えるのは対象 1 件だけ（下位領域は最上位へ移るので消えない）。
      const removed = base.featureCount - afterDelete.featureCount;
      if (removed !== 1) {
        findings.push({
          tag: '[観察] まとめ役を消したときに消えた地物が 1 件ではない',
          detail:
            `${String(removed)} 件（板は「下位領域 ${String(promised)} 件が最上位へ移る」と言っていた）`,
        });
      }
      // 取り消しは 1 手で戻る。
      await page.getByTestId('sidebar-tab-list').click();
      await page.getByTestId('ledger-scroller').click();
      await page.keyboard.press('Control+z');
      const afterUndo = await projectStats(page);
      if (afterUndo.featureCount !== base.featureCount) {
        findings.push({
          tag: '[異常] 削除の取り消しが 1 手で戻らない',
          detail: `${String(base.featureCount)} → ${String(afterDelete.featureCount)} → ${String(afterUndo.featureCount)}`,
        });
      }

      // --- ① 連邦化 → 解体 → 再度連邦化 -------------------------------------
      //
      // **60 州をまとめて動かす。** 印は右クリックの「その全下位領域を対象にする」で
      // 1 手で付ける（FR-48 後半）。
      const statsBeforeLoop = await projectStats(page);
      const subtree = await markSubtreeOf(page, AGGREGATE_NAME);
      let markedCount = subtree.count;
      if (!Number.isFinite(markedCount) || markedCount < 2) {
        findings.push({
          tag: '[観察] まとめ役の行の右クリックに「その全下位領域を対象にする」が出ない',
          detail: `出ていた項目: ${subtree.itemKinds.join(', ')}`,
        });
        // 探索は止めない ―― 窓に出ている行へ印を付けて先へ進む。
        markedCount = (await markFirstN(page, '州', SAMPLE_SIZE)).length;
      }
      await armReparent(page);
      await page.getByTestId('reparent-confirm').click();
      const dialog = page.getByTestId('reparent-options-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('reparent-parent-create').check();
      await page.getByTestId('reparent-parent-create-name').fill('探索用の連邦');
      // **予告は枝を選んでから読む** ―― 「既存から選ぶ」枝で相手を選ぶ前は、件数の行は
      // 出ない（行き先が決まっていないので「n 件を◯◯の下に入れます」と書けない）。
      const previewText = (await page.getByTestId('reparent-preview').textContent()) ?? '';
      if (!previewText.includes(`${String(markedCount)} 件`)) {
        findings.push({
          tag: '[異常] 予告文に対象の件数が出ない',
          detail: `対象 ${String(markedCount)} 件 / 予告: ${previewText}`,
        });
      }

      // --- ⑤ 確定の間に二重クリックできてしまわないか ------------------------
      const confirmBtn = page.getByTestId('reparent-options-confirm');
      await confirmBtn.click();
      if ((await page.getByTestId('reparent-commit-progress').count()) > 0) {
        // 進行表示を読んだ直後に確定が終わると板ごと消えるので、待たずに読む（消えていれば二重適用の余地は無い）
        if (await confirmBtn.isEnabled({ timeout: 500 }).catch(() => false)) {
          findings.push({
            tag: '[異常] 確定中なのに確定ボタンがまだ押せる（二重に適用されうる）',
            detail: '進行表示は出ているが disabled になっていない',
          });
        }
      }
      await expect(dialog).toHaveCount(0, { timeout: 120_000 });

      const afterFederate = await projectStats(page);
      // 新しい上位領域が **1 つだけ**増える（対象 1 件ごとに作られていない）。ただし
      // **下位を全部失ったまとめ役は自動で消える**（FR-41）ので、差し引き 0 になりうる。
      const federateDelta = afterFederate.featureCount - statsBeforeLoop.featureCount;
      if (federateDelta !== 1 && federateDelta !== 0) {
        findings.push({
          tag: '[異常] 連邦化で増減した地物が「+1（新しい上位領域）」か「0（元のまとめ役が自動消滅）」のどちらでもない',
          detail: `${String(statsBeforeLoop.featureCount)} → ${String(afterFederate.featureCount)}`,
        });
      }
      if (federateDelta === 0) {
        findings.push({
          tag: '[観察] 全下位領域を移したので、元のまとめ役が自動で消えた（FR-41 のとおり）',
          detail: `${AGGREGATE_NAME} は残っていない`,
        });
      }
      // --- ② 直轄領が意図せず増えないか ------------------------------------
      //
      // 新しい上位領域は **形を持たない集約**なので、分け残しは 1 つも生まれない。
      const ddAfterFederate = await countByName(page, DIRECT_DOMAIN_SUFFIX);
      if (ddAfterFederate !== 0) {
        findings.push({
          tag: '[異常] まとめ役を親にしたのに分け残しが生まれた',
          detail: `${String(ddAfterFederate)} 件`,
        });
      }

      // 解体（最上位へ戻す）。印は確定で外れているので、**新しい連邦の側から**付け直す。
      const dismantle = await markSubtreeOf(page, '探索用の連邦');
      if (!Number.isFinite(dismantle.count) || dismantle.count !== markedCount) {
        findings.push({
          tag: '[観察] 連邦の下位領域の数が、移した数と一致しない',
          detail: `移した ${String(markedCount)} 件 / いま ${String(dismantle.count)} 件（項目: ${dismantle.itemKinds.join(', ')}）`,
        });
        if (!Number.isFinite(dismantle.count)) await markFirstN(page, '州', SAMPLE_SIZE);
      }
      await armReparent(page);
      await page.getByTestId('reparent-confirm-none').click();
      await expect(dialog).toBeVisible();
      await page.getByTestId('reparent-options-confirm').click();
      await expect(dialog).toHaveCount(0, { timeout: 120_000 });

      const afterDismantle = await projectStats(page);
      // 下位を全部失った「探索用の連邦」は自動で消える（FR-41 / FR-35）。
      const federationLeft = await countByName(page, '探索用の連邦');
      if (federationLeft !== 0) {
        findings.push({
          tag: '[観察] 下位を全部失った新しい上位領域が残っている',
          detail: `${String(federationLeft)} 件（自動消滅の期待と食い違う）`,
        });
      }
      if (afterDismantle.featureCount !== statsBeforeLoop.featureCount) {
        findings.push({
          tag: '[観察] 連邦化 → 解体で地物の数が元に戻らない',
          detail: `${String(statsBeforeLoop.featureCount)} → ${String(afterDismantle.featureCount)}`,
        });
      }

      // 再度連邦化（階層が壊れていなければ、同じ手順がもう一度通る）。いまは全部が
      // 最上位に居るので、**一覧の窓に出ている先頭 n 行**へ印を付けて動かす。
      const sample = await markFirstN(page, '州', SAMPLE_SIZE);
      if (sample.length === 0) {
        findings.push({
          tag: '[異常] 2 回目の連邦化に使う地物が 1 件も選べない',
          detail: '一覧の窓に「州」を含む行が出ていない',
        });
      }
      await armReparent(page);
      await page.getByTestId('reparent-confirm').click();
      await expect(dialog).toBeVisible();
      await page.getByTestId('reparent-parent-create').check();
      await page.getByTestId('reparent-parent-create-name').fill('探索用の連邦（2 回目）');
      await page.getByTestId('reparent-options-confirm').click();
      await expect(dialog).toHaveCount(0, { timeout: 120_000 });

      const afterRefederate = await projectStats(page);
      if (afterRefederate.featureCount !== afterDismantle.featureCount + 1) {
        findings.push({
          tag: '[異常] 2 回目の連邦化で増えた地物が 1 件ではない（階層が壊れている疑い）',
          detail: `${String(afterDismantle.featureCount)} → ${String(afterRefederate.featureCount)}`,
        });
      }
      const ddAfterRefederate = await countByName(page, DIRECT_DOMAIN_SUFFIX);
      if (ddAfterRefederate !== 0) {
        findings.push({
          tag: '[異常] 2 回目の連邦化で分け残しが生まれた',
          detail: `${String(ddAfterRefederate)} 件`,
        });
      }

      // --- ④ 一括編集が 1 回で戻るか ----------------------------------------
      const bulk = await markFirstN(page, '州', SAMPLE_SIZE);
      await filterList(page, '州');
      await page.getByTestId(`feature-list-item-${bulk[0] ?? ''}`).click({ button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      await page.locator('[data-item-kind="bulkKindLabel"]').click();
      await page.getByTestId('bulk-kind-input').fill('探索用の種別');
      await page.getByTestId('bulk-kind-confirm').click();
      await expect(page.getByTestId('bulk-kind-dialog')).toHaveCount(0, { timeout: 120_000 });

      const withKind = await countByName(page, '探索用の種別');
      if (withKind === 0) {
        findings.push({
          tag: '[異常] まとめて種別を付けたのに、絞り込みで 1 件も出ない',
          detail: `対象 ${String(bulk.length)} 件`,
        });
      }
      // **取り消しが本当に走ったかを観測してから中身を見る。** 「戻らない」には
      // 「打鍵が届いていない」と「戻す処理が足りない」の 2 通りがあり、件数だけ見ても
      // どちらか分からない（教訓 5.46: A が効かない原因は A の実装とは限らない）。
      //
      // **先に道具を「選ぶ」へ戻す。** 所属変更の道具を構えたまま印が付いていると、
      // 鍵盤の持ち主は `tool-drawing` になり、**Ctrl+Z は道具の側へ降りる**
      // （設計書 §D.4.1 の表）。所属変更には打った点が無いので、そこでの Ctrl+Z は
      // 何も起こさない ―― 探索で実際に踏んだ（§下の観察）。
      await page.getByTestId('tool-edit.select').click();
      await page.getByTestId('ledger-scroller').click();
      const undoBefore = (await page.getByTestId('app-can-undo').textContent()) ?? '';
      await page.keyboard.press('Control+z');
      const redoAfter = (await page.getByTestId('app-can-redo').textContent()) ?? '';
      const afterUndoKind = await countByName(page, '探索用の種別');
      if (afterUndoKind !== 0) {
        findings.push({
          tag: '[異常] 一括の種別付けが Ctrl+Z 1 回で戻らない',
          detail:
            `${String(withKind)} 件 → 取り消し後 ${String(afterUndoKind)} 件` +
            `（取り消せる: ${undoBefore} → やり直せる: ${redoAfter}）`,
        });
      }
    } finally {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    }

    // 正準ファイルは 1 バイトも動いていない（教訓 5.48）。
    const after = statSync(canonicalPath);
    expect(after.size, '正準ファイルの大きさ').toBe(before.size);
    expect(after.mtimeMs, '正準ファイルの更新時刻').toBe(before.mtimeMs);

    const abnormal = findings.filter((f) => f.tag.startsWith('[異常]'));
    expect(
      abnormal,
      `探索で見つかった異常:\n${findings.map((f) => `${f.tag}: ${f.detail}`).join('\n')}`,
    ).toEqual([]);
  });
});
