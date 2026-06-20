// U32: PropertyPanel React operation tests (FR-83 / FR-84 / FR-97 / FR-99,
// 受け入れ基準 1/2/3/5, 教訓 5.10 / 5.12 / 5.13 / 5.15 / 5.24).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import {
  type AnchorSeries,
  createAnchorEntry,
} from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createPointFeature, type Feature } from '../../domain/feature';
import {
  asAnchorId,
  asFeatureId,
  asVertexId,
  type FeatureId,
} from '../../domain/ids';
import { ownerLookupFromMap } from '../../domain/selection';
import { getCalendar } from '../../domain/time/calendar';
import {
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import { EDIT_MODE } from '../state/session';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../state/store';

import type {
  AnchorSeriesLookup,
  EditDispatch,
  FeatureLookup,
  PropertyEditIntent,
} from './contracts';
import { PropertyPanel } from './PropertyPanel';
import { PROPERTY_STRINGS } from './messages';

const cal = getCalendar('gregorian');
const color = createColorInfo(true, '#111111', '#222222', '#333333');

const fA = asFeatureId('A');
const vA1 = asVertexId('A-v1');
const fB = asFeatureId('B');
const vB1 = asVertexId('B-v1');

function featureA(): Feature {
  return createPointFeature(fA, createBasicAttributes('織田領', 1560, 1582), color, vA1);
}

function featureB(): Feature {
  return createPointFeature(fB, createBasicAttributes('武田領', 1540, 1582), color, vB1);
}

function seriesFor(): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: [
      createAnchorEntry(createAnchor(asAnchorId('a1'), snap), timePointYearMonthDay(1560, 1, 1), timePointYearMonthDay(1573, 1, 1)),
      createAnchorEntry(createAnchor(asAnchorId('a2'), snap), timePointYearMonthDay(1573, 1, 1), null),
    ],
  };
}

function makeStore(opts?: { active?: boolean; vertices?: boolean; mode?: 'view' | 'edit' }) {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    initial: {
      mode: opts?.mode === 'view' ? EDIT_MODE.View : EDIT_MODE.Edit,
      ...(opts?.active ? { activeFeature: fA } : {}),
      ...(opts?.vertices
        ? { vertexSelection: { ownerFeatureId: fA, vertexIds: new Set([vA1]) } }
        : {}),
    },
  });
}

// NOTE: each call returns a FRESH feature/series object (id-equal but
// reference-NEW), mirroring the real domain lookups. This is load-bearing for the
// regression tests below: it proves the panel/form key their reset to the feature
// ID, not the value object, so a re-resolve of the SAME feature does not churn the
// draft / message.
const featureLookup: FeatureLookup = {
  featureAt: (id) => (id === fA ? featureA() : id === fB ? featureB() : null),
};
const anchorLookup: AnchorSeriesLookup = {
  anchorSeriesOf: (id) => (id === fA || id === fB ? seriesFor() : null),
};
const ownerLookup = ownerLookupFromMap(
  new Map([
    [vA1, fA],
    [vB1, fB],
  ]),
);

function renderPanel(
  store: ReturnType<typeof makeStore>,
  dispatch: EditDispatch = { dispatchEdit: () => {} },
  onOpenDetail?: (id: FeatureId) => void,
) {
  return render(
    <PropertyPanel
      store={store}
      featureLookup={featureLookup}
      anchorLookup={anchorLookup}
      editDispatch={dispatch}
      calendar={cal}
      ownerLookup={ownerLookup}
      {...(onOpenDetail ? { onOpenDetail } : {})}
    />,
  );
}

describe('PropertyPanel — selection-display (FR-83, 教訓 5.10)', () => {
  it('empty selection shows the empty guidance', () => {
    renderPanel(makeStore());
    expect(screen.getByTestId('property-guidance')).toHaveTextContent(
      PROPERTY_STRINGS.emptySelection,
    );
  });

  it('active feature shows its basic info form', () => {
    renderPanel(makeStore({ active: true }));
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('織田領');
  });

  it('context-single (no active, one owner) shows the feature', () => {
    renderPanel(makeStore({ vertices: true }));
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();
  });
});

describe('PropertyPanel — anchor selection (FR-84, 教訓 5.6 / 5.15)', () => {
  it('selecting an anchor syncs current time to its start via setCurrentTime', () => {
    const store = makeStore({ active: true });
    const setCurrentTime = vi.spyOn(store.getState(), 'setCurrentTime');
    renderPanel(store);
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    expect(setCurrentTime).toHaveBeenCalledTimes(1);
    const [time, source] = setCurrentTime.mock.calls[0]!;
    expect((time as TimePoint).year).toBe(1573);
    expect(source).toBe(TIME_CHANGE_SOURCE.AnchorSync);
  });

  it('saving after anchor select dispatches an intent with the anchor start as edit time', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanel(store, { dispatchEdit: (i) => intents.push(i) });

    fireEvent.click(screen.getByTestId('anchor-row-a2')); // edit target = a2 (1573)
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '羽柴領' },
    });
    fireEvent.click(screen.getByTestId('save-button'));

    expect(intents).toHaveLength(1);
    expect(intents[0]!.editTime.year).toBe(1573); // 教訓 5.15: context time, not Date.now
    expect(intents[0]!.attributes.name).toBe('羽柴領');
  });

  it('a no-op save (unchanged values) does not dispatch (教訓 5.24)', () => {
    const intents: PropertyEditIntent[] = [];
    const store = makeStore({ active: true });
    renderPanel(store, { dispatchEdit: (i) => intents.push(i) });
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    fireEvent.click(screen.getByTestId('save-button')); // no field changed
    expect(intents).toHaveLength(0);
  });
});

