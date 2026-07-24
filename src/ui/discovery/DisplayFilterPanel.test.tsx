// U41 — DisplayFilterPanel behavioural tests (FR-113 Phase 1 可視軸 + Phase 2 強調軸).
//
// The panel is a THIN store binding: every control must report intent through the SAME
// session-store action the draw / hit / search母集合 read, and must RENDER the live filter
// (never a local copy). These tests drive the real widget over a real session store and
// assert BOTH directions — click → store, and store → rendered state — so a control that
// silently keeps its own state (or writes a different axis) turns red.
//
// Phase 2 additions under test:
//   - 種別強調トグル (点/線/面) — symmetric with the kindVisible toggles, an INDEPENDENT axis
//     (emphasizing 面 must not touch kindVisible[面]).
//   - 「強調をすべて解除」 — the escape hatch, ACTIVE only while some emphasis is in effect.
//   - 深度強調 (emphasizedDepth) is Phase 3 — the panel must expose NO control for it.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import { createSessionStore } from '../state/store';

import { FEATURE_KIND_AXIS } from './axes';
import { DisplayFilterPanel } from './DisplayFilterPanel';
import { FILTER_STRINGS } from './strings';

interface TestDomain {
  readonly tag: string;
}

function setup() {
  const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
  render(<DisplayFilterPanel<TestDomain> store={store} />);
  return store;
}

const A = asFeatureId('A');

describe('DisplayFilterPanel — 種別可視軸 (Phase 1 回帰)', () => {
  it('unchecking 面 writes the kind axis through the store action', () => {
    const store = setup();
    const area = screen.getByTestId('display-filter-kind-area');
    expect(area).toBeChecked();
    fireEvent.click(area);
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(false);
    expect(screen.getByTestId('display-filter-kind-area')).not.toBeChecked();
  });
});

describe('DisplayFilterPanel — 種別強調トグル (FR-113 Phase 2)', () => {
  it('renders one 強調 toggle per kind axis (点/線/面), all off by default', () => {
    setup();
    for (const testid of ['point', 'line', 'area']) {
      expect(screen.getByTestId(`display-filter-emphasize-${testid}`)).not.toBeChecked();
    }
  });

  it('checking 面強調 emphasizes the AREA axis through the store (single source)', () => {
    const store = setup();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(store.getState().filter.emphasizedKinds.has(FEATURE_KIND_AXIS.Area)).toBe(true);
    expect(screen.getByTestId('display-filter-emphasize-area')).toBeChecked();
  });

  it('強調 is an INDEPENDENT axis: emphasizing 面 does not change kindVisible[面]', () => {
    const store = setup();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(true);
    expect(screen.getByTestId('display-filter-kind-area')).toBeChecked();
  });

  it('unchecking a 強調 toggle removes only that axis', () => {
    const store = setup();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    fireEvent.click(screen.getByTestId('display-filter-emphasize-point'));
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(store.getState().filter.emphasizedKinds.has(FEATURE_KIND_AXIS.Area)).toBe(false);
    expect(store.getState().filter.emphasizedKinds.has(FEATURE_KIND_AXIS.Point)).toBe(true);
  });

  it('RENDERS an emphasis set from OUTSIDE the panel (右クリック強調 も反映される)', () => {
    const store = setup();
    act(() => {
      store.getState().setFilterKindEmphasized(FEATURE_KIND_AXIS.Line, true);
    });
    expect(screen.getByTestId('display-filter-emphasize-line')).toBeChecked();
  });
});

describe('DisplayFilterPanel — 強調をすべて解除 (脱出口)', () => {
  it('is DISABLED while no emphasis is active (emphasisActive=false)', () => {
    setup();
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeDisabled();
  });

  it('becomes ENABLED once ANY emphasis is in effect — kind axis', () => {
    setup();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeEnabled();
  });

  it('becomes ENABLED for a per-feature emphasis set outside the panel (右クリック強調)', () => {
    const store = setup();
    act(() => {
      store.getState().setFeatureEmphasized(A, true);
    });
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeEnabled();
  });

  it('clicking it clears EVERY emphasis axis and returns to disabled', () => {
    const store = setup();
    fireEvent.click(screen.getByTestId('display-filter-emphasize-area'));
    act(() => {
      store.getState().setFeatureEmphasized(A, true);
    });
    fireEvent.click(screen.getByTestId('display-filter-clear-emphasis'));
    expect(store.getState().filter.emphasizedKinds.size).toBe(0);
    expect(store.getState().filter.emphasizedIds.size).toBe(0);
    expect(screen.getByTestId('display-filter-clear-emphasis')).toBeDisabled();
    // 強調解除は可視軸・不透明度を触らない.
    expect(store.getState().filter.kindVisible[FEATURE_KIND_AXIS.Area]).toBe(true);
    expect(store.getState().filter.opacity).toBe(1);
  });

  it('is labelled in Japanese from the shared strings module (FR-115, 教訓 5.19)', () => {
    setup();
    expect(screen.getByTestId('display-filter-clear-emphasis')).toHaveTextContent(
      FILTER_STRINGS.emphasizeClearAllLabel,
    );
  });
});

describe('DisplayFilterPanel — Phase 3 の深度強調は出さない (スコープ境界)', () => {
  it('exposes NO emphasizedDepth control', () => {
    setup();
    expect(screen.queryByTestId('display-filter-emphasize-depth')).toBeNull();
    expect(screen.queryByTestId('display-filter-emphasize-depth-toggle')).toBeNull();
  });
});
