// U20 React component tests: sidebar sections + tab switching (FR-111,
// 受け入れ基準 1).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sidebar, SIDEBAR_SECTION } from './Sidebar';

describe('Sidebar (FR-111)', () => {
  it('renders the three section panels and shows the initial one', () => {
    render(
      <Sidebar
        initialSection={SIDEBAR_SECTION.Events}
        eventsContent={<div data-testid="ev" />}
        featuresContent={<div data-testid="ft" />}
        propertiesContent={<div data-testid="pr" />}
      />,
    );
    expect(screen.getByTestId('sidebar-panel-events')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('sidebar-panel-features')).toHaveAttribute('hidden');
    expect(screen.getByTestId('sidebar-panel-properties')).toHaveAttribute('hidden');
  });

  it('switches the active section on tab click', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.Events} />);
    fireEvent.click(screen.getByTestId('sidebar-tab-properties'));
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('sidebar-panel-events')).toHaveAttribute('hidden');
  });

  it('wires each tab to its panel via id + aria-controls (WAI-ARIA tablist)', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.Events} />);
    const tab = screen.getByTestId('sidebar-tab-events');
    const panel = screen.getByTestId('sidebar-panel-events');
    expect(tab).toHaveAttribute('id', 'sidebar-tab-events');
    expect(tab).toHaveAttribute('aria-controls', 'sidebar-panel-events');
    expect(panel).toHaveAttribute('id', 'sidebar-panel-events');
    expect(panel).toHaveAttribute('aria-labelledby', 'sidebar-tab-events');
  });

  // review #2: focus must FOLLOW the arrow (WAI-ARIA tablist). Fire each keyDown on the
  // element that currently HAS focus (document.activeElement) — not on a hand-picked
  // button — so the test fails if the component only setActive()s without moving focus.
  it('ArrowRight moves the active section AND DOM focus to the next tab; wraps at the end', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.Events} />);
    // events → features → properties → events (order = events, features, properties).
    const eventsTab = screen.getByTestId('sidebar-tab-events');
    eventsTab.focus();
    expect(document.activeElement).toBe(eventsTab);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByTestId('sidebar-panel-features')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-features'));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-properties'));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); // wrap
    expect(screen.getByTestId('sidebar-panel-events')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-events'));
  });

  it('ArrowLeft moves the active section AND DOM focus to the previous tab; wraps at the start', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.Events} />);
    const eventsTab = screen.getByTestId('sidebar-tab-events');
    eventsTab.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' }); // wrap to last
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-properties'));
  });
});
