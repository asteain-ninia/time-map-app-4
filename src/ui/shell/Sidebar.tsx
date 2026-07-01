// UI layer (U20 / shell): the right sidebar (FR-111).
//
// Three section "入れ物" — イベント一覧 / 地物一覧 / プロパティ — as switchable
// tabs. This unit provides the sections and the switch only; each section's
// content (event list, feature tree, property form) is filled by later units
// (spec スコープ「やらないこと」). Section slots are passed as optional children
// so a later unit injects content without this component knowing its shape.

import { useCallback, useState, type ReactNode } from 'react';

import { nextTabForArrow } from '../a11y/index';
import { APP_STRINGS, SIDEBAR_SECTION_TITLES } from './strings';

/** The sidebar section keys, in tab order. */
export const SIDEBAR_SECTION = {
  Events: 'events',
  Features: 'features',
  Properties: 'properties',
} as const;

export type SidebarSection = (typeof SIDEBAR_SECTION)[keyof typeof SIDEBAR_SECTION];

export interface SidebarProps {
  /** Optional content slots for each section (later units fill these). */
  readonly eventsContent?: ReactNode;
  readonly featuresContent?: ReactNode;
  readonly propertiesContent?: ReactNode;
  /** Initial active section. Default: properties. */
  readonly initialSection?: SidebarSection;
}

const SECTION_ORDER: readonly SidebarSection[] = [
  SIDEBAR_SECTION.Events,
  SIDEBAR_SECTION.Features,
  SIDEBAR_SECTION.Properties,
];

const SECTION_TITLE: Readonly<Record<SidebarSection, string>> = {
  [SIDEBAR_SECTION.Events]: SIDEBAR_SECTION_TITLES.events,
  [SIDEBAR_SECTION.Features]: SIDEBAR_SECTION_TITLES.features,
  [SIDEBAR_SECTION.Properties]: SIDEBAR_SECTION_TITLES.properties,
};

export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    eventsContent,
    featuresContent,
    propertiesContent,
    initialSection = SIDEBAR_SECTION.Properties,
  } = props;
  const [active, setActive] = useState<SidebarSection>(initialSection);

  // Arrow-key traversal between the section tabs (WAI-ARIA tablist pattern). Focus
  // FOLLOWS the arrow (setActive alone would leave DOM focus on the old tab, violating
  // the tablist contract), so move focus to the target tab too (bughunt review #2).
  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const next = nextTabForArrow(SECTION_ORDER, active, e.key);
      if (next === null) return;
      e.preventDefault();
      setActive(next);
      document.getElementById(`sidebar-tab-${next}`)?.focus();
    },
    [active],
  );

  const content: Record<SidebarSection, ReactNode> = {
    [SIDEBAR_SECTION.Events]: eventsContent,
    [SIDEBAR_SECTION.Features]: featuresContent,
    [SIDEBAR_SECTION.Properties]: propertiesContent,
  };

  return (
    <aside className="sidebar" aria-label={APP_STRINGS.sidebarAriaLabel} data-testid="sidebar">
      <div className="sidebar__tabs" role="tablist" aria-label={APP_STRINGS.sidebarAriaLabel}>
        {SECTION_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`sidebar-tab-${key}`}
            aria-controls={`sidebar-panel-${key}`}
            aria-selected={active === key}
            data-testid={`sidebar-tab-${key}`}
            onClick={() => setActive(key)}
            onKeyDown={onTabKeyDown}
          >
            {SECTION_TITLE[key]}
          </button>
        ))}
      </div>
      {SECTION_ORDER.map((key) => (
        <section
          key={key}
          role="tabpanel"
          id={`sidebar-panel-${key}`}
          aria-labelledby={`sidebar-tab-${key}`}
          hidden={active !== key}
          className="sidebar__panel"
          data-testid={`sidebar-panel-${key}`}
        >
          {content[key]}
        </section>
      ))}
    </aside>
  );
}
