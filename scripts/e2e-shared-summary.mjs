// `npm run e2e:shared` の終わりの集計。記録（e2e/shared-launch.ts が書く）を読むだけで、
// Playwright を動かさずに確かめられる（src/test-support/e2e-shared-summary.test.ts）。

/**
 * 記録の文字列を集計する。`runId` の実行の分だけを数える（記録の置き場を変えて追記が残っていても、
 * 前の実行の閉じ忘れで今回を赤にしない）。
 */
export function summarizeLaunchLog(text, runId) {
  const records = text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
    .filter((record) => record.run === runId);
  const launches = records.filter((r) => r.ev === 'launch');
  const reused = launches.filter((r) => r.kind === 'reused').length;
  const byKey = new Map();
  for (const record of records) {
    if (record.ev !== 'checkin') continue;
    // 1 本が同じ種類の項目を幾つ残しても 1 本と数える（窓の大きさは全体・幅・高さの 3 項目ある）。
    const groups = new Set(
      Object.keys(record.left).map((key) => key.replace(/\.\d+\..*$/, '').replace(/^(driver\.\w+)\..*$/, '$1')),
    );
    for (const group of groups) byKey.set(group, (byKey.get(group) ?? 0) + 1);
  }
  // 失敗した検査が閉じられなかった分は数えない（その検査はすでに赤）。
  const notClosed = records.filter((r) => r.ev === 'not-closed' && r.ownerFailed !== true);
  const closeFailed = records.filter((r) => r.ev === 'close-failed');
  return {
    reused,
    started: launches.length - reused,
    leftByGroup: [...byKey].sort((a, b) => b[1] - a[1]),
    notClosed,
    closeFailed,
    problemCount: notClosed.length + closeFailed.length,
  };
}

/** 検査の結果と、閉じ忘れ・終了の失敗の件数から、終了コードを決める。 */
export function exitCodeFor(status, problemCount) {
  if (status === null || status === undefined) return 1;
  if (status !== 0) return status;
  return problemCount > 0 ? 1 : 0;
}
