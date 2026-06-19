import { contextBridge } from 'electron';

// Preload runs under contextIsolation: true and sandbox: true.
// Only a minimal, explicitly exposed surface crosses the bridge.
// The typed IPC API is implemented in a later unit; for now this only
// establishes the contextBridge framework and confirms the preload loads
// without error under the sandbox.
const api = {} as const;

contextBridge.exposeInMainWorld('timeMapApi', api);

export type TimeMapApi = typeof api;
