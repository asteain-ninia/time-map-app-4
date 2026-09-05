// U41 — 表示の設定（オプションバーの「表示 ▾」ポップオーバー。増分 4 の中身 7 / C7）。
//
// **旧 `DisplayFilterPanel.test.tsx` の 12 件をここへ引き継いだ。** 置き場所が
// 「一覧の 28,546px 下」からオプションバーへ移っただけで、部品の役割も testid も同じ
// なので、主張はそのまま生きる（T-1: testid は役割で維持する）。
//
// 増分 4 で足した主張:
//   - **種別（FR-40 の札）ごとに 1 行 × 3 トグル**（隠す・薄くする・目立たせる）
//   - **［薄くする］は不透明度 0.25 固定・もう一度押すと解除**（設計書 §E.1 の V5(b)）
//   - **深さの強調**（G-6 / R8。ドメインに在るのに呼び出し元が 1 つも無かった軸）
//   - **閉じているあいだはパネルが入力を奪わない**（教訓 5.56 の `[hidden]` 打ち消し）

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex } from '../../domain/vertex';
import { timePointYear } from '../../domain/time/time-point';
import type { AddSnapshot } from '../../domain/add/index';
import type { DomainRoot } from '../consistency-binding';

import { createSessionStore } from '../state/store';

import { FEATURE_KIND_AXIS } from './axes';
import { DisplayOptions } from './DisplayOptions';
import { DIM_OPACITY_FACTOR } from './visibility';
import { FILTER_STRINGS } from './strings';

interface TestDomain {
  readonly tag: string;
}

const A = asFeatureId('A');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function emptyProject(): DomainRoot {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: {
      source: 's',
      meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
    },
  };
}

/** 種別（札）つきの面を 1 枚足す（札が空なら付けない）。 */
function withLabelledLeaf(root: DomainRoot, idRaw: string, kindLabel: string): DomainRoot {
  const vertices = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ].map((c, i) =>
    createVertex(asVertexId(`${idRaw}-v${String(i)}`), { lon: c[0] ?? 0, lat: c[1] ?? 0 }),
  );
  const ring = createTerritoryRing(
    asRingId(`r-${idRaw}`),
    vertices.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 0, 100),
    color,
    createShape([ring]),
    kindLabel.length === 0 ? {} : { kindLabel },
  );
  const snapshot: AddSnapshot = { feature, vertices, sharedCandidateIds: new Map() };
  return applyAddProposal(root, createEditProposal(feature.id, timePointYear(0), snapshot));
}

/** 島国 2 件・州 1 件・札なし 1 件。 */
function projectWithKindLabels(): DomainRoot {
  let root = emptyProject();
  root = withLabelledLeaf(root, 'f1', '島国');
  root = withLabelledLeaf(root, 'f2', '島国');
  root = withLabelledLeaf(root, 'f3', '州');
  root = withLabelledLeaf(root, 'f4', '');
  return root;
}

function setup(root: DomainRoot = emptyProject()) {
  const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
  render(
    <DisplayOptions<TestDomain>
      store={store}
      getRoot={() => root}
      getTime={() => timePointYear(0)}
    />,
  );
  return store;
}

/** ポップオーバーを開く（閉じているあいだは中身が入力を受けない＝K-2 / 教訓 5.56）。 */
function open(): void {
  fireEvent.click(screen.getByTestId('option-display-button'));
}

