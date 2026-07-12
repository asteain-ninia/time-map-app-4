// UI layer (U20 / shell): the right sidebar (FR-111).
//
// TWO section "入れ物" — 一覧 / プロパティ — as switchable tabs (HB6: the former
// 地物一覧 / 錨一覧 tabs are unified into ONE「一覧」tab whose 現在時刻 / 通史 mode
// toggle lives inside its content slot). This unit provides the sections and the
// switch only; each section's content (the unified list, the property form) is
// filled by SidebarContent. Section slots are passed as optional children so the
// content unit injects them without this component knowing their shape.

import { useCallback, useState, type ReactNode } from 'react';

import { nextTabForArrow } from '../a11y/index';
import { APP_STRINGS, SIDEBAR_SECTION_TITLES } from './strings';

/** The sidebar section keys, in tab order. */
export const SIDEBAR_SECTION = {
  List: 'list',
  Properties: 'properties',
} as const;

export type SidebarSection = (typeof SIDEBAR_SECTION)[keyof typeof SIDEBAR_SECTION];

export interface SidebarProps {
  /**
   * The unified「一覧」slot (HB6): 現在時刻(旧地物一覧) / 通史(旧錨一覧) の内部トグルを
   * 持つ一覧。SidebarContent が組み立てて渡す。
   */
  readonly listContent?: ReactNode;
  /** The プロパティ slot. */
  readonly propertiesContent?: ReactNode;
  /** Initial active section. Default: properties. */
  readonly initialSection?: SidebarSection;
}

const SECTION_ORDER: readonly SidebarSection[] = [
  SIDEBAR_SECTION.List,
  SIDEBAR_SECTION.Properties,
];

const SECTION_TITLE: Readonly<Record<SidebarSection, string>> = {
  [SIDEBAR_SECTION.List]: SIDEBAR_SECTION_TITLES.list,
  [SIDEBAR_SECTION.Properties]: SIDEBAR_SECTION_TITLES.properties,
};

export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    listContent,
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
    [SIDEBAR_SECTION.List]: listContent,
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
