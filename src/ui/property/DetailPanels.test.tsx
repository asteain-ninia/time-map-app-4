// U32: detail-panel drag / multiple / layering / markdown link tests (FR-99 /
// FR-98, 受け入れ基準 3 / 4, 教訓 5.8 / 5.14 / 5.19).

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

import type { AssetResolver, FeatureLookup } from './contracts';
import { DetailPanels } from './DetailPanels';
import { MarkdownView } from './MarkdownView';
import {
  type DetailPanelsState,
  openPanel,
  panelIdFor,
} from './detail-panels';
import { objectLinkHref } from './object-link';

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const fA = asFeatureId('A');
const fB = asFeatureId('B');

function feat(id: FeatureId, name: string): Feature {
  return createPointFeature(id, createBasicAttributes(name, 1, 2), color, asVertexId(`${id}-v`));
}

const featureLookup: FeatureLookup = {
  featureAt: (id) => (id === fA ? feat(fA, '城A') : id === fB ? feat(fB, '城B') : null),
};
const noAssets: AssetResolver = { resolveAsset: () => null };

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
        assetResolver={noAssets}
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
        assetResolver={noAssets}
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
        assetResolver={noAssets}
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
        assetResolver={noAssets}
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
        assetResolver={noAssets}
        detailDocumentOf={() => ''}
        onClose={onClose}
      />,
    );
    const headerA = screen.getByTestId(`panel-header-${panelIdFor(fA)}`);
    fireEvent.click(headerA.querySelector('button')!);
    expect(onClose).toHaveBeenCalledWith(panelIdFor(fA));
  });

  it('shows all attributes and the rendered detail document', () => {
    render(
      <DetailPanels
        state={openPanel({ panels: [] }, fA, { x: 0, y: 0 })}
        featureLookup={featureLookup}
        assetResolver={noAssets}
        detailDocumentOf={() => '**重要**な城'}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId(`detail-panel-${fA}`)).toBeInTheDocument();
    const md = screen.getByTestId('markdown-view');
    expect(md.innerHTML).toContain('<strong>重要</strong>');
  });
});

describe('MarkdownView — object-reference link click (FR-98, 教訓 5.19)', () => {
  it('clicking a feature: link selects the target feature', () => {
    const onSelect = vi.fn();
    const doc = `[行く](${objectLinkHref(fB)})`;
    render(<MarkdownView source={doc} assetResolver={noAssets} onSelectFeature={onSelect} />);
    const link = screen.getByTestId('markdown-view').querySelector('a')!;
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledWith(fB);
  });

  it('clicking an external link does NOT select a feature', () => {
    const onSelect = vi.fn();
    render(
      <MarkdownView
        source="[ext](https://example.com)"
        assetResolver={noAssets}
        onSelectFeature={onSelect}
      />,
    );
    const link = screen.getByTestId('markdown-view').querySelector('a')!;
    fireEvent.click(link);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
