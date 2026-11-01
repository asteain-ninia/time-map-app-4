import { describe, expect, it, vi } from 'vitest';

import { createNativeDialogs, type NativeDialogPort } from './native-dialogs';

const WINDOW = { id: 'main-window' };

function setup(
  over: { readonly e2eSaveAsPath?: string; readonly e2eOpenPath?: string; readonly owner?: typeof WINDOW | undefined } = {},
) {
  const showOpenDialog = vi.fn<NativeDialogPort<typeof WINDOW>['showOpenDialog']>(async () => ({
    canceled: false,
    filePaths: ['/picked'],
  }));
  const showSaveDialog = vi.fn<NativeDialogPort<typeof WINDOW>['showSaveDialog']>(async () => ({
    canceled: false,
    filePath: '/saved',
  }));
  const dialogs = createNativeDialogs<typeof WINDOW>({
    port: { showOpenDialog, showSaveDialog },
    owner: () => ('owner' in over ? over.owner : WINDOW),
    e2eSaveAsPath: over.e2eSaveAsPath ?? null,
    e2eOpenPath: over.e2eOpenPath ?? null,
  });
  return { dialogs, showOpenDialog, showSaveDialog };
}

describe('OS のダイアログの束ね', () => {
  it('3 つの口のどれも親の窓を渡す', async () => {
    const { dialogs, showOpenDialog, showSaveDialog } = setup();
    expect(await dialogs.showOpenDialog()).toBe('/picked');
    expect(await dialogs.showOpenImageDialog()).toBe('/picked');
    expect(await dialogs.showSaveDialog()).toBe('/saved');
    expect(showOpenDialog.mock.calls.map((c) => c[0])).toEqual([WINDOW, WINDOW]);
    expect(showSaveDialog.mock.calls.map((c) => c[0])).toEqual([WINDOW]);
  });

  it('形式の絞り込みは口ごとに違う', async () => {
    const { dialogs, showOpenDialog } = setup();
    await dialogs.showOpenDialog();
    await dialogs.showOpenImageDialog();
    expect(showOpenDialog.mock.calls[0]?.[1].filters[0]?.extensions).toEqual(['gimoza']);
    expect(showOpenDialog.mock.calls[1]?.[1].filters[0]?.extensions).toEqual(['png', 'jpg', 'jpeg']);
  });

  it('やめたら undefined。既定の名前は渡されたときだけ', async () => {
    const { dialogs, showOpenDialog, showSaveDialog } = setup();
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    showSaveDialog.mockResolvedValue({ canceled: true });
    expect(await dialogs.showOpenDialog()).toBeUndefined();
    expect(await dialogs.showSaveDialog('/d/a.gimoza')).toBeUndefined();
    await dialogs.showSaveDialog();
    expect(showSaveDialog.mock.calls[0]?.[1].defaultPath).toBe('/d/a.gimoza');
    expect(showSaveDialog.mock.calls[1]?.[1]).not.toHaveProperty('defaultPath');
  });

  it('E2E の脱出口があれば本物を開かない', async () => {
    const { dialogs, showOpenDialog, showSaveDialog } = setup({
      e2eOpenPath: '/e2e/open',
      e2eSaveAsPath: '/e2e/save',
    });
    expect(await dialogs.showOpenDialog()).toBe('/e2e/open');
    expect(await dialogs.showSaveDialog()).toBe('/e2e/save');
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('窓が 1 つも無ければ親なしで開く（落ちない）', async () => {
    const { dialogs, showOpenDialog } = setup({ owner: undefined });
    expect(await dialogs.showOpenDialog()).toBe('/picked');
    expect(showOpenDialog.mock.calls[0]?.[0]).toBeUndefined();
  });
});
