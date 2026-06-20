// U32: open-detail-panels model tests (FR-99後段).

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import {
  DETAIL_PANEL_CASCADE_PX,
  EMPTY_DETAIL_PANELS,
  closePanel,
  isPanelOpen,
  openPanel,
  panelIdFor,
} from './detail-panels';

const fA = asFeatureId('A');
const fB = asFeatureId('B');
const at0 = { x: 100, y: 100 };

describe('detail-panels model (FR-99: 複数同時・個別開閉)', () => {
  it('opens a panel for a feature', () => {
    const s = openPanel(EMPTY_DETAIL_PANELS, fA, at0);
    expect(s.panels).toHaveLength(1);
    expect(isPanelOpen(s, fA)).toBe(true);
  });

  it('opens panels for DIFFERENT features simultaneously, cascaded', () => {
    let s = openPanel(EMPTY_DETAIL_PANELS, fA, at0);
    s = openPanel(s, fB, at0);
    expect(s.panels).toHaveLength(2);
    expect(isPanelOpen(s, fA)).toBe(true);
    expect(isPanelOpen(s, fB)).toBe(true);
    // The second panel is offset so it does not perfectly cover the first.
    expect(s.panels[1]!.position.x).toBe(at0.x + DETAIL_PANEL_CASCADE_PX);
  });

  it('opening the same feature twice is idempotent', () => {
    let s = openPanel(EMPTY_DETAIL_PANELS, fA, at0);
    s = openPanel(s, fA, at0);
    expect(s.panels).toHaveLength(1);
  });

  it('closes one panel and leaves the rest', () => {
    let s = openPanel(EMPTY_DETAIL_PANELS, fA, at0);
    s = openPanel(s, fB, at0);
    s = closePanel(s, panelIdFor(fA));
    expect(isPanelOpen(s, fA)).toBe(false);
    expect(isPanelOpen(s, fB)).toBe(true);
  });

  it('closing an absent panel is a no-op', () => {
    const s = openPanel(EMPTY_DETAIL_PANELS, fA, at0);
    expect(closePanel(s, 'detail-nope')).toBe(s);
  });
});