describe('表示 ▾ — 開閉（K-2 / 教訓 5.56）', () => {
  it('既定では閉じていて、パネルに hidden が付いている', () => {
    setup();
    expect(screen.getByTestId('option-display-panel')).toHaveAttribute('hidden');
    expect(screen.getByTestId('option-display-button')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('押すと開き、もう一度押すと閉じる', () => {
    setup();
    open();
    expect(screen.getByTestId('option-display-panel')).not.toHaveAttribute('hidden');
    open();
    expect(screen.getByTestId('option-display-panel')).toHaveAttribute('hidden');
  });

  it('Escape で閉じる（Esc の階段。ほかへ伝えない）', () => {
    setup();
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('option-display-panel')).toHaveAttribute('hidden');
  });
});

describe('表示 ▾ — 種別可視軸（Phase 1 回帰。旧 DisplayFilterPanel から引き継ぎ）', () => {
  it('面のチェックを外すと、ストアの種別軸へ書かれる', () => {
    const store = setup();
    open();
    const area = screen.getByTestId('display-filter-kind-area');
    expect(area).toBeChecked();
    fireEvent.click(area);
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(false);
    expect(screen.getByTestId('display-filter-kind-area')).not.toBeChecked();
  });
});

describe('表示 ▾ — 種別強調軸（Phase 2 回帰。G-22）', () => {
  it('点・線・面の強調トグルは既定でオフ', () => {
    setup();
    open();
    expect(screen.getByTestId('display-filter-emphasize-point')).not.toBeChecked();
    expect(screen.getByTestId('display-filter-emphasize-line')).not.toBeChecked();
    expect(screen.getByTestId('display-filter-emphasize-area')).not.toBeChecked();
  });

  it('面を強調するとストアへ書かれ、UI も追随する', () => {
    const store = setup();
    open();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(store.getState().filter.emphasizedKinds.has(FEATURE_KIND_AXIS.Area)).toBe(true);
    expect(screen.getByTestId('display-filter-emphasize-area')).toBeChecked();
  });

  it('**強調は独立軸** — 面を強調しても可視軸は動かない', () => {
    const store = setup();
    open();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(true);
    expect(screen.getByTestId('display-filter-kind-area')).toBeChecked();
  });
});

describe('表示 ▾ — 強調をすべて解除（脱出口）', () => {
  it('強調が無いときは押せない', () => {
    setup();
    open();
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeDisabled();
  });

  it('種別強調でも、地物単位の強調でも活性になる', () => {
    const store = setup();
    open();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeEnabled();
    fireEvent.click(screen.getByTestId('display-filter-clear-emphasis'));
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeDisabled();

    act(() => {
      store.getState().setFeatureEmphasized(A, true);
    });
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeEnabled();
  });

  it('押すと全部の強調が消え、可視軸と不透明度は触らない', () => {
    const store = setup();
    open();
    fireEvent.click(screen.getByTestId('display-filter-kind-area')); // 面を非表示に
    fireEvent.click(screen.getByTestId('display-filter-emphasize-line'));
    act(() => {
      store.getState().setFeatureEmphasized(A, true);
    });
    fireEvent.click(screen.getByTestId('display-filter-clear-emphasis'));
    expect(store.getState().filter.emphasizedKinds.size).toBe(0);
    expect(store.getState().filter.emphasizedIds.size).toBe(0);
    // 可視軸は触らない。
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(false);
    expect(store.getState().filter.opacity).toBe(1);
  });

  it('ラベルは文言定数から来る（画面の言葉を直書きしない）', () => {
    setup();
    open();
    expect(screen.getByTestId('display-filter-clear-emphasis').textContent).toBe(
      FILTER_STRINGS.emphasizeClearAllLabel,
    );
  });
});

describe('表示 ▾ — 種別（FR-40 の札）ごとの 3 トグル（増分 4 / V5(b)）', () => {
  it('いま世界に在る札ごとに 1 行が出て、件数の多い順に並ぶ', () => {
    setup(projectWithKindLabels());
    open();
    expect(screen.getByTestId('display-filter-label-row-島国')).toBeInTheDocument();
    expect(screen.getByTestId('display-filter-label-row-州')).toBeInTheDocument();
    // 札の無い地物は行を作らない。
    expect(screen.queryByTestId('display-filter-label-row-')).not.toBeInTheDocument();
  });

  it('［隠す］はその札の地物を表示から外す', () => {
    const store = setup(projectWithKindLabels());
    open();
    fireEvent.click(screen.getByTestId('display-filter-label-hide-島国'));
    expect(store.getState().filter.hiddenKindLabels.has('島国')).toBe(true);
    expect(screen.getByTestId('display-filter-label-hide-島国')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('［薄くする］は 0.25 固定・確定不要・もう一度押すと解除', () => {
    const store = setup(projectWithKindLabels());
    open();
    fireEvent.click(screen.getByTestId('display-filter-label-dim-島国'));
    // **確定は要らない**（押した瞬間にストアへ入る）。
    expect(store.getState().filter.dimmedKindLabels.has('島国')).toBe(true);
    // 不透明度の数値入力は出さない（値は 0.25 固定＝強調の減衰と同じ値）。
    expect(DIM_OPACITY_FACTOR).toBe(0.25);
    fireEvent.click(screen.getByTestId('display-filter-label-dim-島国'));
    expect(store.getState().filter.dimmedKindLabels.has('島国')).toBe(false);
  });

  it('［目立たせる］は強調の軸に入る（脱出口で消える）', () => {
    const store = setup(projectWithKindLabels());
    open();
    fireEvent.click(screen.getByTestId('display-filter-label-emphasize-島国'));
    expect(store.getState().filter.emphasizedKindLabels.has('島国')).toBe(true);
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeEnabled();
    fireEvent.click(screen.getByTestId('display-filter-clear-emphasis'));
    expect(store.getState().filter.emphasizedKindLabels.size).toBe(0);
  });

  it('3 つのトグルは互いに独立（薄くしても隠れない）', () => {
    const store = setup(projectWithKindLabels());
    open();
    fireEvent.click(screen.getByTestId('display-filter-label-dim-島国'));
    expect(store.getState().filter.hiddenKindLabels.size).toBe(0);
    expect(store.getState().filter.emphasizedKindLabels.size).toBe(0);
  });
});

describe('表示 ▾ — 深さの強調（G-6 / R8）', () => {
  it('既定は切れていて、入れると深さが書ける', () => {
    const store = setup();
    open();
    const toggle = screen.getByTestId('display-filter-emphasize-depth-toggle');
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('display-filter-emphasize-depth')).toBeDisabled();
    fireEvent.click(toggle);
    expect(store.getState().filter.emphasizedDepth).toBe(0);
    fireEvent.change(screen.getByTestId('display-filter-emphasize-depth'), {
      target: { value: '2' },
    });
    expect(store.getState().filter.emphasizedDepth).toBe(2);
  });

  it('切ると解除される（null へ戻る）', () => {
    const store = setup();
    open();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-depth-toggle'));
    fireEvent.click(screen.getByTestId('display-filter-emphasize-depth-toggle'));
    expect(store.getState().filter.emphasizedDepth).toBeNull();
  });
});