describe('PropertyPanel — view-only mode (FR-99前段, 教訓 5.13)', () => {
  it('disables every edit input and hides the save button in view mode', () => {
    renderPanel(makeStore({ active: true, mode: 'view' }));
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toBeDisabled();
    expect(screen.getByLabelText(PROPERTY_STRINGS.fillColorLabel)).toBeDisabled();
    expect(screen.queryByTestId('save-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-only-notice')).toBeInTheDocument();
  });
});

describe('PropertyPanel — decision message persistence (教訓 5.12)', () => {
  it('a save-failure message survives an unrelated click and clears on dismiss', () => {
    const store = makeStore({ active: true });
    // Dispatch throws → save-failure message.
    renderPanel(store, {
      dispatchEdit: () => {
        throw new Error('境界違反');
      },
    });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Unrelated click (on the panel, not a save retry) does NOT clear it.
    fireEvent.click(screen.getByTestId('property-panel'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Explicit dismiss clears it (意味のある操作).
    const msg = screen.getByTestId('save-message');
    fireEvent.click(within(msg).getByLabelText(PROPERTY_STRINGS.dismissMessage));
    expect(screen.queryByTestId('save-message')).not.toBeInTheDocument();
  });

  it('a save-failure message survives selecting a DIFFERENT feature (spec 行188, 教訓 5.12)', () => {
    // 受け入れ基準 5: a held decision message must NOT be cleared by無関係操作,
    // and別地物の選択 is explicitly such an操作. Only re-save / dismiss / 再保存成功
    // may clear it.
    const store = makeStore({ active: true });
    renderPanel(store, {
      dispatchEdit: () => {
        throw new Error('境界違反');
      },
    });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Select a DIFFERENT feature (a genuine target change). The form re-syncs to
    // feature B's baseline, but the held message must REMAIN — this is not one of
    // the three allowed clear契機.
    act(() => {
      store.getState().setActiveFeature(fB);
    });
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('武田領');
    expect(screen.getByTestId('save-message')).toBeInTheDocument();
  });
});

describe('PropertyPanel — context-feature anchor select (FR-84, 教訓 5.2 / 5.12)', () => {
  it('selecting an anchor on a vertex-context feature preserves the in-progress draft', () => {
    // Root cause: for a vertex-context target (no active feature, single owner),
    // setCurrentTime → revalidateForTime rebuilds the vertex Set with a FRESH
    // reference, re-rendering the panel with a new selection object naming the
    // SAME feature. Without ID-keyed memoization the resolved feature object would
    // be new every such render, wiping the draft.
    const store = makeStore({ vertices: true });
    renderPanel(store);
    expect(screen.getByTestId('basic-info')).toBeInTheDocument();

    // Type an edit, THEN select an anchor (the core FR-84 path).
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: '編集中' },
    });
    fireEvent.click(screen.getByTestId('anchor-row-a2'));

    // The in-progress draft must survive the anchor selection.
    expect(screen.getByLabelText(PROPERTY_STRINGS.nameLabel)).toHaveValue('編集中');
  });

  it('selecting an anchor on a vertex-context feature preserves a held save-failure message', () => {
    const store = makeStore({ vertices: true });
    renderPanel(store, {
      dispatchEdit: () => {
        throw new Error('境界違反');
      },
    });
    // Produce a save-failure message: select anchor → edit → save (throws).
    fireEvent.click(screen.getByTestId('anchor-row-a2'));
    fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByTestId('save-button'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();

    // Selecting another anchor re-runs setCurrentTime → revalidateForTime (fresh
    // vertex Set). The held message must survive (教訓 5.12).
    fireEvent.click(screen.getByTestId('anchor-row-a1'));
    expect(screen.getByTestId('save-message')).toBeInTheDocument();
  });
});

describe('PropertyPanel — detail open (FR-99後段)', () => {
  it('the 詳細表示 button requests opening a detail panel for the feature', () => {
    const onOpenDetail = vi.fn();
    renderPanel(makeStore({ active: true }), undefined, onOpenDetail);
    fireEvent.click(screen.getByTestId('open-detail-button'));
    expect(onOpenDetail).toHaveBeenCalledWith(fA);
  });
});
