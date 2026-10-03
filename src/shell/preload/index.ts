import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNEL,
  type AppPrefs,
  type AppPrefsWriteResult,
  type AutoSaveConfig,
  type BackupCount,
  type BackupListing,
  type BackupListRequest,
  type ConfigureAutoSaveResponse,
  type DiagnosticLogRecord,
  type LoadResponse,
  type SaveRequest,
  type SaveResponse,
  type TimeMapApi,
  type Unsubscribe,
} from '../ipc/contract';
import {
  E2E_HARNESS_BRIDGE_KEY,
  isE2eHarnessArgv,
  type E2eHarnessBridge,
} from '../ipc/e2e-harness';

// U15 — preload EXPOSER side (開発ガイド §5.33 / 受け入れ基準4,6).
//
// Runs under contextIsolation: true and sandbox: true. The ONLY surface that
// crosses the bridge is the typed `TimeMapApi`: a minimal set of save / save-as
// / load / drag-drop-load / configure-auto-save wrappers. The renderer never
// sees a channel string nor a raw `fs` handle — it can only reach the file I/O
// through these typed calls (FR-02 サンドボックス / 受け入れ基準6).
//
// SINGLE SOURCE OF TRUTH: the channel names and the argument/return types come
// from `../ipc/contract`, the same module main's receiver imports. The exposure
// test pins that `buildApi()` structurally satisfies `TimeMapApi` and uses the
// contract channels, so renaming a channel on one side only fails a test.

