// UI layer (HB-8 / HB-9): wire the ツール and ヘルプ menu commands to live UI.
//
// HB-8 / HB-9 ROOT FIX — the five ids ToolsSettings / ToolsSearch / HelpAbout /
// HelpShortcuts / HelpDiagnostics were declared (commands.ts) and placed in the
// ツール / ヘルプ menus (menu.ts), but NO unit ever registered a handler for them.
// The shell's single enabled rule (permissions.resolveCommandEnabled) treats an
// unregistered command as 無効, so every one of those menu items rendered
// permanently grayed (the same dead-command class as HB-4). This controller is
// the missing 結線 (教訓 5.7 合成ルートの結線漏れ): it registers a handler for each
// id on the SAME CommandRegistry the menu + shortcuts dispatch (教訓 5.13 単一の
// 真実源), each handler OPENS the corresponding view, and the registrations are
// torn down on unmount (useEffect cleanup unregister — the ViewToggleViewMode
// pattern in App.tsx). It also OWNS the small modal state (which view is open) and
// renders the existing 設定ダイアログ (U38) plus the 検索 / 診断 / バージョン /
// ショートカット一覧 views built here over existing pure logic (U41 search/log,
// U20 menu/shortcut formatters) — no new domain logic.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';
import {
  CommandRegistry,
  COMMAND_ID,
  formatShortcut,
  detectPlatform,
  listShortcutEntries,
  type Platform,
  ABOUT_STRINGS,
  SHORTCUTS_STRINGS,
} from '../shell/index';
import { SettingsDialog } from '../settings/index';
import {
  searchFeatures,
  validateSearchQuery,
  kindAxisOf,
  SEARCH_STRINGS,
  DIAGNOSTICS_STRINGS,
  type SearchableFeature,
  type SearchResult,
  MATCH_FIELD,
} from '../discovery/index';
import { featuresAt } from '../live-lookup';
import { buildCommittedFeatures } from '../map/committed-features';
import type { Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';

/** Which help/tools view is currently open (only one at a time). */
const HELP_VIEW = {
  None: 'none',
  Settings: 'settings',
  Search: 'search',
  About: 'about',
  Shortcuts: 'shortcuts',
  Diagnostics: 'diagnostics',
} as const;

type HelpView = (typeof HELP_VIEW)[keyof typeof HELP_VIEW];

export interface HelpToolsControllerProps {
  /** The live session store (settings truth + current time + domain root). */
  readonly store: StoreApi<SessionStore<DomainProject>>;
  /** The SAME registry the menu + shortcuts dispatch (教訓 5.13). */
  readonly registry: CommandRegistry;
  /** Platform for accelerator labels in the shortcut list (testable injection). */
  readonly platform?: Platform;
  /**
   * Report whether one of this controller's modals (設定 / 検索 / バージョン /
   * ショートカット一覧 / 診断) is open (bughunt3 H1). The modal-open state lives HERE,
   * not in App.tsx, so the host cannot suspend the global shortcut dispatcher without
   * this lift. The host ORs it into shortcutsSuspended so Ctrl+Z / Delete cannot leak
   * THROUGH an open dialog to a domain op (these dialogs handle only Esc/Tab via React
   * onKeyDown, which a native window listener ignores). Fires on every open/close.
   */
  readonly onModalOpenChange?: (open: boolean) => void;
}

/**
 * Register the ツール / ヘルプ command handlers and render the views they open.
 *
 * The registration is the HB-8/HB-9 fix; the views are intentionally lightweight
 * (the spec calls for 既存 UI を結線, with a最小実装 where none exists). 設定 reuses
 * the full U38 dialog; 検索 / 診断 / バージョン / ショートカット一覧 are built here
 * over existing pure logic. Each view exposes a data-testid observation hook
 * (既存 app-active-feature 方式) so the behavioural E2E can assert the click opened
 * it. NO truth lives in this component beyond the transient "which view is open".
 */
export function HelpToolsController(props: HelpToolsControllerProps): JSX.Element | null {
  const { store, registry } = props;
  const [view, setView] = useState<HelpView>(HELP_VIEW.None);

  // HB-8 / HB-9 — register all five handlers on the shared registry and tear them
  // down on unmount (the ViewToggleViewMode pattern). Each handler只 opens a view;
  // they carry no `canRun` gate (these are always-available help/tools commands,
  // not editing commands — permissions.ts keeps them enabled in every mode).
  useEffect(() => {
    registry.register(COMMAND_ID.ToolsSettings, { run: () => setView(HELP_VIEW.Settings) });
    registry.register(COMMAND_ID.ToolsSearch, { run: () => setView(HELP_VIEW.Search) });
    registry.register(COMMAND_ID.HelpAbout, { run: () => setView(HELP_VIEW.About) });
    registry.register(COMMAND_ID.HelpShortcuts, { run: () => setView(HELP_VIEW.Shortcuts) });
    registry.register(COMMAND_ID.HelpDiagnostics, { run: () => setView(HELP_VIEW.Diagnostics) });
    return () => {
      registry.unregister(COMMAND_ID.ToolsSettings);
      registry.unregister(COMMAND_ID.ToolsSearch);
      registry.unregister(COMMAND_ID.HelpAbout);
      registry.unregister(COMMAND_ID.HelpShortcuts);
      registry.unregister(COMMAND_ID.HelpDiagnostics);
    };
  }, [registry]);

  // bughunt3 (H1): mirror "a modal is open" up to the host so it can suspend the
  // global shortcut dispatcher while one of these dialogs owns the keyboard. The view
  // state here is the single truth; we only reflect it (no duplicate flag). Cleared on
  // unmount so a torn-down controller never leaves the dispatcher suspended (教訓 5.2).
  const onModalOpenChange = props.onModalOpenChange;
  const modalOpenRef = useRef(false);
  useEffect(() => {
    if (onModalOpenChange === undefined) return;
    const open = view !== HELP_VIEW.None;
    if (open !== modalOpenRef.current) {
      modalOpenRef.current = open;
      onModalOpenChange(open);
    }
    return () => {
      if (modalOpenRef.current) {
        modalOpenRef.current = false;
        onModalOpenChange(false);
      }
    };
  }, [view, onModalOpenChange]);

  const close = (): void => setView(HELP_VIEW.None);

  switch (view) {
    case HELP_VIEW.Settings:
      // The full U38 dialog, bound to the live store slice. It owns its own draft /
      // confirm / cancel; onClose returns to None (its cancel + Esc + backdrop all
      // route through here). Base-map replacement is U18's — not wired here.
      return <SettingsDialog store={store.getState()} onClose={close} />;
    case HELP_VIEW.Search:
      return <SearchView store={store} onClose={close} />;
    case HELP_VIEW.About:
      return <AboutView onClose={close} />;
    case HELP_VIEW.Shortcuts:
      return (
        <ShortcutsView
          {...(props.platform !== undefined ? { platform: props.platform } : {})}
          onClose={close}
        />
      );
    case HELP_VIEW.Diagnostics:
      return <DiagnosticsView store={store} onClose={close} />;
    case HELP_VIEW.None:
    default:
      return null;
  }
}

// --- a tiny shared modal frame ----------------------------------------------

/**
 * A minimal modal frame shared by the help/tools views (backdrop + centred panel +
 * close). The backdrop click and the close button both call `onClose` (教訓 5.2:
 * every exit path closes). `testid` identifies the view for the behavioural E2E.
 */
function HelpModal(props: {
  readonly testid: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="help-modal-root" data-testid={`${props.testid}-root`}>
      <div
        className="help-backdrop"
        data-testid={`${props.testid}-backdrop`}
        aria-hidden="true"
        onClick={props.onClose}
      />
      <div
        className="help-dialog"
        data-testid={props.testid}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header className="help-dialog__header">
          <h2 className="help-dialog__title">{props.title}</h2>
        </header>
        <div className="help-dialog__body">{props.children}</div>
        <footer className="help-dialog__footer">
          <button
            type="button"
            className="help-dialog__close"
            data-testid={`${props.testid}-close`}
            onClick={props.onClose}
          >
            {props.closeLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

// --- 検索 (HB-8 / FR-113) ----------------------------------------------------

/**
 * Build the search corpus from the ACTUAL drawn母集合 (教訓 5.3 / 教訓 5.29 二重真実源
 * を作らない): we take the SAME `buildCommittedFeatures` set the map renders — which
 * has the store's display-control (global depth N + individual focus, FR-42/FR-43)
 * already applied through U34 — so the search sees EXACTLY what is visible, never a
 * feature the depth rollup hid (a leaf folded into an aggregate) nor one the focus
 * removed. Each drawn entry is enriched with its source feature's searchable
 * attributes (種別ラベル / 年代) by id so name AND attribute matching both work
 * (FR-113). Read fresh per search so a time / display-control change re-derives it
 * (教訓 5.5/5.6).
 */
function buildSearchCorpus(store: StoreApi<SessionStore<DomainProject>>): SearchableFeature[] {
  const s = store.getState();
  // The drawn set (display-control honoured). Its `id` is the feature id; `label`
  // is the feature name; `kind` is the coarse render kind ('point'|'line'|'area').
  const drawn = buildCommittedFeatures(s.domain, s.currentTime, s.activeFeature, s.displayControl);
  // Source features at the current time, indexed for attribute enrichment.
  const byId = new Map<string, Feature>(
    featuresAt(s.domain, s.currentTime).map((f) => [f.id as unknown as string, f]),
  );

  const corpus: SearchableFeature[] = [];
  for (const d of drawn) {
    const source = byId.get(d.id);
    const attributes =
      source !== undefined
        ? [
            ...(source.kindLabel !== undefined ? [source.kindLabel] : []),
            String(source.attributes.startYear),
            String(source.attributes.endYear),
          ]
        : [];
    corpus.push({
      id: d.id as unknown as FeatureId,
      // The render kind axis already aligns with FeatureKindAxis ('point'|'line'|
      // 'area'); map through the single helper for安全 (aggregates surface as area).
      kind: d.kind === 'point' ? kindAxisOf('point') : d.kind === 'line' ? kindAxisOf('line') : kindAxisOf('leaf'),
      name: d.label,
      // Description is not carried on the drawn record; name + attribute matching
      // cover FR-113 for this view. Pure corpus.
      description: '',
      attributes,
    });
  }
  return corpus;
}

function SearchView(props: {
  readonly store: StoreApi<SessionStore<DomainProject>>;
  readonly onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runSearch = (): void => {
    // Route through the SAME validation入口 every search path uses (validation入口
    // 契約 / FR-116): empty / >256 chars are rejected with a日本語 message rather
    // than silently running. Only a valid (trimmed, length-bounded) query searches.
    const validated = validateSearchQuery(query);
    if (!validated.ok) {
      setError(validated.message);
      setResult(null);
      return;
    }
    setError(null);
    // Pure search over the ACTUAL drawn母集合 (教訓 5.3 / 5.5). Re-derives the corpus
    // each click so it reflects the current time + display-control.
    setResult(searchFeatures(buildSearchCorpus(props.store), validated.value));
  };

  return (
    <HelpModal
      testid="search-panel"
      title={SEARCH_STRINGS.panelTitle}
      closeLabel={ABOUT_STRINGS.close}
      onClose={props.onClose}
    >
      <p className="help-dialog__hint">{SEARCH_STRINGS.help}</p>
      <div className="search-panel__input-row">
        <label htmlFor="search-panel-input">{SEARCH_STRINGS.inputLabel}</label>
        <input
          id="search-panel-input"
          type="text"
          data-testid="search-panel-input"
          aria-label={SEARCH_STRINGS.inputLabel}
          placeholder={SEARCH_STRINGS.inputPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
          }}
        />
        <button
          type="button"
          data-testid="search-panel-run"
          onClick={runSearch}
        >
          {SEARCH_STRINGS.searchButtonLabel}
        </button>
      </div>

      {error !== null && (
        <p className="search-panel__error" role="alert" data-testid="search-panel-error">
          {error}
        </p>
      )}

      {result !== null && (
        <section className="search-panel__results" data-testid="search-panel-results">
          <h3>{SEARCH_STRINGS.resultsTitle}</h3>
          {result.hits.length === 0 ? (
            <p data-testid="search-panel-no-results">{SEARCH_STRINGS.noResults}</p>
          ) : (
            <ul>
              {result.hits.map((hit) => (
                <li key={hit.featureId} data-testid="search-panel-hit">
                  <span className="search-panel__hit-name">{hit.name}</span>
                  <span className="search-panel__hit-fields">
                    {hit.matchedFields
                      .map((f) =>
                        f === MATCH_FIELD.Name
                          ? SEARCH_STRINGS.matchedInName
                          : f === MATCH_FIELD.Description
                            ? SEARCH_STRINGS.matchedInDescription
                            : SEARCH_STRINGS.matchedInAttribute,
                      )
                      .join(' / ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </HelpModal>
  );
}

// --- バージョン情報 (HB-9 / FR-111) ------------------------------------------

function AboutView(props: { readonly onClose: () => void }): JSX.Element {
  return (
    <HelpModal
      testid="about-panel"
      title={ABOUT_STRINGS.title}
      closeLabel={ABOUT_STRINGS.close}
      onClose={props.onClose}
    >
      <p className="about-panel__name">{ABOUT_STRINGS.appName}</p>
      <p className="about-panel__version">
        {ABOUT_STRINGS.versionLabel}:{' '}
        {/* Injected from package.json at build time (electron.vite.config.ts define);
            ONE source of truth for the displayed version (HB-9). */}
        <span data-testid="about-panel-version">{__APP_VERSION__}</span>
      </p>
      <p className="about-panel__description">{ABOUT_STRINGS.description}</p>
    </HelpModal>
  );
}

// --- ショートカット一覧 (HB-9 / FR-111) --------------------------------------

function ShortcutsView(props: {
  readonly platform?: Platform;
  readonly onClose: () => void;
}): JSX.Element {
  // Resolve the display platform once: "Ctrl" on Windows/Linux, "⌘" on macOS
  // (HB-2 formatter). Derived from the SAME STANDARD_MENUS accelerators the menu
  // bar + keymap use (§4 単一の真実源), so this list can never diverge.
  const platform = props.platform ?? detectPlatform();
  const entries = listShortcutEntries();

  return (
    <HelpModal
      testid="shortcuts-panel"
      title={SHORTCUTS_STRINGS.title}
      closeLabel={SHORTCUTS_STRINGS.close}
      onClose={props.onClose}
    >
      {entries.length === 0 ? (
        <p>{SHORTCUTS_STRINGS.empty}</p>
      ) : (
        <table className="shortcuts-panel__table">
          <thead>
            <tr>
              <th>{SHORTCUTS_STRINGS.commandColumn}</th>
              <th>{SHORTCUTS_STRINGS.keyColumn}</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // HB-10: a command may list MORE THAN ONE accelerator (redo's Ctrl+Y
              // と Ctrl+Shift+Z). The FIRST (primary) row keeps the stable
              // per-command testid (shortcuts-panel-key-<id>); alias rows get a
              // chord-suffixed testid so every key cell is uniquely addressable and
              // no two share a data-testid (strict getByTestId stays unambiguous).
              const seen = new Set<string>();
              return entries.map((entry) => {
                const chordLabel = formatShortcut(entry.shortcut, platform);
                const isPrimary = !seen.has(entry.commandId);
                seen.add(entry.commandId);
                const keyTestid = isPrimary
                  ? `shortcuts-panel-key-${entry.commandId}`
                  : `shortcuts-panel-key-${entry.commandId}-${chordLabel}`;
                return (
                  <tr key={`${entry.commandId}:${chordLabel}`} data-testid="shortcuts-panel-row">
                    <td>{entry.label}</td>
                    <td data-testid={keyTestid}>{chordLabel}</td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
      )}
    </HelpModal>
  );
}

// --- 診断情報 (HB-9 / FR-117) ------------------------------------------------

/** Format a TimePoint as a year label for the diagnostics 概況 (簡潔; FR-117). */
function currentTimeLabel(store: StoreApi<SessionStore<DomainProject>>): string {
  const t = store.getState().currentTime;
  return `${String(t.year)}年`;
}

function DiagnosticsView(props: {
  readonly store: StoreApi<SessionStore<DomainProject>>;
  readonly onClose: () => void;
}): JSX.Element {
  // A non-sensitive アプリ概況 derived from the live store (FR-117 / FR-02: counts +
  // flags only, never project content). featureCount = features effective NOW.
  const s = props.store.getState();
  const featureCount = featuresAt(s.domain, s.currentTime).length;
  const hasUnsavedChanges = s.projectDirty;

  return (
    <HelpModal
      testid="diagnostics-panel"
      title={DIAGNOSTICS_STRINGS.panelTitle}
      closeLabel={ABOUT_STRINGS.close}
      onClose={props.onClose}
    >
      <p className="help-dialog__hint">{DIAGNOSTICS_STRINGS.help}</p>

      <section className="diagnostics-panel__overview">
        <h3>{DIAGNOSTICS_STRINGS.summarySectionTitle}</h3>
        <dl>
          <dt>地物数</dt>
          <dd data-testid="diagnostics-feature-count">{featureCount}</dd>
          <dt>{DIAGNOSTICS_STRINGS.fieldContextTime}</dt>
          <dd data-testid="diagnostics-current-time">{currentTimeLabel(props.store)}</dd>
          <dt>未保存の変更</dt>
          <dd data-testid="diagnostics-unsaved">{hasUnsavedChanges ? 'あり' : 'なし'}</dd>
        </dl>
      </section>

      <section className="diagnostics-panel__log">
        <h3>{DIAGNOSTICS_STRINGS.logSectionTitle}</h3>
        {/* No live error-log buffer is plumbed into this seam yet; show the empty
            state (FR-117). The 概況 above is the actionable diagnostic today. */}
        <p data-testid="diagnostics-empty-log">{DIAGNOSTICS_STRINGS.emptyLog}</p>
      </section>

      <p className="diagnostics-panel__privacy">{DIAGNOSTICS_STRINGS.privacyNote}</p>
    </HelpModal>
  );
}
