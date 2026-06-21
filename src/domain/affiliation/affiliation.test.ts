// U28 — 所属変更フローの単体テスト。受け入れ基準 1〜7 を「入力状態 → フロー呼び出し
// → 期待結果状態」で検証する。操作種別の対応表 (FR-46) を種別ごとのケースで固定し、
// 別 UI を設けない (同一フローのパラメータ違い) ことを証明する。

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createVertex, createVertexStore } from '../vertex';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  isTopLevel,
  type Feature,
} from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createIdGeneratorState } from '../id-generator';
import { buildForest, descendantIds, hasChildren, type Forest } from '../hierarchy/forest';
import { validateHierarchy } from '../hierarchy/validate';

import {
  AFFILIATION_REJECT,
  allowedParentCandidates,
  isLegalNewParent,
} from './candidates';
import {
  parentCreateWithTerminal,
  parentExisting,
  parentNone,
  CREATE_TERMINAL,
} from './decision';
import {
  AFFILIATION_STATUS,
  buildAffiliationProposal,
  buildAffiliationProposalForTargets,
  resolveTargetLeaves,
  type AffiliationProposal,
  type BuildProposalOptions,
} from './proposal';
import { createAffiliationCommand } from './command';

import { asAggregate, directChildIds } from '../hierarchy/forest';
import { referencesInAnchor } from '../deletion/eligibility';
import { serialize, type DomainProject } from '../persistence/serialize';
import { parseManifest, PARSE_OUTCOME } from '../persistence';
import { singleAnchorHistory, DEFAULT_SETTINGS, DEFAULT_BASEMAP } from '../persistence/fixtures';

// --- fixtures ---------------------------------------------------------------

const fid = (s: string): FeatureId => asFeatureId(s);
const ATTRS = (name: string, s = 0, e = 100): ReturnType<typeof createBasicAttributes> =>
  createBasicAttributes(name, s, e);
const COLOR = createColorInfo(true, '#111', '#222', '#333');

function leaf(id: string, name = id, s = 0, e = 100, parent?: string): Feature {
  const ring = createTerritoryRing(asRingId(`${id}-r`), [asVertexId(`${id}-v`)]);
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  return createLeafFeature(fid(id), ATTRS(name, s, e), COLOR, createShape([ring]), optional);
}

function agg(id: string, name = id, s = 0, e = 100, parent?: string): Feature {
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  return createAggregateFeature(fid(id), ATTRS(name, s, e), COLOR, [], optional);
}

// --- 形状=和 検査用 (vertexStore あり): 矩形リングを持つ末端 + 頂点ストア ------
//
// 単一頂点リング (上の leaf) は退化形状なので、形状=和 検査では使えない。ここでは
// 各末端に 4 頂点の矩形を与え、共有しない別座標に置くことで隙間なし検査を通す。

function squareLeaf(
  id: string,
  ox: number,
  oy: number,
  s = 0,
  e = 100,
  parent?: string,
): { feature: Feature; vertices: ReturnType<typeof createVertex>[] } {
  const vids = [0, 1, 2, 3].map((i) => asVertexId(`${id}-v${i}`));
  const coords = [
    createCoordinate(ox, oy),
    createCoordinate(ox + 1, oy),
    createCoordinate(ox + 1, oy + 1),
    createCoordinate(ox, oy + 1),
  ];
  const vertices = vids.map((vid, i) => createVertex(vid, coords[i] as ReturnType<typeof createCoordinate>));
  const ring = createTerritoryRing(asRingId(`${id}-r`), vids);
  const optional = parent === undefined ? {} : { parentId: fid(parent) };
  const feature = createLeafFeature(fid(id), ATTRS(id, s, e), COLOR, createShape([ring]), optional);
  return { feature, vertices };
}

let clock = 1;
const now = (): number => clock++;

function opts(extra: Partial<BuildProposalOptions> = {}): BuildProposalOptions {
  return { idState: createIdGeneratorState(0, 0), now, ...extra };
}

function expectProposal(r: ReturnType<typeof buildAffiliationProposal>): AffiliationProposal {
  if (r.status !== 'proposal') {
    throw new Error(`expected proposal, got rejected: ${JSON.stringify(r)}`);
  }
  return r.proposal;
}

function parentOf(features: readonly Feature[], id: string): FeatureId | undefined {
  return features.find((f) => f.id === fid(id))?.parentId;
}

// --- 受け入れ基準 1: 単一フローで全操作種別を表現・別 UI を設けない (FR-46) ----

