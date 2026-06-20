// U15 — the typed IPC CONTRACT: the SINGLE SOURCE OF TRUTH for every channel
// name, argument type and return type that crosses the Electron process
// boundary (開発ガイド §5.33). Renderer (caller), preload (exposer) and main
// (receiver) all import THIS module so the three参照 the same definitions and
// never rely on a string coinciding by accident.
//
// Layer: shell. Pure type/const module — it imports domain persistence TYPES
// only (the parsed manifest shape it transports), never Electron and never a
// fs/IO module, so both the renderer-side and the main-side can import it
// without dragging Node into the renderer.
//
// 教訓5.33適用: changing a channel name here is a SINGLE change unit — the
// const map below is the only place a channel string is written; preload and
// main read it. The両側 tests (ipc-contract.test.ts + preload exposure test)
// fail if a name drifts on one side only (受け入れ基準4).

import type { ParseResult } from '../../domain/persistence/boundary';
import type { Manifest } from '../../domain/persistence/schema';

// --- channel names (the ONE place the strings live) -------------------------
//
// Namespaced under `tmap:` so they cannot collide with Electron's own internal
// channels. The renderer never sees these strings — preload wraps them.
export const IPC_CHANNEL = {
  /** Save to the current path (Ctrl+S相当). Main may open a dialog if no path. */
  Save: 'tmap:save',
  /** Save As — main opens a save dialog to pick a fresh path (FR-105). */
  SaveAs: 'tmap:save-as',
  /** Load — main opens an open dialog, reads + Zod-validates the file (FR-105). */
  Load: 'tmap:load',
  /** Drag & drop load — renderer hands a dropped absolute path to main (FR-105). */
  LoadDropped: 'tmap:load-dropped',
  /** Push the auto-save interval / generation cap from settings into main. */
  ConfigureAutoSave: 'tmap:configure-auto-save',
  /**
   * One-way MAIN→RENDERER event: the auto-save scheduler fired. The renderer
   * responds by performing a `save` (it owns the live manifest/asset bytes), so
   * the auto-save routes through the SAME atomic save path as a manual save
   * (FR-108 / 受け入れ基準3). Unlike the others this is a `send`/`on` event, not
   * an `invoke` round-trip — but the channel name still lives ONLY here so the
   * sender (main) and the preload subscriber never rely on a coincidental string.
   */
  AutoSaveTick: 'tmap:auto-save-tick',
} as const;

export type IpcChannel = (typeof IPC_CHANNEL)[keyof typeof IPC_CHANNEL];

// --- payload shapes ---------------------------------------------------------

/**
 * A save request carries the already-serialized manifest (a plain, JSON-safe
 * value produced by U14 `serialize`) plus the binary assets to embed in the
 * `.tmap` ZIP: the base-map image and the attached document images. The
 * renderer never touches `fs`; it ships bytes through this typed channel and
 * main performs the atomic write.
 */
export interface SaveRequest {
  /** The validated/serialized manifest value (FR-103 / FR-104). */
  readonly manifest: Manifest;
  /** Base-map image bytes (the ZIP base-map asset). */
  readonly baseMapImage: Uint8Array;
  /** Attached document images, keyed by the manifest-referenced asset name. */
  readonly attachments: readonly NamedAsset[];
}

/** A binary asset (an image) addressed by a stable name within the ZIP. */
export interface NamedAsset {
  /** Asset name as referenced from the manifest (e.g. `attach-1.png`). */
  readonly name: string;
  /** The raw image bytes. */
  readonly bytes: Uint8Array;
}

/** Outcome of a save (atomic write). Discriminated so failure is explicit. */
export type SaveResponse =
  | { readonly ok: true; readonly path: string }
  // User dismissed the save/Save-As dialog: not an error, not a success.
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'write-failed'; readonly message: string };

/**
 * Outcome of a load. Success carries the parsed (Zod-validated, FR-104/116)
 * manifest plus the extracted binary assets. Failure carries a reason and a
 * 日本語 message (拒否理由は通知と戻り値の両方で, 教訓5.26).
 */
export type LoadResponse =
  | {
      readonly ok: true;
      readonly path: string;
      readonly manifest: Manifest;
      readonly baseMapImage: Uint8Array;
      readonly attachments: readonly NamedAsset[];
    }
  | { readonly ok: false; readonly reason: 'cancelled' }
  | {
      readonly ok: false;
      readonly reason: 'read-failed' | 'corrupt' | 'invalid';
      readonly message: string;
      // For the `invalid` case, the structured parse result (FR-104).
      readonly parse?: ParseResult;
    };

/** Auto-save configuration pushed from the settings unit (FR-108). */
export interface AutoSaveConfig {
  /** Interval in milliseconds (settings-derived; NOT hardcoded here). */
  readonly intervalMs: number;
  /** Generation cap for timestamped backups (settings-derived). */
  readonly maxGenerations: number;
}

export type ConfigureAutoSaveResponse = { readonly ok: true };

/**
 * Unsubscribe handle returned by a one-way event subscription. Calling it
 * detaches the listener so the renderer can clean up (e.g. on unmount).
 */
export type Unsubscribe = () => void;

/**
 * The full typed surface exposed to the renderer through `contextBridge`. This
 * interface is the contract the preload exposure test pins (受け入れ基準4): the
 * preload object must structurally satisfy `TimeMapApi`, and main must register
 * a handler for every channel. Save-As takes no path argument: main owns the
 * dialog (spec §やること: ダイアログ起動はメイン側).
 */
export interface TimeMapApi {
  readonly save: (req: SaveRequest) => Promise<SaveResponse>;
  readonly saveAs: (req: SaveRequest) => Promise<SaveResponse>;
  readonly load: () => Promise<LoadResponse>;
  readonly loadDropped: (droppedPath: string) => Promise<LoadResponse>;
  readonly configureAutoSave: (config: AutoSaveConfig) => Promise<ConfigureAutoSaveResponse>;
  /**
   * Subscribe to the one-way auto-save tick (main→renderer). The renderer wires
   * this to perform a `save`, closing the FR-108 auto-save loop end-to-end
   * (受け入れ基準3). Returns an {@link Unsubscribe} that detaches the listener.
   * Under contextIsolation+sandbox the renderer cannot touch `ipcRenderer.on`
   * directly, so this typed wrapper is the ONLY way it can hear the tick.
   */
  readonly onAutoSaveTick: (listener: () => void) => Unsubscribe;
}
