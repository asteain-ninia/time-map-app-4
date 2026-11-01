// 検査ごとの一時フォルダ（`%TEMP%` に残さない）。`mkdtempSync` の名前の頭は `e2e/stale-userdata.ts` の
// 一覧にも足す（打ち切りや強制終了で残ったものを次の実行で片付ける）。
//
//   const scratch = createScratchDirs('gimoza-xxx-');
//   test.afterEach(scratch.removeAll);

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ScratchDirs {
  /** 新しい一時フォルダを作る。 */
  readonly make: () => string;
  /** ここまでに作ったものを全部消す。Electron を閉じた直後は掴まれていることがあるので、少し待ち直す。 */
  readonly removeAll: () => void;
}

export function createScratchDirs(prefix: string): ScratchDirs {
  const made: string[] = [];
  return {
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      made.push(dir);
      return dir;
    },
    removeAll: () => {
      for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  };
}