describe('受け入れ基準1: 単一フローで全操作種別 (対応表)', () => {
  it('割譲: 末端を別の既存上位領域へ (existing)', () => {
    // P(親A) ← child, P2(親B) を別に用意。child を A から B へ割譲。
    const features = [agg('A'), agg('B'), leaf('child', 'child', 0, 100, 'A')];
    const r = buildAffiliationProposal(features, fid('child'), parentExisting(fid('B')), opts());
    const p = expectProposal(r);
    expect(parentOf(p.nextFeatures, 'child')).toBe(fid('B'));
  });

  it('帰属: 最上位の地物を既存上位領域の下へ (existing, top→nested)', () => {
    const features = [agg('A'), leaf('top', 'top', 0, 100)];
    expect(isTopLevel(features[1] as Feature)).toBe(true);
    const r = buildAffiliationProposal(features, fid('top'), parentExisting(fid('A')), opts());
    const p = expectProposal(r);
    const moved = p.nextFeatures.find((f) => f.id === fid('top')) as Feature;
    expect(moved.parentId).toBe(fid('A'));
    expect(isTopLevel(moved)).toBe(false);
  });

  it('独立: 対象を親なし＝最上位へ (none)', () => {
    const features = [agg('A'), leaf('child', 'child', 0, 100, 'A'), leaf('sib', 'sib', 0, 100, 'A')];
    const r = buildAffiliationProposal(features, fid('child'), parentNone, opts());
    const p = expectProposal(r);
    const moved = p.nextFeatures.find((f) => f.id === fid('child')) as Feature;
    expect(moved.parentId).toBeUndefined();
    expect(isTopLevel(moved)).toBe(true);
  });

  it('直轄化: 中間集約を抜かして対象の上位領域へ (existing=祖父)', () => {
    // root ⊃ mid ⊃ leaf。leaf を root へ直接 (mid を抜かす)。
    const features = [agg('root'), agg('mid', 'mid', 0, 100, 'root'), leaf('leaf', 'leaf', 0, 100, 'mid')];
    const r = buildAffiliationProposal(features, fid('leaf'), parentExisting(fid('root')), opts());
    const p = expectProposal(r);
    expect(parentOf(p.nextFeatures, 'leaf')).toBe(fid('root'));
  });

  it('解体: 集約の全下位領域を親なしへ → 元集約が自動消滅', () => {
    const features = [agg('A'), leaf('c1', 'c1', 0, 100, 'A'), leaf('c2', 'c2', 0, 100, 'A')];
    const r = buildAffiliationProposal(features, fid('A'), parentNone, opts());
    const p = expectProposal(r);
    // 全下位領域が親なしへ。
    expect(parentOf(p.nextFeatures, 'c1')).toBeUndefined();
    expect(parentOf(p.nextFeatures, 'c2')).toBeUndefined();
    // 元集約 A は全下位領域消失で自動消滅 (結果状態判定, 教訓5.6)。
    expect(p.nextFeatures.find((f) => f.id === fid('A'))).toBeUndefined();
    expect(p.deletedIds).toContain(fid('A'));
  });

  it('連邦化: 複数最上位を共通の新規最上位の下位へ (create→NewTop, 複数対象)', () => {
    // s1, s2 は相互に無関係な最上位。共通の新規最上位 Fed を **1 度だけ** 生成し、
    // 両者をその下へ束ねる。確定後 Fed が唯一のルートになることを固定する (基準 2)。
    const features = [leaf('s1', 's1', 0, 100), leaf('s2', 's2', 0, 100)];
    const decision = parentCreateWithTerminal({ name: '連邦' }, { kind: CREATE_TERMINAL.NewTop });
    const r = buildAffiliationProposalForTargets(features, [fid('s1'), fid('s2')], decision, opts());
    const p = expectProposal(r);
    // 新規最上位は 1 件だけ (各対象ごとに別集約を作らない)。
    expect(p.createdIds.length).toBe(1);
    const fed = p.createdIds[0] as FeatureId;
    // 全対象が Fed の下位領域になる。
    expect(parentOf(p.nextFeatures, 's1')).toBe(fed);
    expect(parentOf(p.nextFeatures, 's2')).toBe(fed);
    // Fed が唯一のルート: nextFeatures の最上位が Fed ただ 1 件。
    const roots = p.nextFeatures.filter((f) => isTopLevel(f)).map((f) => f.id);
    expect(roots).toEqual([fed]);
  });
});

// --- 受け入れ基準 2: 新規上位領域作成サブフロー・中間階層の再帰挿入 (FR-47) -----

describe('受け入れ基準2: 新規上位領域作成サブフロー (FR-47)', () => {
  it('自治化: 既存上位領域と既存下位領域の間に新規中間集約を後付け挿入', () => {
    // root ⊃ leaf。leaf と root の間に新規中間集約 mid を挿入 (ExistingTop=root)。
    const features = [agg('root'), leaf('leaf', 'leaf', 0, 100, 'root')];
    const decision = parentCreateWithTerminal(
      { name: '自治領', kindLabel: '州' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('root') },
    );
    const r = buildAffiliationProposal(features, fid('leaf'), decision, opts());
    const p = expectProposal(r);
    expect(p.createdIds.length).toBe(1);
    const mid = p.createdIds[0] as FeatureId;
    // leaf → mid → root の中間挿入。
    expect(parentOf(p.nextFeatures, 'leaf')).toBe(mid);
    expect(parentOf(p.nextFeatures, mid as unknown as string)).toBe(fid('root'));
  });

  it('上位領域を2段以上再帰的に積み上げる (中間階層複数段)', () => {
    const features = [leaf('leaf', 'leaf', 0, 100)];
    // leaf → L1 → L2(最上位)。
    const decision = parentCreateWithTerminal(
      { name: 'L1' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('__placeholder__') },
    );
    // placeholder を使わず、2段の create を手動で組む。
    const twoLevels = {
      kind: 'create' as const,
      spec: { name: 'L1' },
      above: {
        kind: 'create' as const,
        spec: { name: 'L2' },
        above: parentNone,
      },
    };
    void decision;
    const r = buildAffiliationProposal(features, fid('leaf'), twoLevels, opts());
    const p = expectProposal(r);
    expect(p.createdIds.length).toBe(2);
    // leaf の親 = L1、L1 の親 = L2、L2 は最上位。
    const l1 = parentOf(p.nextFeatures, 'leaf') as FeatureId;
    const l2 = parentOf(p.nextFeatures, l1 as unknown as string) as FeatureId;
    expect(l1).toBeDefined();
    expect(l2).toBeDefined();
    const l2Feature = p.nextFeatures.find((f) => f.id === l2) as Feature;
    expect(isTopLevel(l2Feature)).toBe(true);
  });

  it('連邦化: 複数最上位に共通の新規最上位を割り当てると新規最上位が唯一のルート', () => {
    // 3 つの無関係な最上位 s1, s2, s3 を共通の新規最上位 Fed の下へ束ねる。
    // 確定後: 全対象が Fed の下位、Fed が唯一のルート (基準 2 の中核)。
    const features = [
      leaf('s1', 's1', 0, 100),
      leaf('s2', 's2', 0, 100),
      leaf('s3', 's3', 0, 100),
    ];
    const decision = parentCreateWithTerminal({ name: '連邦' }, { kind: CREATE_TERMINAL.NewTop });
    const r = buildAffiliationProposalForTargets(
      features,
      [fid('s1'), fid('s2'), fid('s3')],
      decision,
      opts(),
    );
    const p = expectProposal(r);
    expect(p.createdIds.length).toBe(1); // 新規最上位は 1 度だけ生成。
    const fed = p.createdIds[0] as FeatureId;
    for (const s of ['s1', 's2', 's3']) {
      expect(parentOf(p.nextFeatures, s)).toBe(fed);
    }
    const roots = p.nextFeatures.filter((f) => isTopLevel(f)).map((f) => f.id);
    expect(roots).toEqual([fed]); // Fed が唯一のルート。
  });

  it('連邦化: 集約対象を含む複数対象を展開して共通新規最上位へ束ねる', () => {
    // A は集約 (c1,c2 を持つ)、s1 は最上位末端。両者を共通の新規最上位 Fed へ。
    // A は展開され c1,c2 が Fed 直下へ。A は全下位を失い自動消滅。
    const features = [
      agg('A', 'A', 0, 100),
      leaf('c1', 'c1', 0, 100, 'A'),
      leaf('c2', 'c2', 0, 100, 'A'),
      leaf('s1', 's1', 0, 100),
    ];
    const decision = parentCreateWithTerminal({ name: '連邦' }, { kind: CREATE_TERMINAL.NewTop });
    const r = buildAffiliationProposalForTargets(features, [fid('A'), fid('s1')], decision, opts());
    const p = expectProposal(r);
    const fed = p.createdIds[0] as FeatureId;
    expect(parentOf(p.nextFeatures, 'c1')).toBe(fed);
    expect(parentOf(p.nextFeatures, 'c2')).toBe(fed);
    expect(parentOf(p.nextFeatures, 's1')).toBe(fed);
    expect(p.deletedIds).toContain(fid('A')); // 元集約は全下位消失で自動消滅。
    const roots = p.nextFeatures.filter((f) => isTopLevel(f)).map((f) => f.id);
    expect(roots).toEqual([fed]);
  });
});

