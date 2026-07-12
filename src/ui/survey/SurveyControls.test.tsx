// U37 — SurveyControls operation test (FR-14 / FR-15 / FR-16 / FR-05 / FR-109).
//
// The topBar chrome for the survey mode: the 補助モード toggle (View でも使える —
// editable でゲートしない), the clear button (件数併記・表示条件), the per-phase
// guide, and the FR-14/16 readout — BOTH distances and BOTH coordinate forms
// (度分秒 + 十進), derived LIVE from currentMeasurement over the project's
// geoParams so an equator-length change re-computes at once (教訓 5.3 / 5.35).
// The expected numbers/strings are computed through the SAME domain functions the
// component consumes (measureSurveyPair / formatCoordinate / formatDistanceKm) —
// the test pins the WIRING, not a re-derived formula (単一真実源).

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { createGeoParams } from '../../domain/geo/geo-params';
import { formatCoordinate } from '../../domain/survey/coords-format';
import { measureSurveyPair } from '../../domain/survey/measure';
import { createSessionStore, type SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { DEFAULT_PROJECT_SETTINGS } from '../state/settings';

import { SurveyControls } from './SurveyControls';
import { SURVEY_STRINGS, formatDistanceKm } from './strings';

interface S {
  readonly tag: string;
}

const P1 = { lon: 100, lat: 50 };
const P2 = { lon: 130, lat: 20 };

function mountControls(initialMode = EDIT_MODE.View): {
  store: StoreApi<SessionStore<S>>;
  unmount: () => void;
} {
  const store = createSessionStore<S>({
    initialDomain: { tag: 'd0' },
    initial: { mode: initialMode },
  });
  const utils = render(<SurveyControls store={store} />);
  return { store, unmount: utils.unmount };
}

/** enable → confirm one line P1→P2 through the store (the controller's job). */
function confirmOneLine(store: StoreApi<SessionStore<S>>): void {
  act(() => {
    store.getState().surveyEnable();
    store.getState().surveyClickPoint(P1);
    store.getState().surveyClickPoint(P2);
  });
}

describe('SurveyControls — 測量モードトグル (補助モード, View でも可)', () => {
  it('renders the toggle enabled in View mode and reflects aria-pressed', () => {
    const { store, unmount } = mountControls(EDIT_MODE.View);
    const toggle = screen.getByTestId('survey-toggle');
    expect(toggle).toBeEnabled(); // editable でゲートしない
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent(SURVEY_STRINGS.modeLabel);

    fireEvent.click(toggle);
    expect(store.getState().survey.active).toBe(true);
    expect(store.getState().activeTool).toBeNull();
    expect(screen.getByTestId('survey-toggle')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('survey-toggle'));
    expect(store.getState().survey.active).toBe(false);
    unmount();
  });

  it('the toggle OFF keeps the confirmed lines (FR-15 — 解除はクリアではない)', () => {
    const { store, unmount } = mountControls();
    confirmOneLine(store);
    fireEvent.click(screen.getByTestId('survey-toggle')); // OFF
    expect(store.getState().survey.lines).toHaveLength(1);
    unmount();
  });
});

describe('SurveyControls — クリア (FR-15 全消去)', () => {
  it('is hidden when inactive with no lines; shown with the count; clears BOTH slots', () => {
    const { store, unmount } = mountControls();
    expect(screen.queryByTestId('survey-clear')).toBeNull();

    act(() => store.getState().surveyEnable());
    expect(screen.getByTestId('survey-clear')).toHaveTextContent('0');

    confirmOneLine(store);
    act(() => store.getState().surveyClickPoint({ lon: 0, lat: 0 })); // draft
    expect(screen.getByTestId('survey-clear')).toHaveTextContent('1');

    fireEvent.click(screen.getByTestId('survey-clear'));
    const s = store.getState().survey;
    expect(s.lines).toEqual([]);
    expect(s.draft).toBeNull();
    expect(s.active).toBe(true); // クリアは解除ではない
    unmount();
  });

  it('stays visible after survey OFF while lines remain (the FR-15 escape hatch)', () => {
    const { store, unmount } = mountControls();
    confirmOneLine(store);
    act(() => store.getState().surveyDisable());
    expect(screen.getByTestId('survey-clear')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('survey-clear'));
    expect(store.getState().survey.lines).toEqual([]);
    unmount();
  });
});

describe('SurveyControls — ガイド文', () => {
  it('shows guideIdle before the first click and guideAwaitingEnd during a draft', () => {
    const { store, unmount } = mountControls();
    expect(screen.queryByTestId('survey-guide')).toBeNull();

    act(() => store.getState().surveyEnable());
    expect(screen.getByTestId('survey-guide')).toHaveTextContent(
      SURVEY_STRINGS.guideIdle,
    );

    act(() => store.getState().surveyClickPoint(P1));
    expect(screen.getByTestId('survey-guide')).toHaveTextContent(
      SURVEY_STRINGS.guideAwaitingEnd,
    );
    unmount();
  });
});

describe('SurveyControls — 読取パネル (FR-14 距離 / FR-16 度分秒+十進)', () => {
  const geo = createGeoParams(
    DEFAULT_PROJECT_SETTINGS.equatorLengthKm,
    DEFAULT_PROJECT_SETTINGS.flattening,
  );

  it('shows BOTH distances for the most recent confirmed line', () => {
    const { store, unmount } = mountControls();
    confirmOneLine(store);

    const m = measureSurveyPair(P1, P2, geo);
    expect(screen.getByTestId('survey-eq-distance')).toHaveTextContent(
      formatDistanceKm(m.equirectangularKm),
    );
    expect(screen.getByTestId('survey-gc-distance')).toHaveTextContent(
      formatDistanceKm(m.greatCircleKm),
    );
    unmount();
  });

  it('shows the endpoints in BOTH forms by default (FR-16 両形式)', () => {
    const { store, unmount } = mountControls();
    confirmOneLine(store);

    const start = formatCoordinate(P1);
    const end = formatCoordinate(P2);
    expect(screen.getByTestId('survey-start-dms')).toHaveTextContent(start.latDms);
    expect(screen.getByTestId('survey-start-dms')).toHaveTextContent(start.lonDms);
    expect(screen.getByTestId('survey-start-decimal')).toHaveTextContent(
      start.latDecimal,
    );
    expect(screen.getByTestId('survey-start-decimal')).toHaveTextContent(
      start.lonDecimal,
    );
    expect(screen.getByTestId('survey-end-dms')).toHaveTextContent(end.latDms);
    expect(screen.getByTestId('survey-end-decimal')).toHaveTextContent(
      end.lonDecimal,
    );
    unmount();
  });

  it('the DMS / decimal switch narrows the display (UI-local state)', () => {
    const { store, unmount } = mountControls();
    confirmOneLine(store);

    fireEvent.click(screen.getByTestId('survey-format-dms'));
    expect(screen.getByTestId('survey-start-dms')).toBeInTheDocument();
    expect(screen.queryByTestId('survey-start-decimal')).toBeNull();

    fireEvent.click(screen.getByTestId('survey-format-decimal'));
    expect(screen.queryByTestId('survey-start-dms')).toBeNull();
    expect(screen.getByTestId('survey-start-decimal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('survey-format-both'));
    expect(screen.getByTestId('survey-start-dms')).toBeInTheDocument();
    expect(screen.getByTestId('survey-start-decimal')).toBeInTheDocument();
    unmount();
  });

  it('re-derives the distances when the equator length changes (FR-05 / FR-109 即時反映)', () => {
    const { store, unmount } = mountControls();
    confirmOneLine(store);

    const before = screen.getByTestId('survey-eq-distance').textContent;
    act(() => store.getState().updateProjectSetting('equatorLengthKm', 20000));

    const m = measureSurveyPair(
      P1,
      P2,
      createGeoParams(20000, DEFAULT_PROJECT_SETTINGS.flattening),
    );
    expect(screen.getByTestId('survey-eq-distance')).toHaveTextContent(
      formatDistanceKm(m.equirectangularKm),
    );
    expect(screen.getByTestId('survey-eq-distance').textContent).not.toBe(before);
    unmount();
  });

  it('shows NO readout when there is nothing to measure (教訓 5.18 explicit null)', () => {
    const { store, unmount } = mountControls();
    act(() => store.getState().surveyEnable());
    expect(screen.queryByTestId('survey-readout')).toBeNull();
    unmount();
  });
});
