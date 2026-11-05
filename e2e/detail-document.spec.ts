// fr98 回帰ロック — 作業メモの編集UI behavioural E2E.
//
// THE POINT (FR-98 / 教訓 5.7): the sidebar PropertyPanel carries the 作業メモ
// editor (プレーンテキストの入力欄), while the floating DetailPanel stays VIEW-ONLY and
// reads the LIVE committed memo (detailDocumentOf, 現在時刻で都度解決). This spec proves
// the whole loop in the REAL built app:
//
//   編集→保存 → the floating 詳細パネル shows the memo AS TYPED (書式を解釈しない);
//   Ctrl+Z    → the commit is ONE undo unit — the memo reverts (view-only panel
//               reflects the live truth);
//   Ctrl+Y    → redo restores the same memo.
//
// **増分 2 で保存ボタンの場所が変わった**（N-46）。以前は本文に専用の保存
// ボタンがあり、同じ画面に「押さないと保存されない」場所が 2 つあった。いまは
// 名前・種別ラベル・見た目・作業メモを **素性欄の下端の保存列 1 本** で確定するので、
// 取り消しも 1 手のままである（この spec の Ctrl+Z / Ctrl+Y がそれを見ている）。

import { test, expect } from '@playwright/test';

import { commitOneFace, launchApp, openPropertySection } from './helpers';

test.describe('fr98 — 作業メモの編集（サイドバー編集面 + フローティング閲覧面）', () => {
  test('編集→保存→詳細パネルに反映→undo で戻る→redo で再適用', async () => {
    test.setTimeout(120_000);
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // Commit ONE face; the property panel resolves it (edit mode via add commit).
      await commitOneFace(page);
      const faceId = ((await page.getByTestId('app-active-feature').textContent()) ?? '').trim();
      expect(faceId.length).toBeGreaterThan(0);

      // --- 編集→保存 (sidebar 編集面). ---
      const section = page.getByTestId('detail-document-section');
      await expect(section).toBeVisible();
      // 節は初期は折りたたみ（増分 2 の手直し D2 / 設計書 §C.6）。開いてから中を見る。
      await openPropertySection(page, 'detail-document-section');
      // 編集できるときは、切替なしで初めから入力欄が出る（プレーンテキスト）。
      await expect(section.getByTestId('detail-doc-mode-edit')).toHaveCount(0);
      const textarea = section.getByTestId('detail-doc-textarea');
      await expect(textarea).toBeVisible();
      await textarea.fill('**重要**な城の記録');
      // セクションに専用の保存ボタンは無く、下端の保存列へ案内する（N-46）。
      await expect(section.getByTestId('detail-doc-save')).toHaveCount(0);
      await expect(section.getByTestId('detail-doc-save-hint')).toBeVisible();
      await page.getByTestId('save-button').click();
      // Honest-failure discipline: a save error would surface a message; none here.
      await expect(page.getByTestId('save-message')).toHaveCount(0);

      // --- The floating 詳細パネル (view-only) shows the LIVE committed memo as typed. ---
      await page.getByTestId('open-detail-button').click();
      const panel = page.getByTestId(`detail-panel-${faceId}`);
      await expect(panel).toBeVisible();
      const panelMemo = panel.getByTestId('detail-panel-memo');
      await expect(panelMemo).toHaveText('**重要**な城の記録');
      await expect(panelMemo.locator('strong')).toHaveCount(0);

      // 追加の道具を外す: the armed add tool keeps an (empty) session past Idle, which
      // SUSPENDS the global shortcuts (bughunt3 H2) — Ctrl+Z would be swallowed.
      // **増分 5b**: モードのボタンは無くなったので、**「選択」道具へ戻す**。
      // 内部の mode は add → edit になり（設計書 §D.1）、大域の EditUndo が通る。
      // 浮いているパネルは選択に依らないので、この持ち替えでも残る。
      await page.getByTestId('tool-edit.select').click();

      // --- Ctrl+Z: ONE undo unit — the committed memo reverts to absent. ---
      await page.keyboard.press('Control+z');
      await expect(panelMemo).toHaveCount(0);
      await expect(panel.getByTestId('detail-panel-memo-empty')).toBeVisible();

      // --- Ctrl+Y: redo replays the SAME memo (教訓 5.23 対称). ---
      await page.keyboard.press('Control+y');
      await expect(panelMemo).toHaveText('**重要**な城の記録');
    } finally {
      await app.close();
    }
  });
});
