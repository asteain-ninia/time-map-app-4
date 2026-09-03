// 上書き保存の確認と、保存の素性・結果の通知（設計書 §H.6 / §H.5、実装計画 増分 1 の中身 2・3）。
//
// V12 の合格条件は「①ファイル名が常に見える ②未保存の印がある ③最終保存時刻が見える」で、
// **現状はすべて無し**だった。それでいて Ctrl+S は確認なく読み込み元を上書きしていた。
// 調査中に実データの正準ファイルが上書きされた実績もある（開発ガイド §5.48）。
//
// ここで固定するのは 2 つ。
//   1. **初回の上書きだけ**、行き先の名前とフルパスを見せて聞く（毎回聞くと儀式になる）。
//   2. 保存先と最終保存時刻と保存の結果が、ホスト（タイトル・状態行）へ届く。

/// <reference types="@testing-library/jest-dom" />

import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoreApi } from 'zustand/vanilla';

import { getCalendar } from '../../domain/time/calendar';
import { serialize, type Manifest } from '../../domain/persistence/index';
import type { DomainProject } from '../../domain/persistence/index';
import type { LoadResponse, SaveResponse, TimeMapApi } from '../../shell/ipc/contract';

import { createSessionStore, type SessionStore } from '../state/store';
import { CommandRegistry, COMMAND_ID } from '../shell/commands';
import { StatusMessageStore } from '../shell/status-message';

import { FileOpsController } from './FileOpsController';
import { buildEmptyProject, type SaveStatus } from './save-context';

const CAL = getCalendar('gregorian');
const LOADED_PATH = '/tmp/loaded.gimoza';

function makeStore(): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({ initialDomain: buildEmptyProject() });
}

function makeApi(overrides: Partial<TimeMapApi> = {}): TimeMapApi {
  return {
    save: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: LOADED_PATH })),
    saveAs: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/named.gimoza' })),
    load: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    loadDropped: vi.fn(async (): Promise<LoadResponse> => ({ ok: false, reason: 'cancelled' })),
    configureAutoSave: vi.fn(async () => ({ ok: true as const })),
    onAutoSaveTick: vi.fn(() => () => {}),
    onCloseRequest: vi.fn(() => () => {}),
    appendLog: vi.fn(async () => {}),
    openImage: vi.fn(async (): Promise<Uint8Array | null> => null),
    commitLoadedPath: vi.fn(async () => {}),
    ...overrides,
  };
}

function okLoad(): LoadResponse {
  const manifest: Manifest = serialize(buildEmptyProject());
  return {
    ok: true,
    path: LOADED_PATH,
    manifest,
    baseMapImage: new Uint8Array(),
    attachments: [],
  };
}

type ControllerProps = React.ComponentProps<typeof FileOpsController>;

/** 読み込み済み（保存先が確定した）状態のコントローラを作る。 */
async function renderWithLoadedProject(
  extra: Partial<ControllerProps> = {},
  apiOverrides: Partial<TimeMapApi> = {},
): Promise<{
  store: StoreApi<SessionStore<DomainProject>>;
  registry: CommandRegistry;
  api: TimeMapApi;
}> {
  const store = makeStore();
  const registry = new CommandRegistry();
  const api = makeApi({ load: vi.fn(async () => okLoad()), ...apiOverrides });
  render(
    <FileOpsController store={store} registry={registry} api={api} calendar={CAL} {...extra} />,
  );
  await act(async () => {
    registry.dispatch(COMMAND_ID.FileOpen);
  });
  await waitFor(() => expect(api.load).toHaveBeenCalledTimes(1));
  return { store, registry, api };
}