// --- 受け入れ基準 3: 循環参照防止と存在期間整合 (FR-48) ----------------------

describe('受け入れ基準3: 循環参照防止・存在期間整合 (FR-48)', () => {
  it('対象自身を新上位領域に指定すると拒否され状態不変', () => {
    const features = [leaf('a', 'a', 0, 100)];
    const r = buildAffiliationProposal(features, fid('a'), parentExisting(fid('a')), opts());
    expect(r.status).toBe(AFFILIATION_STATUS.Rejected);
    if (r.status === AFFILIATION_STATUS.Rejected) {
      expect(r.kind).toBe(AFFILIATION_REJECT.SameFeature);
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('対象の下位領域 (孫含む) を新上位領域に指定すると拒否 (循環防止)', () => {
    // b ⊃ c ⊃ gc。b は集約なので展開され c が対象になる。c の新親に gc (c の孫=
    // 下位領域) を指定 → 循環。descendantIds が孫まで見て拒否することを検証。
    const features = [
      agg('b'),
      agg('c', 'c', 0, 100, 'b'),
      leaf('gc', 'gc', 0, 100, 'c'),
    ];
    const r = buildAffiliationProposal(features, fid('b'), parentExisting(fid('gc')), opts());
    expect(r.status).toBe(AFFILIATION_STATUS.Rejected);
    if (r.status === AFFILIATION_STATUS.Rejected) expect(r.kind).toBe(AFFILIATION_REJECT.Cycle);
  });

  it('対象の上位領域への直轄化は許可される (FR-48 例外, 教訓5.25)', () => {
    const features = [agg('root'), agg('mid', 'mid', 0, 100, 'root'), leaf('leaf', 'leaf', 0, 100, 'mid')];
    const forest = buildForest(features);
    // 上位領域 root は候補に含まれる。
    expect(isLegalNewParent(forest, fid('leaf'), fid('root')).ok).toBe(true);
    const candidates = allowedParentCandidates(forest, fid('leaf')).map((c) => c.featureId);
    expect(candidates).toContain(fid('root'));
  });

  it('存在期間が両立しない候補は拒否', () => {
    const features = [leaf('a', 'a', 0, 50), leaf('b', 'b', 100, 200)];
    const r = buildAffiliationProposal(features, fid('a'), parentExisting(fid('b')), opts());
    expect(r.status).toBe(AFFILIATION_STATUS.Rejected);
    if (r.status === AFFILIATION_STATUS.Rejected) {
      expect(r.kind).toBe(AFFILIATION_REJECT.ExistencePeriod);
    }
  });

  it('create→ExistingTop: 生成中間集約と既存最上位の存在期間不整合を確定前に拒否', () => {
    // leaf(0-50) を、既存最上位 root(1000-2000) の下へ新規中間集約 (期間=対象包絡
    // 0-50) を挟んで接続する。leaf-vs-newAgg は両立するが、newAgg(0-50) と
    // root(1000-2000) は重ならない → 確定前検証で拒否されなければならない (基準 3 /
    // FR-48: 親領域=下位の和を将来満たせる位置にない)。
    const features = [agg('root', 'root', 1000, 2000), leaf('leaf', 'leaf', 0, 50)];
    const decision = parentCreateWithTerminal(
      { name: '自治領' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('root') },
    );
    const r = buildAffiliationProposal(features, fid('leaf'), decision, opts());
    expect(r.status).toBe(AFFILIATION_STATUS.Rejected);
    if (r.status === AFFILIATION_STATUS.Rejected) {
      expect(r.kind).toBe(AFFILIATION_REJECT.ExistencePeriod);
    }
  });

  it('create→ExistingTop: 存在期間が両立する場合は受理 (中間挿入が成立)', () => {
    const features = [agg('root', 'root', 0, 100), leaf('leaf', 'leaf', 10, 50)];
    const decision = parentCreateWithTerminal(
      { name: '自治領' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('root') },
    );
    const r = buildAffiliationProposal(features, fid('leaf'), decision, opts());
    const p = expectProposal(r);
    const mid = p.createdIds[0] as FeatureId;
    expect(parentOf(p.nextFeatures, 'leaf')).toBe(mid);
    expect(parentOf(p.nextFeatures, mid as unknown as string)).toBe(fid('root'));
  });

  it('許可候補算出と確定前検証が同一述語 (UI を経由しない直接呼び出しでも拒否)', () => {
    const features = [leaf('a', 'a', 0, 100), leaf('self-child', 'sc', 0, 100, 'a'), agg('a')];
    // a の子 sc は候補から除外される。直接 buildAffiliationProposal でも拒否。
    const forest = buildForest([agg('a'), leaf('sc', 'sc', 0, 100, 'a')]);
    const candidates = allowedParentCandidates(forest, fid('a')).map((c) => c.featureId);
    expect(candidates).not.toContain(fid('sc')); // 子は候補外。
    void features;
    const r = buildAffiliationProposal(
      [agg('a'), leaf('sc', 'sc', 0, 100, 'a')],
      fid('a'),
      parentExisting(fid('sc')),
      opts(),
    );
    expect(r.status).toBe(AFFILIATION_STATUS.Rejected);
  });

  it('循環を含む壊れた入力でも候補算出が有限に終わる (教訓5.28)', () => {
    // x ↔ y (相互親)。descendantIds の visited で有限終了。
    const x = createAggregateFeature(fid('x'), ATTRS('x'), COLOR, [], { parentId: fid('y') });
    const y = createAggregateFeature(fid('y'), ATTRS('y'), COLOR, [], { parentId: fid('x') });
    const forest = buildForest([x, y]);
    expect(() => allowedParentCandidates(forest, fid('x'))).not.toThrow();
  });

  // Regression (bughunt): a名称未設定の候補上位領域 (the add form's default — empty
  // name) must not surface as a blank, sight-unselectable row in the所属変更候補
  // list. The displayName falls back to the feature id (featureDisplayName), never ''.
  it('名称未設定の候補上位領域に空でない表示名 (id フォールバック) を与える', () => {
    const target = leaf('t', 'target', 0, 100);
    const unnamedParent = leaf('p', '   ', 0, 100); // present-but-blank name
    const forest = buildForest([target, unnamedParent]);
    const cands = allowedParentCandidates(forest, fid('t'));
    const p = cands.find((c) => c.featureId === fid('p'));
    expect(p).toBeDefined();
    expect(p?.displayName.trim().length).toBeGreaterThan(0);
    expect(p?.displayName).toBe('p');
  });

  // Regression (bughunt3): allowedParentCandidates は候補ごとに isLegalNewParent を呼び、
  // 旧実装は各呼び出しで対象の子孫を descendantIds で再走査していた (O(n) DFS × n 候補
  // = O(n²); 5,000 地物で 2,500 万ステップ, ピッカー開閉と確定前再検証の度に UI を阻害)。
  // 修正: 対象の子孫集合をループ前に 1 回だけ算出し Set で O(1) 判定に渡す。
  //
  // 本テストは「対象の子孫走査がループ全体で 1 回だけ」を機械的に固定する。descendantIds は
  // directChildIds(forest, id) 経由で forest.childrenOf.get(id) を引く。対象 id への .get 回数を
  // 数え、候補数 n に依存せず 1 回であることを検証する (O(n²) 退化への回帰ガード)。受け入れ基準 6。
  it('一覧算出は対象の子孫を候補ごとに再走査しない (O(n²) 退化への回帰ガード, 基準6)', () => {
    // 対象 t と、t の子孫でない兄弟候補を多数 (循環でない正常な森)。
    const n = 200;
    const target = agg('t', 't', 0, 100);
    const siblings: Feature[] = [];
    for (let i = 0; i < n; i += 1) siblings.push(agg(`s${i}`, `s${i}`, 0, 100));
    const base = buildForest([target, ...siblings]);

    // childrenOf.get の呼び出しを id 別に数える計測用ラッパ。森の派生結果は base と同一。
    const getCounts = new Map<FeatureId, number>();
    const countingChildrenOf: ReadonlyMap<FeatureId, readonly FeatureId[]> = {
      get(id: FeatureId) {
        getCounts.set(id, (getCounts.get(id) ?? 0) + 1);
        return base.childrenOf.get(id);
      },
      has: (id: FeatureId) => base.childrenOf.has(id),
      get size() {
        return base.childrenOf.size;
      },
      forEach: base.childrenOf.forEach.bind(base.childrenOf),
      entries: base.childrenOf.entries.bind(base.childrenOf),
      keys: base.childrenOf.keys.bind(base.childrenOf),
      values: base.childrenOf.values.bind(base.childrenOf),
      [Symbol.iterator]: base.childrenOf[Symbol.iterator].bind(base.childrenOf),
    } as ReadonlyMap<FeatureId, readonly FeatureId[]>;
    const measured: Forest = { ...base, childrenOf: countingChildrenOf };

    const candidates = allowedParentCandidates(measured, fid('t')).map((c) => c.featureId);

    // 正しさ: 自身を除く全候補が合法 (子孫でなく存在期間も両立)。
    expect(candidates).toHaveLength(n);
    expect(candidates).not.toContain(fid('t'));

    // 性能形状: 対象 t の子孫走査 (childrenOf.get('t')) はループ全体で 1 回のみ。
    // 旧 O(n²) 実装では候補数 n 回 (= n+? ) 引かれていた。
    expect(getCounts.get(fid('t'))).toBe(1);
  });

  // Regression (bughunt3): 事前計算した子孫集合を渡す経路と、内部で算出する単発経路は
  // 同一述語でなければならない (教訓 5.26 単一の真実源)。両経路の判定が全候補で一致する。
  it('isLegalNewParent: 事前計算子孫集合の経路と単発経路の判定が完全一致 (教訓5.26)', () => {
    const features = [
      agg('root', 'root', 0, 100),
      agg('mid', 'mid', 0, 100, 'root'),
      leaf('leaf', 'leaf', 0, 100, 'mid'),
      agg('other', 'other', 0, 100),
      leaf('past', 'past', 200, 300), // 存在期間不整合候補。
    ];
    const forest = buildForest(features);
    const target = fid('root');
    const precomputed = new Set(descendantIds(forest, target));
    for (const id of forest.orderedIds) {
      const withSet = isLegalNewParent(forest, target, id, precomputed);
      const without = isLegalNewParent(forest, target, id);
      expect(withSet).toEqual(without);
    }
  });
});

// --- 受け入れ基準 4: 飛び地化を許容 (FR-49) ----------------------------------

describe('受け入れ基準4: 飛び地化を許容 (FR-49)', () => {
  it('地理的に離れた既存上位領域への所属を拒否しない', () => {
    // 陸続き判定を合否条件にしない: 座標が離れていても拒否されない。
    const far1 = leaf('far1', 'far1', 0, 100);
    const child = leaf('child', 'child', 0, 100);
    const parent = agg('P');
    const r = buildAffiliationProposal([far1, child, parent], fid('child'), parentExisting(fid('P')), opts());
    expect(r.status).toBe('proposal'); // 拒否されない。
  });
});

// --- 受け入れ基準 5: 末端のみ・集約は全下位展開・1アンドゥ・確定後整合 ---------

describe('受け入れ基準5: 対象限定・複数対象展開・単一アンドゥ・整合性 (FR-48/FR-94)', () => {
  it('集約が対象なら全下位領域へ展開され一括適用 (集約自身は直接張り替えない)', () => {
    const features = [agg('A'), agg('B'), leaf('c1', 'c1', 0, 100, 'A'), leaf('c2', 'c2', 0, 100, 'A')];
    const leaves = resolveTargetLeaves(features, fid('A'));
    expect(leaves).toEqual([fid('c1'), fid('c2')]);
    const r = buildAffiliationProposal(features, fid('A'), parentExisting(fid('B')), opts());
    const p = expectProposal(r);
    expect(parentOf(p.nextFeatures, 'c1')).toBe(fid('B'));
    expect(parentOf(p.nextFeatures, 'c2')).toBe(fid('B'));
  });

  it('末端/集約の判別が結果状態 (下位領域の有無) で行われる (教訓5.6)', () => {
    const features = [agg('A'), leaf('solo', 'solo', 0, 100)];
    const forest = buildForest(features);
    expect(hasChildren(forest, fid('solo'))).toBe(false);
    expect(resolveTargetLeaves(features, fid('solo'))).toEqual([fid('solo')]);
  });

  it('全下位領域を失った集約が自動消滅し連鎖剪定される (教訓5.21)', () => {
    // grand ⊃ A ⊃ c。c を親なしへ。A が空 → 消滅、grand も空 → 連鎖消滅。
    const features = [agg('grand'), agg('A', 'A', 0, 100, 'grand'), leaf('c', 'c', 0, 100, 'A')];
    const r = buildAffiliationProposal(features, fid('c'), parentNone, opts());
    const p = expectProposal(r);
    expect(p.deletedIds).toContain(fid('A'));
    expect(p.deletedIds).toContain(fid('grand'));
    expect(p.nextFeatures.map((f) => f.id)).toEqual([fid('c')]);
  });

  it('単一アンドゥ単位コマンド: 1回の undo で全復元、redo で ID 再採番なし', () => {
    const baseline = [agg('A'), agg('B'), leaf('child', 'child', 0, 100, 'A')];
    const r = buildAffiliationProposal(baseline, fid('child'), parentExisting(fid('B')), opts());
    const p = expectProposal(r);
    const cmd = createAffiliationCommand(baseline, p);
    const afterExec = cmd.execute(baseline);
    expect(parentOf(afterExec.state, 'child')).toBe(fid('B'));
    const afterUndo = cmd.undo(afterExec.state);
    expect(parentOf(afterUndo.state, 'child')).toBe(fid('A')); // 全復元。
    const afterRedo = cmd.redo(afterUndo.state);
    expect(afterRedo.state).toBe(p.nextFeatures); // 同一参照 = 再採番なし。
  });

  it('確定後の状態が U08 の全不変条件を満たす', () => {
    const features = [agg('A'), agg('B'), leaf('c', 'c', 0, 100, 'A')];
    const r = buildAffiliationProposal(features, fid('c'), parentExisting(fid('B')), opts());
    const p = expectProposal(r);
    expect(validateHierarchy(p.nextFeatures).ok).toBe(true);
  });

  it('vertexStore 指定で確定後検証が形状=和・隙間なし検査まで実行する (基準 5 中核)', () => {
    // 矩形末端 c を集約 B の下へ移す。vertexStore を渡すと validateHierarchy が
    // checkAggregateShapes (形状=和・隙間なし) を実行する。単一子なので隙間なし → 受理。
    const A = squareLeaf('Ahost', 0, 0); // ダミー: 末端 c を一旦どこかに置く
    void A;
    const c = squareLeaf('c', 5, 5, 0, 100, 'A');
    const features = [agg('A'), agg('B'), c.feature];
    const store = createVertexStore(c.vertices);
    const r = buildAffiliationProposal(
      features,
      fid('c'),
      parentExisting(fid('B')),
      opts({ vertexStore: store }),
    );
    const p = expectProposal(r);
    // 確定後状態を vertexStore 付きで再検証しても ok (形状検査込みで全不変条件を満たす)。
    expect(validateHierarchy(p.nextFeatures, { vertexStore: store }).ok).toBe(true);
    expect(parentOf(p.nextFeatures, 'c')).toBe(fid('B'));
  });

  it('vertexStore 指定で形状解決不能 (頂点欠落) を確定前に検出して拒否する', () => {
    // c の頂点をストアに入れない → 形状解決失敗 → checkAggregateShapes が
    // ShapeUnresolved を出す。vertexStore を渡さない旧挙動では位相のみ検査で通って
    // しまうが、渡すと形状検査が走り 'hierarchy' で拒否されることを固定する。
    const c = squareLeaf('c', 5, 5, 0, 100, 'A');
    const features = [agg('A'), agg('B'), c.feature];
    const emptyStore = createVertexStore([]); // c の頂点が無い。

    // 形状検査なし (vertexStore 省略) では受理される (対比)。
    const without = buildAffiliationProposal(features, fid('c'), parentExisting(fid('B')), opts());
    expect(without.status).toBe('proposal');

    // 形状検査あり (vertexStore 指定) では形状解決失敗で拒否される。
    const withStore = buildAffiliationProposal(
      features,
      fid('c'),
      parentExisting(fid('B')),
      opts({ vertexStore: emptyStore }),
    );
    expect(withStore.status).toBe(AFFILIATION_STATUS.Rejected);
    if (withStore.status === AFFILIATION_STATUS.Rejected) {
      expect(withStore.kind).toBe('hierarchy');
    }
  });

  it('拒否時は入力データを破壊しない (部分適用なし)', () => {
    const features = [leaf('a', 'a', 0, 50), leaf('b', 'b', 100, 200)];
    const snapshot = JSON.stringify(features);
    buildAffiliationProposal(features, fid('a'), parentExisting(fid('b')), opts());
    expect(JSON.stringify(features)).toBe(snapshot);
  });
});

// --- 受け入れ基準 6: 結合との事前条件分離 (教訓 5.27) ------------------------
//
// 結合 (FR-50〜52) は本ユニット対象外だが、所属変更の事前条件述語 (isLegalNewParent)
// が「結合固有の事前条件」を参照していない (別実装である) ことを固定する。結合の
// 固有条件は「互いに上位・下位関係にない (祖先/子孫関係にある相手は結合不可)」だが、
// 所属変更では **対象の上位領域 (祖先) は直轄化のため合法候補に含む** (FR-48 例外)。
// この振る舞いの差が、両者が同一述語を共有していないことの動かぬ証拠になる。

describe('受け入れ基準6: 結合との事前条件分離 (教訓5.27)', () => {
  it('所属変更述語は対象の上位領域 (祖先) を合法候補に含む (結合条件で誤拒否しない)', () => {
    // root ⊃ mid ⊃ leaf。leaf の祖先 root/mid は「祖先/子孫関係」にあるため、もし
    // 所属変更が結合固有条件 (互いに上位・下位関係にないこと) を流用していれば候補から
    // 除外されるはず。所属変更では直轄化のため祖先を候補に含む → 結合条件不参照の証拠。
    const features = [
      agg('root'),
      agg('mid', 'mid', 0, 100, 'root'),
      leaf('leaf', 'leaf', 0, 100, 'mid'),
    ];
    const forest = buildForest(features);
    // 祖先 root, mid はいずれも合法候補 (結合なら祖先/子孫関係で拒否される相手)。
    expect(isLegalNewParent(forest, fid('leaf'), fid('root')).ok).toBe(true);
    expect(isLegalNewParent(forest, fid('leaf'), fid('mid')).ok).toBe(true);
    const candidates = allowedParentCandidates(forest, fid('leaf')).map((c) => c.featureId);
    expect(candidates).toContain(fid('root'));
    expect(candidates).toContain(fid('mid'));
    // 一方、子孫 (循環になる側) は所属変更でも拒否される (固有条件は別実装で保持)。
    const features2 = [agg('p'), leaf('child', 'child', 0, 100, 'p')];
    const forest2 = buildForest(features2);
    expect(isLegalNewParent(forest2, fid('p'), fid('child')).ok).toBe(false);
  });

  it('所属変更の固有条件 (循環・存在期間) のみで判定し、結合の重なり等は参照しない', () => {
    // 同座標で重なる 2 末端でも所属変更は拒否されない (重なりは結合/U13 空間競合の話で
    // あり所属変更固有の事前条件ではない)。所属変更述語は循環・存在期間だけを見る。
    const a = leaf('a', 'a', 0, 100); // 同じ単一頂点を共有 → 形状的に重なるが…
    const p = agg('P');
    const forest = buildForest([a, p]);
    expect(isLegalNewParent(forest, fid('a'), fid('P')).ok).toBe(true); // 重なりで拒否しない。
  });
});

// --- 受け入れ基準 7: 純粋性・種別ラベル非関与・プロパティテスト (FR-40) ------

describe('受け入れ基準7: 純粋性・種別ラベル非関与', () => {
  it('同一入力に同一結果 (純粋性)', () => {
    const features = [agg('A'), agg('B'), leaf('c', 'c', 0, 100, 'A')];
    const o = (): BuildProposalOptions => ({ idState: createIdGeneratorState(0, 0), now: () => 5 });
    const r1 = expectProposal(buildAffiliationProposal(features, fid('c'), parentExisting(fid('B')), o()));
    const r2 = expectProposal(buildAffiliationProposal(features, fid('c'), parentExisting(fid('B')), o()));
    expect(r1.nextFeatures.map((f) => f.id)).toEqual(r2.nextFeatures.map((f) => f.id));
  });

  it('種別ラベルを変えても候補絞り込み・検証結果が変化しない (FR-40)', () => {
    const a = createLeafFeature(fid('a'), ATTRS('a'), COLOR, createShape([createTerritoryRing(asRingId('ar'), [asVertexId('av')])]), { kindLabel: '国' });
    const b = agg('b');
    const aOther = createLeafFeature(fid('a'), ATTRS('a'), COLOR, createShape([createTerritoryRing(asRingId('ar'), [asVertexId('av')])]), { kindLabel: '州' });
    const c1 = allowedParentCandidates(buildForest([a, b]), fid('a')).map((c) => c.featureId);
    const c2 = allowedParentCandidates(buildForest([aOther, b]), fid('a')).map((c) => c.featureId);
    expect(c1).toEqual(c2);
  });

  // --- fast-check: ランダム森に対する不変条件保存・偽陰性なし -----------------

  it('property: 合法な所属変更後も U08 の全不変条件が保たれる', () => {
    // ランダムな森 (最上位 + 各最上位に 0..2 個の末端子) を生成し、ランダムに選んだ
    // 末端を別の最上位へ割譲する。合法な割譲なら確定後 validateHierarchy が ok。
    fc.assert(
      fc.property(randomForestArb(), (forest) => {
        if (forest.roots.length < 2) return; // 移動先の別最上位が必要。
        const features = forest.features;
        const leafTarget = forest.leaves[0];
        if (leafTarget === undefined) return;
        // 対象末端の現在の親と異なる最上位を移動先にする。
        const target = features.find((f) => f.id === leafTarget) as Feature;
        const dest = forest.roots.find((rid) => rid !== target.parentId);
        if (dest === undefined) return;
        const r = buildAffiliationProposal(
          features,
          leafTarget,
          parentExisting(dest),
          { idState: createIdGeneratorState(0, 0), now: () => 1 },
        );
        if (r.status !== 'proposal') return; // 存在期間等で合法でなければスキップ。
        expect(validateHierarchy(r.proposal.nextFeatures).ok).toBe(true);
        expect(parentOf(r.proposal.nextFeatures, leafTarget as unknown as string)).toBe(dest);
      }),
      { numRuns: 100 },
    );
  });

  it('property: 違法な所属変更 (循環・自己) は必ず拒否される (偽陰性なし)', () => {
    fc.assert(
      fc.property(randomForestArb(), (forest) => {
        const features = forest.features;
        // (1) 末端対象自身を新親に → 必ず SameFeature 拒否。集約は全下位へ展開され
        //     「対象自身=親」は末端でしか成立しないため、末端 ID を対象に選ぶ。
        const leafId = forest.leaves[0];
        if (leafId === undefined) return;
        const selfR = buildAffiliationProposal(
          features,
          leafId,
          parentExisting(leafId),
          { idState: createIdGeneratorState(0, 0), now: () => 1 },
        );
        expect(selfR.status).toBe(AFFILIATION_STATUS.Rejected);

        // (2) 対象の子孫を新親に → 必ず循環で拒否。親 (子を持つ最上位) を対象に、
        //     その子を新親に指定する。
        const parentWithChild = forest.roots.find((rid) => forest.childOf.has(rid));
        if (parentWithChild !== undefined) {
          const child = forest.childOf.get(parentWithChild) as FeatureId;
          const cycleR = buildAffiliationProposal(
            features,
            parentWithChild,
            parentExisting(child),
            { idState: createIdGeneratorState(0, 0), now: () => 1 },
          );
          expect(cycleR.status).toBe(AFFILIATION_STATUS.Rejected);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// --- fast-check 用ランダム森生成 --------------------------------------------
//
// 期間を共通 (0..100) に固定して存在期間整合は常に両立させ、純粋に位相 (親子・循環)
// の不変条件保存／拒否を検証する。各最上位は集約 (子あり) または末端 (子なし)。

interface RandomForest {
  readonly features: Feature[];
  readonly roots: FeatureId[];
  readonly leaves: FeatureId[];
  readonly allIds: FeatureId[];
  /** 子を持つ最上位 → その最初の子。 */
  readonly childOf: ReadonlyMap<FeatureId, FeatureId>;
}

function randomForestArb(): fc.Arbitrary<RandomForest> {
  // 2..4 個の最上位、それぞれ 0..2 個の末端子。
  return fc
    .array(fc.nat({ max: 2 }), { minLength: 2, maxLength: 4 })
    .map((childCounts) => {
      const features: Feature[] = [];
      const roots: FeatureId[] = [];
      const leaves: FeatureId[] = [];
      const childOf = new Map<FeatureId, FeatureId>();
      childCounts.forEach((count, ri) => {
        const rootId = `r${ri}`;
        roots.push(fid(rootId));
        if (count === 0) {
          // 子なし最上位は末端として表現。
          features.push(leaf(rootId, rootId, 0, 100));
          leaves.push(fid(rootId));
        } else {
          features.push(agg(rootId, rootId, 0, 100));
          for (let ci = 0; ci < count; ci += 1) {
            const childId = `${rootId}c${ci}`;
            features.push(leaf(childId, childId, 0, 100, rootId));
            leaves.push(fid(childId));
            if (!childOf.has(fid(rootId))) childOf.set(fid(rootId), fid(childId));
          }
        }
      });
      const allIds = features.map((f) => f.id);
      return { features, roots, leaves, allIds, childOf };
    });
}

// --- 集約 childIds 同期の不変条件 (報告 blocking 修正の両側固定) ----------------
//
// U28 の内部検証は parentId を単一真実源とするため childIds 不整合でも素通りする。
// しかし persistence/serialize と deletion/eligibility は childIds を権威データとして
// 同期維持する不変条件を前提とする。U28 の出力 (nextFeatures) がこの不変条件を破ると
// 保存→読込でデータ破損、削除時に dangling 参照が残る。両側 (serialize 往復 /
// deletion eligibility) で childIds 同期を固定する。

/** nextFeatures の全集約 childIds が parentId 由来の子と完全一致するか検証する。 */
function expectChildIdsSyncedWithParentId(features: readonly Feature[]): void {
  const forest = buildForest(features);
  for (const f of features) {
    const aggregate = asAggregate(f);
    if (aggregate === undefined) continue;
    const derived = directChildIds(forest, aggregate.id);
    expect(aggregate.childIds).toEqual(derived);
  }
}

describe('報告 blocking: 集約 childIds がリパース後に同期される', () => {
  it('割譲で旧親集約から移動した子が childIds から除去される', () => {
    // A ⊃ child, B は別集約。child を A から B へ割譲。
    const features = [
      agg('A', 'A', 0, 100),
      agg('B', 'B', 0, 100),
      leaf('keep', 'keep', 0, 100, 'A'), // A に子を残し A が空にならないようにする。
      leaf('child', 'child', 0, 100, 'A'),
    ];
    const p = expectProposal(
      buildAffiliationProposal(features, fid('child'), parentExisting(fid('B')), opts()),
    );
    // 旧親 A の childIds から child が消え、新親 B の childIds に child が入る。
    const a = p.nextFeatures.find((f) => f.id === fid('A')) as Feature;
    const b = p.nextFeatures.find((f) => f.id === fid('B')) as Feature;
    expect(asAggregate(a)?.childIds).toEqual([fid('keep')]);
    expect(asAggregate(b)?.childIds).toEqual([fid('child')]);
    expectChildIdsSyncedWithParentId(p.nextFeatures);
  });

  it('新規生成集約 (自治化) の childIds に実子が設定される', () => {
    // root ⊃ leaf。leaf と root の間に新規中間集約 mid を挿入。
    const features = [agg('root', 'root', 0, 100), leaf('leaf', 'leaf', 0, 100, 'root')];
    const decision = parentCreateWithTerminal(
      { name: '自治領' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('root') },
    );
    const p = expectProposal(buildAffiliationProposal(features, fid('leaf'), decision, opts()));
    const mid = p.createdIds[0] as FeatureId;
    const midFeature = p.nextFeatures.find((f) => f.id === mid) as Feature;
    const rootFeature = p.nextFeatures.find((f) => f.id === fid('root')) as Feature;
    // 新規集約 mid の childIds = [leaf] (空のままではない)。
    expect(asAggregate(midFeature)?.childIds).toEqual([fid('leaf')]);
    // root の childIds は leaf → mid に張り替わる。
    expect(asAggregate(rootFeature)?.childIds).toEqual([mid]);
    expectChildIdsSyncedWithParentId(p.nextFeatures);
  });

  it('連邦化で新規最上位集約の childIds に全対象が入る', () => {
    const features = [leaf('s1', 's1', 0, 100), leaf('s2', 's2', 0, 100)];
    const decision = parentCreateWithTerminal({ name: '連邦' }, { kind: CREATE_TERMINAL.NewTop });
    const p = expectProposal(
      buildAffiliationProposalForTargets(features, [fid('s1'), fid('s2')], decision, opts()),
    );
    const fed = p.createdIds[0] as FeatureId;
    const fedFeature = p.nextFeatures.find((f) => f.id === fed) as Feature;
    expect(asAggregate(fedFeature)?.childIds).toEqual([fid('s1'), fid('s2')]);
    expectChildIdsSyncedWithParentId(p.nextFeatures);
  });

  it('survivedTouchedIds に childIds が変化した旧親/新親が含まれる', () => {
    const features = [
      agg('A', 'A', 0, 100),
      agg('B', 'B', 0, 100),
      leaf('keep', 'keep', 0, 100, 'A'),
      leaf('child', 'child', 0, 100, 'A'),
    ];
    const p = expectProposal(
      buildAffiliationProposal(features, fid('child'), parentExisting(fid('B')), opts()),
    );
    // 旧親 A (子を失った) と新親 B (子を得た) はいずれも childIds が変化したので通知対象。
    expect(p.survivedTouchedIds).toContain(fid('A'));
    expect(p.survivedTouchedIds).toContain(fid('B'));
  });

  it('serialize 往復: 永続化される childIds が旧親に子を残さず新親に実子を持つ', () => {
    // deserialize は persistence 内部専用 (R8 境界) なので、保存形 (Manifest) の
    // 永続化 childIds を Zod 境界 (parseManifest) 経由で検証する。直列化されるのは
    // feature.childIds であり、ここが脱同期するとファイルにデータ破損が記録される。
    const features = [
      agg('A', 'A', 0, 100),
      agg('B', 'B', 0, 100),
      leaf('keep', 'keep', 0, 100, 'A'),
      leaf('child', 'child', 0, 100, 'A'),
    ];
    const p = expectProposal(
      buildAffiliationProposal(features, fid('child'), parentExisting(fid('B')), opts()),
    );
    const project: DomainProject = {
      histories: [singleAnchorHistory('snap', p.nextFeatures, createVertexStore([]))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    // serialize → JSON → parseManifest (Zod 境界) で保存形を検証込みで取得。
    const json = JSON.parse(JSON.stringify(serialize(project)));
    const parsed = parseManifest(json);
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome !== PARSE_OUTCOME.Ok) return;
    const persistedFeatures =
      parsed.manifest.histories[0]?.entries[0]?.anchor.snapshot.features ?? [];
    const a = persistedFeatures.find((f) => f.id === 'A');
    const b = persistedFeatures.find((f) => f.id === 'B');
    // 保存形: A の childIds に child が残らない、B の childIds に child が入る。
    expect(a?.kind).toBe('aggregate');
    expect(b?.kind).toBe('aggregate');
    if (a?.kind === 'aggregate') expect(a.childIds).toEqual(['keep']);
    if (b?.kind === 'aggregate') expect(b.childIds).toEqual(['child']);
  });

  it('deletion eligibility: 移動した子の parentRef が旧親ではなく新親を指す', () => {
    const features = [
      agg('A', 'A', 0, 100),
      agg('B', 'B', 0, 100),
      leaf('keep', 'keep', 0, 100, 'A'),
      leaf('child', 'child', 0, 100, 'A'),
    ];
    const p = expectProposal(
      buildAffiliationProposal(features, fid('child'), parentExisting(fid('B')), opts()),
    );
    // child を参照する親 (childIds.includes(child)) は新親 B のみ。旧親 A は含まれない。
    const refs = referencesInAnchor(p.nextFeatures, fid('child'));
    expect(refs.parentRefs).toEqual([fid('B')]);
    // parentRefs (childIds 由来) と「child の親 = childRefs の逆」が一致する: 整合の両側固定。
    const childParent = p.nextFeatures.find((f) => f.id === fid('child'))?.parentId;
    expect(refs.parentRefs).toContain(childParent);
  });
});
