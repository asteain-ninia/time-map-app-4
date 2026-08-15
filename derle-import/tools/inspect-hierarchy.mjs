// .gimoza の階層（集約地物と子の数）を一覧する。
//
// 実データでは デーレ共和国・正統ノル王国・ラヴィエンド・ウィル同君王国 の 3 つが集約で、
// フル版と間引き版で子の数が一致していること が正しい状態。ずれていたら、間引きの過程で
// 面の所属が変わっている（過去に実際に起きた不具合）。
//
// 実行: node derle-import/tools/inspect-hierarchy.mjs derle-import/derle-world-full.gimoza [...]

import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('.gimoza のパスを 1 つ以上指定してください。');
  process.exit(1);
}

for (const path of paths) {
  const zip = unzipSync(new Uint8Array(readFileSync(path)));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));

  // 地物は履歴 → 錨 → スナップショットの中にある。集約は子と同じスナップショットに同梱される
  // ので、同じ地物が複数回出てくる。id で畳んでから数える。
  const byId = new Map();
  for (const history of manifest.histories) {
    for (const entry of history.entries ?? []) {
      for (const feature of entry.anchor?.snapshot?.features ?? []) byId.set(feature.id, feature);
    }
  }
  const childCount = new Map();
  for (const feature of byId.values()) {
    if (feature.parentId) childCount.set(feature.parentId, (childCount.get(feature.parentId) ?? 0) + 1);
  }
  const aggregates = [...byId.values()].filter((f) => f.kind === 'aggregate');

  console.log(`${path}`);
  console.log(`  履歴 ${manifest.histories.length} / 地物 ${byId.size} / 集約 ${aggregates.length}`);
  for (const aggregate of aggregates) {
    const name = aggregate.attributes?.name ?? '(名前なし)';
    console.log(`   ${aggregate.id} ${name} — 子 ${childCount.get(aggregate.id) ?? 0}`);
  }
}
