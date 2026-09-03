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

  it('確認していない保存先へは、自動保存が 1 バイトも書かない（A4-a）', async () => {
    // **以前はここで書けてしまっていた。** 自動保存はダイアログを開けない（開くと 5 分
    // ごとに作業が止まる）ので確認を迂回して直接ディスクへ書いており、利用者が確認
    // ダイアログを見る前に、取り違えた正準ファイルが上書き済みになっていた。あとから
    // 確認を出しても安全確認としては手遅れである。**確認が済むまで書かない**にする。
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
    expect(api.save).not.toHaveBeenCalled();

    // 確認はまだ 1 度も出ていないので、手動の保存でこれから出る。
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    expect(screen.getByTestId('overwrite-dialog')).toBeInTheDocument();
  });

  it('確認が済むと自動保存が動き出す（ただし変更があるときだけ）', async () => {
    let tick: (() => void) | null = null;
    const { store, registry, api } = await renderWithLoadedProject(
      {},
      {
        onAutoSaveTick: vi.fn((cb: () => void) => {
          tick = cb;
          return () => {};
        }),
      },
    );
    await dispatchSaveConfirming(registry);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    // A4-b: 保存直後は変更が無いので書かない。
    await act(async () => {
      tick?.();
    });
    expect(api.save).toHaveBeenCalledTimes(1);

    await act(async () => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    await act(async () => {
      tick?.();
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  });

  it('自動保存の成功は「直前の結果」を書き替えない（A4-c / 教訓 5.12）', async () => {
    // 利用者が読もうとしていた拒否理由が、5 分後の自動保存で勝手に消えてはいけない。
    // 更新するのは「最終保存」枠だけにする。
    let tick: (() => void) | null = null;
    const statusMessages = new StatusMessageStore();
    const seen: SaveStatus[] = [];
    const { store, registry, api } = await renderWithLoadedProject(
      { statusMessages, onSaveStatusChange: (st: SaveStatus) => seen.push(st) },
      {
        onAutoSaveTick: vi.fn((cb: () => void) => {
          tick = cb;
          return () => {};
        }),
      },
    );
    await dispatchSaveConfirming(registry);
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    statusMessages.failure('この地物は 1200 年には存在しません。');
    await act(async () => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    const savedAtBefore = seen[seen.length - 1]!.savedAtMs;
    await act(async () => {
      tick?.();
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));

    // 直前の結果はそのまま。最終保存の時刻だけが動く。
    expect(statusMessages.get()?.text).toBe('この地物は 1200 年には存在しません。');
    await waitFor(() => {
      const last = seen[seen.length - 1]!;
      expect(last.savedAtMs).not.toBeNull();
      expect(last.savedAtMs).not.toBe(savedAtBefore);
    });
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

    // マウント直後は「保存先未確定・未保存・自動保存は待機中」。
    expect(seen[0]).toEqual({ savePath: null, savedAtMs: null, autoSaveArmed: false });
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

  it('書き込みに失敗したら理由が状態行に出る（OS の警告ボックスではなく）', async () => {
    // A5: **以前はここが「キャンセル」で failure を期待していた**。利用者がネイティブの
    // 保存ダイアログを閉じただけで赤い「保存できませんでした」が出ていたということで、
    // 検査そのものが誤った挙動を固定していた。失敗の検査は書き込み失敗で行う。
    const statusMessages = new StatusMessageStore();
    const alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    const store = makeStore();
    const registry = new CommandRegistry();
    const api = makeApi({
      saveAs: vi.fn(
        async (): Promise<SaveResponse> => ({
          ok: false,
          reason: 'write-failed',
          message: 'ディスクがいっぱいです。',
        }),
      ),
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
    expect(statusMessages.get()?.text).toContain('ディスクがいっぱいです。');
    // 二重通知はやめた（同じ失敗が状態行と OS の警告ボックスの両方に出ていた）。
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('保存をやめただけなら失敗にしない（中立の色味で出す）', async () => {
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

    await waitFor(() => expect(statusMessages.get()?.tone).toBe('neutral'));
    expect(statusMessages.get()?.text).toContain('ファイルは変わっていません');
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

describe('上書き確認は排他（A1 / A2）— 確認したファイルと書かれるファイルが入れ替わらない', () => {
  it('確認を出している間に 2 回目の 保存 を押しても、ダイアログは 1 枚のまま（約束を孤児にしない）', async () => {
    // **以前は 2 枚目の確認が 1 枚目の resolve を上書きし、1 個目の Promise が
    // 永久に解決しないまま残っていた**（単一スロットの pendingOverwrite）。
    const { registry, api } = await renderWithLoadedProject();

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });

    expect(screen.getAllByTestId('overwrite-dialog')).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-confirm'));
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('overwrite-dialog')).not.toBeInTheDocument();
  });

  it('確認を出している間は 開く / ドラッグ＆ドロップ / 新規 が走らない（致命の根）', async () => {
    // 確認中に別のファイルを読み込めると、「A を上書きする」を押した時点で保存先は
    // B になっており、**画面で確認したのとは別のファイルを初回確認なしで上書きする**。
    const { registry, api } = await renderWithLoadedProject();

    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    expect(screen.getByTestId('overwrite-dialog')).toBeInTheDocument();

    const loadsBefore = (api.load as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileNew);
    });
    expect((api.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadsBefore);
    // 確認はまだ生きていて、答えれば保存できる。
    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-confirm'));
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  });

  it('確認を出している間は自動保存のティックも走らない', async () => {
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
      registry.dispatch(COMMAND_ID.FileSave);
    });
    await act(async () => {
      tick?.();
    });
    expect(api.save).not.toHaveBeenCalled();
  });

  it('確認の外（背景）を押しても何も起きない層が敷かれる（教訓 5.14）', async () => {
    const { registry } = await renderWithLoadedProject();
    expect(screen.queryByTestId('file-ops-backdrop')).not.toBeInTheDocument();
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    expect(screen.getByTestId('file-ops-backdrop')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-cancel'));
    });
    expect(screen.queryByTestId('file-ops-backdrop')).not.toBeInTheDocument();
  });
});

describe('未保存警告の「保存して続行」（A3）', () => {
  it('どのファイルへ書くのかを押す前に見せる', async () => {
    const { store, registry } = await renderWithLoadedProject();
    await act(async () => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    expect(screen.getByTestId('unsaved-destination')).toHaveTextContent(LOADED_PATH);
  });

  it('「保存して続行」も上書き確認を通る（この枝だけが素通りしていた）', async () => {
    const { store, registry, api } = await renderWithLoadedProject();
    await act(async () => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unsaved-save'));
    });

    // 確認が出るまでは 1 バイトも書かない。
    expect(screen.getByTestId('overwrite-dialog')).toBeInTheDocument();
    expect(api.save).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-confirm'));
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  });

  it('上書き確認で「やめる」を押したら、続行もしない（未保存のまま読み込みへ進まない）', async () => {
    const { store, registry, api } = await renderWithLoadedProject();
    const loadsBefore = (api.load as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      store.getState().updateProjectSetting('gridVisible', false);
    });
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unsaved-save'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-cancel'));
    });

    expect(api.save).not.toHaveBeenCalled();
    expect((api.load as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadsBefore);
  });
});

describe('名前を付けて保存の「確認済み」判定は intent で決める（A7）', () => {
  it('既に保存先があるプロジェクトからの 名前を付けて保存 でも、以後は聞かれない', async () => {
    // **以前は保存前の needsSaveAs で判定していた**ので、保存先が既にある
    // プロジェクトからの「名前を付けて保存」は確認済みに載らず、利用者が
    // ネイティブダイアログで行き先を選んだ直後の Ctrl+S でまた聞かれていた。
    const { registry, api } = await renderWithLoadedProject(
      {},
      {
        saveAs: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/other.gimoza' })),
        save: vi.fn(async (): Promise<SaveResponse> => ({ ok: true, path: '/tmp/other.gimoza' })),
      },
    );

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

describe('保存完了の世代ガード（A6）', () => {
  it('保存中に別のプロジェクトを開いたら、その保存の結果は今の文書に書かない', async () => {
    // **以前は savedAtMs / 「保存しました（A）」がガードの外にあった**ので、B を開いた
    // 直後に「B は今保存された」と読める表示が出て、B を保存済みと誤認して終了しうる。
    const statusMessages = new StatusMessageStore();
    const seen: SaveStatus[] = [];
    let releaseSave: ((r: SaveResponse) => void) | null = null;
    const { registry, api } = await renderWithLoadedProject(
      { statusMessages, onSaveStatusChange: (st: SaveStatus) => seen.push(st) },
      {
        save: vi.fn(
          () =>
            new Promise<SaveResponse>((resolve) => {
              releaseSave = resolve;
            }),
        ),
        load: vi.fn(async () => okLoad()),
      },
    );

    // 1 回目の保存で確認を済ませる（この保存は宙に浮いたままにする）。
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileSave);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('overwrite-confirm'));
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));

    // 保存の完了を待たずに別のプロジェクトを開く（保存文脈が差し替わる）。
    await act(async () => {
      registry.dispatch(COMMAND_ID.FileOpen);
    });
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2));
    const afterLoad = seen[seen.length - 1]!;
    expect(afterLoad.savedAtMs).toBeNull();

    // ここで古い保存が完了する。**今の文書の最終保存時刻も直前の結果も汚さない。**
    await act(async () => {
      releaseSave?.({ ok: true, path: LOADED_PATH });
      await Promise.resolve();
    });
    await waitFor(() => expect(seen[seen.length - 1]!.savedAtMs).toBeNull());
    expect(statusMessages.get()).toBeNull();
  });
});
