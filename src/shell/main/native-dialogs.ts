// OS のファイルダイアログの束ね（Electron を import しない。実物の束縛は合成ルート。開発ガイド §5.41）。
//
// **親の窓を必ず渡す**（`docs/現状.md` の B120）。渡さないとダイアログは窓と無関係に開き、開いたまま地図を
// 触れる形になる（読み込みの間の編集が反映で消える経路の 1 つ）。親を渡せば OS のモーダルになる。
//
// E2E は本物のダイアログを出さない: 行き先を環境変数で決める脱出口を先に見る（合成ルートが `E2E_TEST=1` の
// ときだけ渡す。本番では両方とも null）。

/** {@link createNativeDialogs} が返す 3 つの口（`ipc-handlers` の `dialog` と同じ形）。 */
export interface NativeDialogs {
  showSaveDialog: (defaultPath?: string) => Promise<string | undefined>;
  showOpenDialog: () => Promise<string | undefined>;
  showOpenImageDialog: () => Promise<string | undefined>;
}

interface FileFilter {
  readonly name: string;
  readonly extensions: string[];
}

export interface OpenDialogRequest {
  readonly properties: ['openFile'];
  readonly filters: FileFilter[];
}

export interface SaveDialogRequest {
  readonly filters: FileFilter[];
  readonly defaultPath?: string;
}

/** Electron の `dialog` のうち使う口。`owner` が `undefined` なのは窓が 1 つも無いときだけ。 */
export interface NativeDialogPort<W> {
  showOpenDialog(
    owner: W | undefined,
    request: OpenDialogRequest,
  ): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
  showSaveDialog(
    owner: W | undefined,
    request: SaveDialogRequest,
  ): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
}

export interface NativeDialogOptions<W> {
  readonly port: NativeDialogPort<W>;
  /** いま親にする窓（ダイアログを開く瞬間に読む）。 */
  readonly owner: () => W | undefined;
  readonly e2eSaveAsPath: string | null;
  readonly e2eOpenPath: string | null;
}

const PROJECT_FILTERS: FileFilter[] = [{ name: 'gimoza', extensions: ['gimoza'] }];
// FR-04: 地図画像の差し替え（描画側の関門が受ける形式だけ）。
const IMAGE_FILTERS: FileFilter[] = [{ name: 'image', extensions: ['png', 'jpg', 'jpeg'] }];

export function createNativeDialogs<W>(options: NativeDialogOptions<W>): NativeDialogs {
  const { port, owner, e2eSaveAsPath, e2eOpenPath } = options;
  const pickOne = async (filters: FileFilter[]): Promise<string | undefined> => {
    const result = await port.showOpenDialog(owner(), { properties: ['openFile'], filters });
    return result.canceled ? undefined : result.filePaths[0];
  };
  return {
    showSaveDialog: async (defaultPath) => {
      if (e2eSaveAsPath !== null) return e2eSaveAsPath;
      // 増分 8D: 世代から戻したあとは、元の保存ファイルを既定の名前にする（V14 の規則 ②）。
      const result = await port.showSaveDialog(owner(), {
        filters: PROJECT_FILTERS,
        ...(defaultPath === undefined ? {} : { defaultPath }),
      });
      return result.canceled ? undefined : result.filePath;
    },
    showOpenDialog: async () => {
      if (e2eOpenPath !== null) return e2eOpenPath;
      return pickOne(PROJECT_FILTERS);
    },
    showOpenImageDialog: () => pickOne(IMAGE_FILTERS),
  };
}
