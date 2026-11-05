// U32: detail-panel drag / multiple / layering / plain-text 作業メモ tests (FR-99 /
// FR-98, 受け入れ基準 3, 教訓 5.8 / 5.14).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createPointFeature,
  type Feature,
} from '../../domain/feature';
import { asFeatureId, asVertexId, type FeatureId } from '../../domain/ids';

import type { FeatureLookup } from './contracts';
import { DetailPanels } from './DetailPanels';
import {
  type DetailPanelsState,
  openPanel,
  panelIdFor,
} from './detail-panels';
import { PROPERTY_STRINGS } from './messages';

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const fA = asFeatureId('A');
const fB = asFeatureId('B');

function feat(id: FeatureId, name: string): Feature {
  return createPointFeature(id, createBasicAttributes(name, 1, 2), color, asVertexId(`${id}-v`));
}

const featureLookup: FeatureLookup = {
  featureAt: (id) => (id === fA ? feat(fA, '城A') : id === fB ? feat(fB, '城B') : null),
};

function twoOpen(): DetailPanelsState {
  let s = openPanel({ panels: [] }, fA, { x: 50, y: 50 });
  s = openPanel(s, fB, { x: 50, y: 50 });
  return s;
}

describe('DetailPanels — 複数同時 / 個別ドラッグ / 個別閉じ (FR-99)', () => {
  it('renders a panel per open feature with cascaded positions', () => {
    render(
      <DetailPanels
        state={twoOpen()}
        featureLookup={featureLookup}
        detailDocumentOf={() => ''}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId(`panel-${panelIdFor(fA)}`)).toBeInTheDocument();
    expect(screen.getByTestId(`panel-${panelIdFor(fB)}`)).toBeInTheDocument();
  });

  it('種別 row shows the Japanese kind label, never the English enum 生値 (task (1))', () => {
    // 実機報告「種別: aggregate って何?」— a 集約 feature must read「集約地物」, not "aggregate".
    const aggId = asFeatureId('AGG');
    const aggLookup: FeatureLookup = {
      featureAt: (id) =>
        id === aggId
          ? createAggregateFeature(aggId, createBasicAttributes('連邦', 1, 2), color, [])
          : null,
    };
    render(
      <DetailPanels
        state={openPanel({ panels: [] }, aggId, { x: 40, y: 40 })}
        featureLookup={aggLookup}
        detailDocumentOf={() => ''}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('集約地物')).toBeInTheDocument();
    expect(screen.queryByText('aggregate')).toBeNull();
  });

  it('drags one panel by its header without moving the other (教訓 5.8)', () => {
    render(
      <DetailPanels
        state={twoOpen()}
        featureLookup={featureLookup}
        detailDocumentOf={() => ''}
        onClose={() => {}}
      />,
    );
    const panelA = screen.getByTestId(`panel-${panelIdFor(fA)}`);
    const headerA = screen.getByTestId(`panel-header-${panelIdFor(fA)}`);
    const beforeB = screen.getByTestId(`panel-${panelIdFor(fB)}`).style.left;

    fireEvent.pointerDown(headerA, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 90 });
    fireEvent.pointerUp(window);

    expect(panelA.style.left).toBe('120px');
    // The other panel is untouched.
    expect(screen.getByTestId(`panel-${panelIdFor(fB)}`).style.left).toBe(beforeB);
  });

  it('a press on a back panel brings it to the front (教訓 5.14: 入力層)', () => {
    render(
      <DetailPanels
        state={twoOpen()}
        featureLookup={featureLookup}
        detailDocumentOf={() => ''}
        onClose={() => {}}
      />,
    );
    const panelA = screen.getByTestId(`panel-${panelIdFor(fA)}`);
    const panelB = screen.getByTestId(`panel-${panelIdFor(fB)}`);
    // B opened last → front-most initially (higher z-index).
    const zA0 = Number(panelA.style.zIndex);
    const zB0 = Number(panelB.style.zIndex);
    expect(zB0).toBeGreaterThan(zA0);

    // Press A → A becomes front-most.
    fireEvent.pointerDown(panelA, { clientX: 0, clientY: 0 });
    expect(Number(panelA.style.zIndex)).toBeGreaterThan(Number(panelB.style.zIndex));
  });

  it('closing one panel reports its id to onClose', () => {
    const onClose = vi.fn();
    render(
      <DetailPanels
        state={twoOpen()}
        featureLookup={featureLookup}
        detailDocumentOf={() => ''}
        onClose={onClose}
      />,
    );
    const headerA = screen.getByTestId(`panel-header-${panelIdFor(fA)}`);
    fireEvent.click(headerA.querySelector('button')!);
    expect(onClose).toHaveBeenCalledWith(panelIdFor(fA));
  });

  it('shows all attributes and the作業メモ as plain text (書式を解釈しない)', () => {
    render(
      <DetailPanels
        state={openPanel({ panels: [] }, fA, { x: 0, y: 0 })}
        featureLookup={featureLookup}
        detailDocumentOf={() => '**重要**な城\n[行く](feature:B)'}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId(`detail-panel-${fA}`)).toBeInTheDocument();
    const memo = screen.getByTestId('detail-panel-memo');
    expect(memo.textContent).toBe('**重要**な城\n[行く](feature:B)');
    expect(memo.querySelector('strong')).toBeNull();
    expect(memo.querySelector('a')).toBeNull();
  });

  it('shows the empty notice when the feature has no作業メモ', () => {
    render(
      <DetailPanels
        state={openPanel({ panels: [] }, fA, { x: 0, y: 0 })}
        featureLookup={featureLookup}
        detailDocumentOf={() => ''}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('detail-panel-memo-empty')).toHaveTextContent(
      PROPERTY_STRINGS.detailDocEmpty,
    );
  });
});
