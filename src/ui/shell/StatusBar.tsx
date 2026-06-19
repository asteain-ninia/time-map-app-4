// UI layer (U20 / shell): the bottom status bar (FR-111).
//
// The "入れ物" for status text only; the actual status content (coordinates,
// scale, messages) is filled by later units (spec スコープ). A default ready
// label is shown when no content is supplied.

import { type ReactNode } from 'react';

import { APP_STRINGS, STATUS_STRINGS } from './strings';

export interface StatusBarProps {
  readonly children?: ReactNode;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  return (
    <footer
      className="statusbar"
      aria-label={APP_STRINGS.statusbarAriaLabel}
      data-testid="statusbar"
    >
      {props.children ?? <span className="statusbar__ready">{STATUS_STRINGS.ready}</span>}
    </footer>
  );
}
