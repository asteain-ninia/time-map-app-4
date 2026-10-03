// 分け残し（直轄領）を **名前でなくデータの印**で見分ける（所有者の裁定 2026-09-07）。
//
// 固定すること:
//   1. 利用者が「○○ 直轄領」と名付けた普通の末端は、新しい上位領域にできる（名前に
//      巻き込まれない）。
//   2. FR-37 で生まれた分け残しには印が立ち、名前を変えても親にできない。
//   3. 印は保存→読み込みを往復する（保存形式の欄 `directDomain`）。
//   4. 分け残しが別の経路で集約へ変わったら印は落ちる（集約は分け残しではない）。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo, withName } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createLeafFeature,
  isDirectDomainLeaf,
  toShapelessAggregate,
  withAttributes,
  type Feature,
  type LeafFeature,
} from '../feature';
import { buildForest } from '../hierarchy/forest';
import { createIdGeneratorState } from '../id-generator';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { parseManifest, PARSE_OUTCOME } from '../persistence';
import { projectsEqual, serialize, type DomainProject } from '../persistence/serialize';
// deserialize is persistence-internal (R8): only legitimate on manifests this test
// serialized itself — the same use as persistence/round-trip.test.ts.
// eslint-disable-next-line no-restricted-imports
import { deserialize } from '../persistence/serialize';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS, singleAnchorHistory } from '../persistence/fixtures';

import { AFFILIATION_REJECT, allowedParentCandidates, isLegalNewParent } from './candidates';
import { parentExisting } from './decision';
import { MSG_AFFILIATION_DIRECT_DOMAIN } from './messages';
import { buildAffiliationProposal } from './proposal';

const COLOR = createColorInfo(true, '#111', '#222', '#333');

function square(
  id: string,
  name: string,
  ox: number,
  oy: number,
  size: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const vids = [0, 1, 2, 3].map((i) => asVertexId(`${id}-v${String(i)}`));
  const coords = [
    createCoordinate(ox, oy),
    createCoordinate(ox + size, oy),
    createCoordinate(ox + size, oy + size),
    createCoordinate(ox, oy + size),
  ];
  const vertices = vids.map((vid, i) => createVertex(vid, coords[i]!));
  const ring = createTerritoryRing(asRingId(`${id}-r`), vids);
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(name, 0, 1000),
    COLOR,
    createShape([ring]),
  );
  return { feature, vertices };
}

/**
 * 大きい末端 L の中へ小さい末端 S を入れる所属変更を組み、FR-37 で分け残しを生ませる。
 * 外に普通の末端 O（あとで「親にできるか」を試す相手）を置く。
 */
function bornDirectDomain(): {
  readonly features: readonly Feature[];
  readonly ddId: FeatureId;
  readonly outsiderId: FeatureId;
} {
  const L = square('L', '大きい国', 0, 0, 100);
  const S = square('S', '小さい州', 10, 10, 10);
  const O = square('O', '外の国', 200, 0, 10);
  const store = createVertexStore([...L.vertices, ...S.vertices, ...O.vertices]);
  const result = buildAffiliationProposal(
    [L.feature, S.feature, O.feature],
    S.feature.id,
    parentExisting(L.feature.id),
    { idState: createIdGeneratorState(), now: () => 1, vertexStore: store },
  );
  if (result.status !== 'proposal') throw new Error(JSON.stringify(result));
  const created = result.proposal.nextFeatures.filter((f) =>
    result.proposal.createdIds.includes(f.id),
  );
  const dd = created.find((f) => f.kind === 'leaf');
  if (dd === undefined) throw new Error('分け残しが生まれていない');
  return { features: result.proposal.nextFeatures, ddId: dd.id, outsiderId: O.feature.id };
}