/** 保存を実行し、上書き確認が出たら「上書き保存する」を押して先へ進める。 */
async function dispatchSaveConfirming(registry: CommandRegistry): Promise<void> {
  await act(async () => {
    registry.dispatch(COMMAND_ID.FileSave);
  });
  const confirm = screen.queryByTestId('overwrite-confirm');
  if (confirm !== null) {
    await act(async () => {
      fireEvent.click(confirm);
    });
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('上書き保存の前に行き先を見せる（設計書 §H.6 / 開発ガイド §5.48 の UI 側）', () => {
  it('読み込んだファイルへの初回の上書きでは、名前とフルパスを見せて聞く', async () => {
    const { registry, api } = await renderWithLoadedProject();

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });

    expect(screen.getByTestId('overwrite-dialog')).toBeInTheDocument();
    // 何を上書きするのかが分からないと確認の意味がないので、名前は必ず出す。
    expect(screen.getByTestId('overwrite-body')).toHaveTextContent('loaded.gimoza');
    // 同名ファイルの取り違え（フル版 / 間引き版）はフルパスでしか見分けられない。
    expect(screen.getByTestId('overwrite-path')).toHaveTextContent(LOADED_PATH);
    // まだ 1 バイトも書いていない。
    expect(api.save).not.toHaveBeenCalled();
  });

  it('「やめる」を押すとファイルは変わらず、状態行に結果が出る', async () => {
    const statusMessages = new StatusMessageStore();
    const { registry, api } = await renderWithLoadedProject({ statusMessages });

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-cancel'));
    });

    expect(api.save).not.toHaveBeenCalled();
    expect(statusMessages.get()?.text).toContain('ファイルは変わっていません');
  });

  it('「上書き保存する」で保存され、2 回目からは聞かない（確認は初回だけ）', async () => {
    const { registry, api } = await renderWithLoadedProject();

    await dispatchSaveConfirming(registry);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    expect(screen.queryByTestId('overwrite-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  });

  it('保存先が決まっていない新規では聞かない（名前を付けて保存へ落ちる）', async () => {
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi();
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });

    expect(screen.queryByTestId('overwrite-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));
  });

  it('自動保存では「確認済み」にしない（自動保存が先に走っても確認は出続ける）', async () => {
    // 自動保存はダイアログを開けない（開くと 5 分ごとに作業が止まる）。だからといって
    // 自動保存が走った先を「確認済み」に載せてしまうと、**利用者は一度も確認を見ないまま
    // 上書きが既成事実になる**。載せるのは利用者自身の確認と名前を付けて保存だけにする。
    let tick: (() => void) | null = null;
    const { registry, api } = await renderWithLoadedProject(
      {},
      {
        onAutoSaveTick: vi.fn((cb: () => void) => {
          tick = cb;
          return () => {};
        }),
      },
    );

    await act(async () => {
      tick?.();
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    expect(screen.getByTestId('overwrite-dialog')).toBeInTheDocument();
  });

  it('名前を付けて保存で選んだ先は、以後このセッションでは聞かない', async () => {
    // main のネイティブダイアログが上書きの可否を既に聞いているので、二重に聞かない。
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      save: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/named.gimoza' })),
    });
    render(<FileOpsController store={store} registry={registry} api={api} calendar={CAL} />);

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSaveAs);
    });
    await waitFor(() => expect(api.saveAs).toHaveBeenCalledTimes(1));

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    expect(screen.queryByTestId('overwrite-dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  });
});

describe('保存の素性と結果をホストへ上げる（V12 の ①②③）', () => {
  it('読み込みで保存先が上がり、保存で時刻が上がる', async () => {
    const seen: SaveStatus[] = [];
    const { registry } = await renderWithLoadedProject({
      onSaveStatusChange: (s: SaveStatus) => seen.push(s),
    });

    // マウント直後は「保存先未確定・未保存」。
    expect(seen[0]).toEqual({ savePath: null, savedAtMs: null });
    // 読み込み後は保存先が確定し、まだこのセッションでは保存していない。
    const afterLoad = seen[seen.length - 1]!;
    expect(afterLoad.savePath).toBe(LOADED_PATH);
    expect(afterLoad.savedAtMs).toBeNull();

    await dispatchSaveConfirming(registry);

    await waitFor(() => {
      const afterSave = seen[seen.length - 1]!;
      expect(afterSave.savePath).toBe(LOADED_PATH);
      expect(afterSave.savedAtMs).not.toBeNull();
    });
  });

  it('保存できたら状態行に「保存しました（ファイル名）」が出る', async () => {
    const statusMessages = new StatusMessageStore();
    const { registry } = await renderWithLoadedProject({ statusMessages });

    await dispatchSaveConfirming(registry);

    await waitFor(() => {
      expect(statusMessages.get()?.text).toBe('保存しました（loaded.gimoza）');
      expect(statusMessages.get()?.tone).toBe('success');
    });
  });

  it('保存できなかったら理由が状態行に出る（OS の警告ボックスではなく）', async () => {
    const statusMessages = new StatusMessageStore();
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      saveAs: vi.fn(async (): Promise<SaveResponse> => ({ ok: false, reason: 'cancelled' })),
    });
    render(
      <FileOpsController
        store={store}
        registry={registry}
        api={api}
        calendar={CAL}
        statusMessages={statusMessages}
      />,
    );

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });

    await waitFor(() => expect(statusMessages.get()?.tone).toBe('failure'));
  });

  it('プロジェクトを開き直すと直前の結果は消える（設計書 §H.5 の消える契機③）', async () => {
    const statusMessages = new StatusMessageStore();
    const { registry, api } = await renderWithLoadedProject({ statusMessages });
    await dispatchSaveConfirming(registry);
    await waitFor(() => expect(statusMessages.get()).not.toBeNull());

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));
    expect(statusMessages.get()).toBeNull();
  });
});
