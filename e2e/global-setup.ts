// 実行の始めに 1 回だけ走る。残った一時フォルダの片付け（判断は ./stale-userdata、`docs/現状.md` の B122）。
//
// 片付けの失敗で検査を止めない（消せなかったものは次の実行で見直す）。

import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROCESS_LISTING_END,
  isE2eTempName,
  parseProcessListing,
  selectStaleUserData,
  staleUserDataSummary,
  type TempEntry,
} from './stale-userdata';

/** 動いている Electron のコマンドライン。読めなければ null。 */
function listElectronCommandLines(): readonly string[] | null {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop'; ` +
              `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
              `ForEach-Object { [string]$_.CommandLine -replace '[\\r\\n]+',' ' }; ` +
              `'${PROCESS_LISTING_END}'`,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
        )
      : spawnSync('sh', ['-c', `ps -axww -o args= | grep -i electron | grep -v grep; echo ${PROCESS_LISTING_END}`], {
          encoding: 'utf8',
          timeout: 30_000,
        });
  if (result.error !== undefined || result.status !== 0) return null;
  return parseProcessListing(result.stdout);
}

function readTempEntries(dir: string): readonly TempEntry[] {
  const entries: TempEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!isE2eTempName(name)) continue;
    try {
      entries.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // 読んでいる間に消えた（別の実行の終わり）。
    }
  }
  return entries;
}

export default function globalSetup(): void {
  const dir = tmpdir();
  const electronCommandLines = listElectronCommandLines();
  const stale = selectStaleUserData({
    entries: readTempEntries(dir),
    nowMs: Date.now(),
    electronCommandLines,
  });
  let removed = 0;
  for (const name of stale) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      removed += 1;
    } catch {
      // 掴まれている。次の実行で見直す。
    }
  }
  console.log(staleUserDataSummary(removed, electronCommandLines !== null));
}