/** Build the typed API object that is exposed to the renderer. */
export function buildApi(): TimeMapApi {
  // 所見2 [MED] onCloseRequest は **単一購読** に制限する（latest-wins）。この API 面が
  // 覚えている「現在の close 要求リスナ」。複数の購読者が居ると各自が ACK と判定を送り、
  // main は先着の判定で決めてしまう（未保存を握る購読者の allow:false が後着だと無視され
  // fail-open し得る）。2 回目の登録は必ず 1 本目を解除してから貼るので、購読は常に最新の
  // 1 本だけになり先勝ちを封じる。
  let closeRequestListener: ((event: unknown, requestId: unknown) => void) | null = null;

  return {
    save: (req: SaveRequest): Promise<SaveResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.Save, req) as Promise<SaveResponse>,
    saveAs: (req: SaveRequest): Promise<SaveResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.SaveAs, req) as Promise<SaveResponse>,
    load: (): Promise<LoadResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.Load) as Promise<LoadResponse>,
    loadDropped: (droppedPath: string): Promise<LoadResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.LoadDropped, droppedPath) as Promise<LoadResponse>,
    // UC1 round-2 保存宛先の遅延昇格: at the renderer's load commit point, echo the read's
    // commitToken so main promotes currentPath ONLY for a load that reached the domain
    // (read成功=即昇格を廃止 — 修復中止したファイルを Ctrl+S で上書きしない).
    commitLoadedPath: (token: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNEL.CommitLoadedPath, token) as Promise<void>,
    // FR-04 ベースマップ差し替え: main opens the image dialog + reads the file; the
    // renderer receives only the bytes (or null on cancel / read-failure).
    openImage: (): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(IPC_CHANNEL.OpenImage) as Promise<Uint8Array | null>,
    configureAutoSave: (config: AutoSaveConfig): Promise<ConfigureAutoSaveResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.ConfigureAutoSave, config) as Promise<ConfigureAutoSaveResponse>,
    // One-way main→renderer event subscription. We wrap `ipcRenderer.on` so the
    // renderer never receives the raw IpcRendererEvent (it gets a clean no-arg
    // callback) and never touches a channel string. The returned Unsubscribe
    // detaches the exact listener we registered (not removeAllListeners), so
    // multiple subscribers — and unmount cleanup — are safe.
    onAutoSaveTick: (listener: () => void): Unsubscribe => {
      const wrapped = (): void => {
        listener();
      };
      ipcRenderer.on(IPC_CHANNEL.AutoSaveTick, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNEL.AutoSaveTick, wrapped);
      };
    },
    // FR-107 close ブリッジ: main の close 照会 → レンダラの未保存確認ガード → 応答。
    // 一方向イベント (CloseRequest) で要求 ID を受け、ガードの判定を CloseResponse で
    // **同じ ID を添えて** 返す（main は失効した応答を ID で捨てられる）。
    //
    // fail-closed の要: ガードが throw / reject しても **必ず** 応答する。応答しないと
    // main は無応答扱いでタイムアウトを待つだけになり、ユーザーには「× が効かない」に
    // 見える。例外時の判定は false（閉じない）— 例外で閉じる方向へ倒さない。
    onCloseRequest: (runGuard: () => Promise<boolean>): Unsubscribe => {
      // 所見2: 単一購読を強制する。既存の close 要求リスナが居たら、新しいものを貼る前に
      // 必ず解除する（latest-wins）。これで先勝ち allow:true / 二重 ACK・二重判定を防ぐ。
      if (closeRequestListener !== null) {
        ipcRenderer.removeListener(IPC_CHANNEL.CloseRequest, closeRequestListener);
        closeRequestListener = null;
      }
      const wrapped = (_event: unknown, requestId: unknown): void => {
        // main は必ず文字列 ID を送る。それ以外は照合できないので黙って捨てる。
        if (typeof requestId !== 'string' || requestId === '') return;
        // 受領 ACK（判定と分離）: 判定を走らせる **前に・同期的に** 「生きた購読者が
        // 居る」ことを main へ返す。この ACK は購読ラッパの中で送るので、届く = App が
        // onCloseRequest を購読済み = 元 document が生きている、の証。main はこれで
        // 「購読者不在」を短い ACK タイムアウトで検出し、生存中は誤って fail-open しない
        // （close-guard.ts の ADR: 片方向 rendererLoaded ラッチの根治）。送信失敗は握る
        // — ACK が届かなければ main は購読者不在として安全に処理する。
        void ipcRenderer.invoke(IPC_CHANNEL.CloseAck, { requestId }).catch(() => undefined);
        void (async (): Promise<void> => {
          let allow = false;
          try {
            allow = (await runGuard()) === true;
          } catch {
            allow = false;
          }
          try {
            await ipcRenderer.invoke(IPC_CHANNEL.CloseResponse, { requestId, allow });
          } catch {
            // 応答の送信自体が失敗した（ウィンドウ破棄中など）: main 側はタイムアウトで
            // fail-closed に倒れる。ここで再送すると二重応答になるので何もしない。
          }
        })();
      };
      closeRequestListener = wrapped;
      ipcRenderer.on(IPC_CHANNEL.CloseRequest, wrapped);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNEL.CloseRequest, wrapped);
        // 自分がまだ現行リスナなら参照を落とす（別の購読に置き換わっていれば触らない）。
        if (closeRequestListener === wrapped) closeRequestListener = null;
      };
    },
    // Diagnostic-log append (FR-117 / FR-02). Fire the record over the shared
    // AppendLog channel; main persists it to a LOCAL JSONL file. Best-effort — the
    // renderer sink swallows any rejection so an error-logging path never crashes.
    appendLog: (record: DiagnosticLogRecord): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNEL.AppendLog, record) as Promise<void>,
    // アプリ側の設定（userData の JSON 1 枚）。プロジェクトの中身とは無関係で、
    // 初回起動のガイドを二度と出さない、のような **この PC の覚え書き**だけを置く。
    readAppPrefs: (): Promise<AppPrefs> =>
      ipcRenderer.invoke(IPC_CHANNEL.ReadAppPrefs) as Promise<AppPrefs>,
    writeAppPrefs: (patch: Partial<AppPrefs>): Promise<AppPrefsWriteResult> =>
      ipcRenderer.invoke(IPC_CHANNEL.WriteAppPrefs, patch) as Promise<AppPrefsWriteResult>,
    // 増分 8D: 世代の一覧と、一覧の id で開く口。描画プロセスはパスを一切扱わない
    // （一覧は id しか運ばず、開くときも id しか渡せない）。頼み方は「元のファイルを選ばせる」
    // の真偽だけで、ここで組み立て直す（描画プロセスの物をそのまま渡さない）。
    listBackups: (request?: BackupListRequest): Promise<BackupListing> =>
      (request?.pickSource === true
        ? ipcRenderer.invoke(IPC_CHANNEL.ListBackups, { pickSource: true })
        : ipcRenderer.invoke(IPC_CHANNEL.ListBackups)) as Promise<BackupListing>,
    openBackup: (id: string): Promise<LoadResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.OpenBackup, id) as Promise<LoadResponse>,
    // 増分 8D の手直し: 地物数を後から埋める・1 回の終わり・数だけ・新規。
    countBackupFeatures: (id: string): Promise<number | null> =>
      ipcRenderer.invoke(IPC_CHANNEL.CountBackupFeatures, id) as Promise<number | null>,
    endBackupChoice: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNEL.EndBackupChoice) as Promise<void>,
    countBackups: (): Promise<BackupCount> =>
      ipcRenderer.invoke(IPC_CHANNEL.CountBackups) as Promise<BackupCount>,
    forgetSaveTarget: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNEL.ForgetSaveTarget) as Promise<void>,
  };
}

const api: TimeMapApi = buildApi();

contextBridge.exposeInMainWorld('timeMapApi', api);

/**
 * E2E 専用ブリッジ（src/shell/ipc/e2e-harness.ts）。main が E2E_TEST=1 のときだけ
 * additionalArguments で積む旗が `argv` にある場合に限り、`timeMapE2E` を公開する。
 * 公開するのは「ハーネスが有効」という印だけで I/O は一切持たない（読み込みは renderer 側が
 * 既存の typed IPC を通す）。本番ビルドでは旗が無いので、この関数は何も公開しない。
 * `expose` を引数に取るのは、テストで contextBridge をフェイクに差し替えて両側を固定するため。
 * 戻り値は公開したかどうか。
 */
export function exposeE2eHarnessIfRequested(
  argv: readonly string[],
  expose: (key: string, value: E2eHarnessBridge) => void,
): boolean {
  if (!isE2eHarnessArgv(argv)) return false;
  expose(E2E_HARNESS_BRIDGE_KEY, Object.freeze({ harness: true }));
  return true;
}

// sandbox 付き preload でも `process.argv` は Electron が提供する（additionalArguments は
// ここに積まれる）。旗が無ければ何もしない。
exposeE2eHarnessIfRequested(process.argv, (key, value) => {
  contextBridge.exposeInMainWorld(key, value);
});

export type { TimeMapApi };
