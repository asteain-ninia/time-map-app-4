// UI layer (U20 / shell): the shared tooltip primitive (FR-112 / FR-115).
//
// A common操作ガイド tooltip for toolbar buttons and menu items. Japanese text
// is supplied by the caller from the centralised strings module (strings.ts).
// The tooltip surfaces on hover/focus via the native `title` and an aria
// description, and renders an explicit bubble on hover so the guide text is
// asserted in component tests (受け入れ基準 6).

import { useId, useState, type ReactNode } from 'react';

export interface TooltipProps {
  /** The Japanese guide text (FR-115). */
  readonly text: string;
  readonly children: ReactNode;
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const { text, children } = props;
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={id} title={text}>
        {children}
      </span>
      <span role="tooltip" id={id} hidden={!open} className="tooltip__bubble">
        {text}
      </span>
    </span>
  );
}
