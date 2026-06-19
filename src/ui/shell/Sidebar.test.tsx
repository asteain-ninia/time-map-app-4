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
});
