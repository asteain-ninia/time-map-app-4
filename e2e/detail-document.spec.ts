// fr98 回帰ロック — 詳細文書の編集UI behavioural E2E.
//
// THE POINT (FR-98 後段 / 教訓 5.7): the sidebar PropertyPanel carries the 詳細文書
// editor (閲覧/編集切替), while the floating DetailPanel stays VIEW-ONLY and reads
// the LIVE committed document (detailDocumentOf, 現在時刻で都度解決). This spec proves
// the whole loop in the REAL built app:
//
//   編集→保存 → the floating 詳細パネル renders the sanitized document;
//   Ctrl+Z    → the commit is ONE undo unit — the document reverts (view-only panel
//               reflects the live truth);
//   Ctrl+Y    → redo restores the same document.
//
// **増分 2 で保存ボタンの場所が変わった**（N-46）。以前は詳細文書に専用の保存
// ボタンがあり、同じ画面に「押さないと保存されない」場所が 2 つあった。いまは
// 名前・種別ラベル・見た目・詳細文書を **素性欄の下端の保存列 1 本** で確定するので、
// 取り消しも 1 手のままである（この spec の Ctrl+Z / Ctrl+Y がそれを見ている）。

import { test, expect } from '@playwright/test';

import { commitOneFace, launchApp, openPropertySection } from './helpers';

test.describe('fr98 — 詳細文書の編集（サイドバー編集面 + フローティング閲覧面）', () => {
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
      // Empty document → the preview placeholder shows first (honest empty).
      await expect(section.getByTestId('detail-doc-empty')).toBeVisible();
      await section.getByTestId('detail-doc-mode-edit').click();
      const textarea = section.getByTestId('detail-doc-textarea');
      await expect(textarea).toBeVisible();
      await textarea.fill('**重要**な城の記録');
      // セクションに専用の保存ボタンは無く、下端の保存列へ案内する（N-46）。
      await expect(section.getByTestId('detail-doc-save')).toHaveCount(0);
      await expect(section.getByTestId('detail-doc-save-hint')).toBeVisible();
      await page.getByTestId('save-button').click();
      // Honest-failure discipline: a save error would surface a message; none here.
      await expect(page.getByTestId('save-message')).toHaveCount(0);

      // --- The floating 詳細パネル (view-only) renders the LIVE committed document. ---
      await page.getByTestId('open-detail-button').click();
      const panel = page.getByTestId(`detail-panel-${faceId}`);
      await expect(panel).toBeVisible();
      const panelDoc = panel.getByTestId('markdown-view');
      await expect(panelDoc.locator('strong')).toHaveText('重要');

      // Leave 追加モード: the armed add tool keeps an (empty) session past Idle, which
      // SUSPENDS the global shortcuts (bughunt3 H2) — Ctrl+Z would be swallowed. 編集
      // モード with no tool lets the global EditUndo dispatch; the floating panel is
      // selection-independent, so it survives the setMode reset契約.
      await page.getByTestId('mode-edit').click();

      // --- Ctrl+Z: ONE undo unit — the committed document reverts to absent. ---
      await page.keyboard.press('Control+z');
      await expect(panelDoc.locator('strong')).toHaveCount(0);

      // --- Ctrl+Y: redo replays the SAME document (教訓 5.23 対称). ---
      await page.keyboard.press('Control+y');
      await expect(panelDoc.locator('strong')).toHaveText('重要');
    } finally {
      await app.close();
    }
  });
});
