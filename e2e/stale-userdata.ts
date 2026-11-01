// 打ち切りや強制終了で `%TEMP%` に残った `tmap-e2e-userdata-*` と、E2E が作る `gimoza-*` の作業用フォルダを、
// 実行の始めに片付ける判断（`docs/現状.md` の B122 の直し）。`e2e/helpers.ts` の `process.on('exit')` は、
// 強制終了では走らず、Electron が掴んでいる間は消し残す。
//
// 判断は純粋な関数に置く（`src/test-support/e2e-stale-userdata.test.ts`）。消してよいのは次を全部満たす
// ものだけ。迷ったら消さない。
//   - 名前が `tmap-e2e-userdata-` で始まるか、E2E のコードが作ると確かめた頭（{@link E2E_SCRATCH_PREFIXES}）に
//     `mkdtempSync` の 6 文字が続くだけのもの（作り手の分からない `gimoza-b114-probe-Xv1lCE` などは消さない）
//   - 更新が 1 日より古い
//   - 動いている Electron のコマンドラインに名前が出てこない
//   - プロセスの一覧を読めた

export const STALE_USERDATA_PREFIX = 'tmap-e2e-userdata-';
export const STALE_USERDATA_AGE_MS = 24 * 60 * 60 * 1000;

/** E2E のコードが `mkdtempSync` で作る作業用フォルダの頭（実データの写しや保存の検査の置き場）。 */
export const E2E_SCRATCH_PREFIXES: readonly string[] = [
  'gimoza-b102-',
  'gimoza-b105-',
  'gimoza-b112-',
  'gimoza-b114-',
  'gimoza-b90-',
  'gimoza-basemap-seam-',
  'gimoza-drag-conflict-',
  'gimoza-drag-year-',
  'gimoza-load-gate-',
  'gimoza-move-tool-',
  'gimoza-ring-conflict-',
];

const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

/** E2E が残したものとして片付けの対象にしてよい名前か。 */
export function isE2eTempName(name: string): boolean {
  if (name.startsWith(STALE_USERDATA_PREFIX)) return true;
  return E2E_SCRATCH_PREFIXES.some(
    (prefix) => name.startsWith(prefix) && MKDTEMP_SUFFIX.test(name.slice(prefix.length)),
  );
}

export interface TempEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

/**
 * 消してよい名前を返す。`electronCommandLines` が null（プロセスの一覧を読めなかった）なら何も消さない。
 */
export function selectStaleUserData(input: {
  readonly entries: readonly TempEntry[];
  readonly nowMs: number;
  readonly electronCommandLines: readonly string[] | null;
}): readonly string[] {
  const { entries, nowMs, electronCommandLines } = input;
  if (electronCommandLines === null) return [];
  // Windows のパスは大文字と小文字を区別しない。
  const running = electronCommandLines.map((line) => line.toLowerCase());
  return entries
    .filter(
      (entry) =>
        isE2eTempName(entry.name) &&
        nowMs - entry.mtimeMs > STALE_USERDATA_AGE_MS &&
        !running.some((line) => line.includes(entry.name.toLowerCase())),
    )
    .map((entry) => entry.name);
}

/** 読めた印。これが最後に無い出力は、途中で失敗したものとして扱う。 */
export const PROCESS_LISTING_END = '---end-of-listing---';

/**
 * プロセスの一覧を読むコマンドの出力を解く。読めなかったら null。
 *
 * 他の利用者や管理者のプロセスはコマンドラインが読めず空になる。空の行は「名前が出てこない」と区別できない
 * ので、1 行でもあれば読めなかった扱いにする（{@link listElectronCommandLines} が 1 プロセス 1 行で出す）。
 */
export function parseProcessListing(stdout: string): readonly string[] | null {
  const lines = stdout.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (lines.pop()?.trim() !== PROCESS_LISTING_END) return null;
  if (lines.some((line) => line.trim() === '')) return null;
  return lines;
}

/** 片付けの結果の 1 行。 */
export function staleUserDataSummary(removed: number, listingReadable: boolean): string {
  return listingReadable
    ? `[e2e] 古い一時フォルダ（${STALE_USERDATA_PREFIX}* と E2E の作業用）を ${String(removed)} 個消しました。`
    : `[e2e] プロセスの一覧を読めなかったので、古い一時フォルダ（${STALE_USERDATA_PREFIX}* と E2E の作業用）を消しません。`;
}