describe('分け残し（直轄領）はデータの印で見分ける（所有者の裁定 2026-09-07）', () => {
  it('FR-37 で生まれた分け残しには印が立ち、親の候補から外れる', () => {
    const { features, ddId, outsiderId } = bornDirectDomain();
    const dd = features.find((f) => f.id === ddId)!;
    expect(dd.directDomain).toBe(true);
    expect(isDirectDomainLeaf(dd)).toBe(true);

    const forest = buildForest(features);
    expect(isLegalNewParent(forest, outsiderId, ddId)).toEqual({
      ok: false,
      reason: AFFILIATION_REJECT.DirectDomainParent,
    });
    expect(allowedParentCandidates(forest, outsiderId).map((c) => c.featureId)).not.toContain(
      ddId,
    );
  });

  it('印のある分け残しは、名前を変えても親にできない', () => {
    const { features, ddId, outsiderId } = bornDirectDomain();
    const renamed = features.map((f) =>
      f.id === ddId ? withAttributes(f, withName(f.attributes, 'ただの土地')) : f,
    );
    const dd = renamed.find((f) => f.id === ddId)!;
    expect(dd.attributes.name).toBe('ただの土地');
    expect(dd.directDomain).toBe(true);
    expect(isLegalNewParent(buildForest(renamed), outsiderId, ddId)).toEqual({
      ok: false,
      reason: AFFILIATION_REJECT.DirectDomainParent,
    });
  });

  it('利用者が「○○ 直轄領」と名付けた普通の末端は親にできる（名前に巻き込まれない）', () => {
    const named = square('N', '王家 直轄領', 0, 0, 10);
    const other = square('X', '隣の州', 20, 0, 10);
    const features = [named.feature, other.feature];
    expect(named.feature.directDomain).toBeUndefined();
    expect(isDirectDomainLeaf(named.feature)).toBe(false);
    const forest = buildForest(features);
    expect(isLegalNewParent(forest, other.feature.id, named.feature.id)).toEqual({ ok: true });
    expect(allowedParentCandidates(forest, other.feature.id).map((c) => c.featureId)).toContain(
      named.feature.id,
    );
  });

  it('断りの文は名前の付け替えを勧めない（印の話に合わせる）', () => {
    expect(MSG_AFFILIATION_DIRECT_DOMAIN).not.toContain('名前から');
    expect(MSG_AFFILIATION_DIRECT_DOMAIN).toContain('分け残し');
  });

  it('印は保存→読み込みを往復する', () => {
    const { features, ddId } = bornDirectDomain();
    const dd = features.find((f) => f.id === ddId) as LeafFeature;
    const ddVertexIds = new Set(dd.shape.rings.flatMap((r) => r.vertexIds));
    // 分け残しの頂点は所属変更の案が新しく作ったもの。ここでは往復だけを見るので、
    // 形の頂点を合成で用意する（座標は何でもよい）。
    const vertices = [...ddVertexIds].map((vid, i) =>
      createVertex(vid, createCoordinate(i, i)),
    );
    const project: DomainProject = {
      histories: [singleAnchorHistory(ddId, [dd], createVertexStore(vertices))],
      settings: DEFAULT_SETTINGS,
      baseMap: DEFAULT_BASEMAP,
    };
    const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(project))));
    expect(parsed.outcome).toBe(PARSE_OUTCOME.Ok);
    if (parsed.outcome !== PARSE_OUTCOME.Ok) return;
    // 保存形に印が書かれている（Zod の strict を通っている）。
    const persisted = parsed.manifest.histories[0]!.entries[0]!.anchor.snapshot.features[0]!;
    expect(persisted.directDomain).toBe(true);
    // 読み戻した地物にも印がある。
    const loaded = deserialize(parsed.manifest).histories[0]!.series.entries[0]!.anchor.snapshot
      .features[0]!;
    expect(loaded.directDomain).toBe(true);
    expect(isDirectDomainLeaf(loaded)).toBe(true);
    expect(projectsEqual(deserialize(parsed.manifest), project)).toBe(true);
  });

  it('分け残しが集約へ変わったら印は落ちる（集約は分け残しではない）', () => {
    const { features, ddId } = bornDirectDomain();
    const dd = features.find((f) => f.id === ddId)!;
    const asAggregate = toShapelessAggregate(dd, [asFeatureId('child')]);
    expect(asAggregate.directDomain).toBeUndefined();
    expect(isDirectDomainLeaf(asAggregate)).toBe(false);
  });
});
