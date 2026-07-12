// U20 React component tests: sidebar sections + tab switching (FR-111,
// 受け入れ基準 1). HB6: the sidebar is now 一覧 + プロパティ の2タブ構成 (地物一覧 /
// 錨一覧 は 一覧タブ内の 現在時刻 / 通史 モードトグルへ統合).

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sidebar, SIDEBAR_SECTION } from './Sidebar';

describe('Sidebar (FR-111, HB6 2タブ構成)', () => {
  it('renders the 一覧 / プロパティ panels and shows the initial one', () => {
    render(
      <Sidebar
        initialSection={SIDEBAR_SECTION.List}
        listContent={<div data-testid="ls" />}
        propertiesContent={<div data-testid="pr" />}
      />,
    );
    expect(screen.getByTestId('sidebar-panel-list')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('sidebar-panel-properties')).toHaveAttribute('hidden');
    // The unified list content is injected into the 一覧 panel.
    expect(screen.getByTestId('ls')).toBeInTheDocument();
  });

  it('switches the active section on tab click', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.List} />);
    fireEvent.click(screen.getByTestId('sidebar-tab-properties'));
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('sidebar-panel-list')).toHaveAttribute('hidden');
  });

  it('wires each tab to its panel via id + aria-controls (WAI-ARIA tablist)', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.List} />);
    const tab = screen.getByTestId('sidebar-tab-list');
    const panel = screen.getByTestId('sidebar-panel-list');
    expect(tab).toHaveAttribute('id', 'sidebar-tab-list');
    expect(tab).toHaveAttribute('aria-controls', 'sidebar-panel-list');
    expect(panel).toHaveAttribute('id', 'sidebar-panel-list');
    expect(panel).toHaveAttribute('aria-labelledby', 'sidebar-tab-list');
  });

  // review #2: focus must FOLLOW the arrow (WAI-ARIA tablist). Fire each keyDown on the
  // element that currently HAS focus (document.activeElement) — not on a hand-picked
  // button — so the test fails if the component only setActive()s without moving focus.
  it('ArrowRight moves the active section AND DOM focus to the next tab; wraps at the end', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.List} />);
    // order = list, properties.
    const listTab = screen.getByTestId('sidebar-tab-list');
    listTab.focus();
    expect(document.activeElement).toBe(listTab);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-properties'));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); // wrap
    expect(screen.getByTestId('sidebar-panel-list')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-list'));
  });

  it('ArrowLeft moves the active section AND DOM focus to the previous tab; wraps at the start', () => {
    render(<Sidebar initialSection={SIDEBAR_SECTION.List} />);
    const listTab = screen.getByTestId('sidebar-tab-list');
    listTab.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' }); // wrap to last
    expect(screen.getByTestId('sidebar-panel-properties')).not.toHaveAttribute('hidden');
    expect(document.activeElement).toBe(screen.getByTestId('sidebar-tab-properties'));
  });
});
