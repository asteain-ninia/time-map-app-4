import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNEL,
  type AutoSaveConfig,
  type ConfigureAutoSaveResponse,
  type DiagnosticLogRecord,
  type LoadResponse,
  type SaveRequest,
  type SaveResponse,
  type TimeMapApi,
  type Unsubscribe,
} from '../ipc/contract';

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
  return {
    save: (req: SaveRequest): Promise<SaveResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.Save, req) as Promise<SaveResponse>,
    saveAs: (req: SaveRequest): Promise<SaveResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.SaveAs, req) as Promise<SaveResponse>,
    load: (): Promise<LoadResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.Load) as Promise<LoadResponse>,
    loadDropped: (droppedPath: string): Promise<LoadResponse> =>
      ipcRenderer.invoke(IPC_CHANNEL.LoadDropped, droppedPath) as Promise<LoadResponse>,
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
    // Diagnostic-log append (FR-117 / FR-02). Fire the record over the shared
    // AppendLog channel; main persists it to a LOCAL JSONL file. Best-effort — the
    // renderer sink swallows any rejection so an error-logging path never crashes.
    appendLog: (record: DiagnosticLogRecord): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNEL.AppendLog, record) as Promise<void>,
  };
}

const api: TimeMapApi = buildApi();

contextBridge.exposeInMainWorld('timeMapApi', api);

export type { TimeMapApi };
