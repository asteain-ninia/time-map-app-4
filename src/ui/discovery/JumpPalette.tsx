// 「どこへでも移動」（Ctrl+P。設計書 §C.2 の 26 / §I.2）。
//
// **全機能への保険の経路**。地物名・年・コマンドを 1 本の入力で探して飛ぶ。
// 絞り込みの規則は `jump-palette.ts` に 5 つ固定してある（ここは器と結線だけ）。
//
// **C10 の罠を作り直さない**: 現状の「地物を検索」は年を属性の検索対象に入れているので、
// 数字 1 文字でほぼ全件が一致する。ここは「数字だけなら年の候補しか出さない」を
// 純関数の側で固定してあり、この器はその結果を並べるだけである。
//
// **母集団は一覧と同じ 1 本**（E-6 / N-41 の解消）。表示条件を通った地物だけが候補に出る。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { buildForest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { timePointYear } from '../../domain/time/time-point';

import { featuresAt, verticesAt } from '../live-lookup';
import { resolveDisplayFor } from '../map/display-resolution-cache';
import { isFeatureVisibleUnderFilter } from '../map/filtered-display';
import type { CommandRegistry, CommandId } from '../shell/commands';
import { MENU_ITEM_LABELS } from '../shell/strings';
import { TIME_CHANGE_SOURCE, type SessionStore } from '../state/store';
import { formatYear } from '../timeline/time-display';

import { buildQualifiers } from './ledger';
import {
  buildLedgerFeatures,
  anchorCountsOf,
  duplicateNamedIds,
  representativePoints,
} from './ledger-source';
import { JUMP_CANDIDATE_KIND, jumpCandidates, type JumpCandidate } from './jump-palette';
import { JUMP_STRINGS } from './strings';

export interface JumpPaletteProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly registry: CommandRegistry;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  /** 開いているか（合成ルートがコマンドで開く）。 */
  readonly open: boolean;
  readonly onClose: () => void;
  /** 地物へ飛んだときに視点を合わせる（一覧の行と同じ 1 本）。 */
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
}

export function JumpPalette<S>(props: JumpPaletteProps<S>): JSX.Element | null {
  const { store, registry, getRoot, getTime, open, onClose, onFocusFeatureCamera } = props;
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const filter = useStore(store, (s) => s.filter);
  const displayControl = useStore(store, (s) => s.displayControl);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 開くたびに空から始める（教訓 5.2: 一時的 UI 状態は全経路で捨てる）。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  /**
   * 候補の母集団。**一覧とまったく同じ 1 本**（表示条件を通った地物だけ）で、
   * 同名の見分けも台帳と同じ規則から作る（設計書 §C.2 の 26 の規則 3）。
   * 開いているあいだだけ組む（閉じているのに毎フレーム組まない）。
   */
  const features = useMemo(() => {
    if (!open) return [];
    const root = getRoot();
    const time = getTime();
    const all = featuresAt(root, time);
    const resolution = resolveDisplayFor(root, time, displayControl);
    const shown = all.filter((f) => isFeatureVisibleUnderFilter(resolution, filter, f.id));
    const dup = duplicateNamedIds(shown);
    const points =
      dup.size === 0
        ? new Map<FeatureId, { lon: number; lat: number }>()
        : representativePoints(shown, verticesAt(root, time), dup);
    const ledgerFeatures = buildLedgerFeatures({
      features: shown,
      anchorCounts: anchorCountsOf(root),
      hidden: () => false,
      visible: () => true,
      points,
    });
    const byId = new Map(ledgerFeatures.map((f) => [f.id, f]));
    const qualifiers = buildQualifiers(ledgerFeatures, byId, buildForest(shown));
    return ledgerFeatures.map((f) => ({
      id: f.id,
      name: f.name,
      qualifier: qualifiers.get(f.id) ?? null,
    }));
  }, [open, getRoot, getTime, domain, currentTime, filter, displayControl]);

  /** 打てるコマンド（規則 4: `>` のときだけ候補に出る）。 */
  const commands = useMemo(
    () =>
      (Object.keys(MENU_ITEM_LABELS) as CommandId[])
        .filter((id) => registry.isRunnable(id))
        .map((id) => ({ id: id as string, label: MENU_ITEM_LABELS[id] })),
    [registry],
  );

  const result = useMemo(
    () =>
      jumpCandidates({
        query,
        features,
        commands,
        yearLabel: (year) => JUMP_STRINGS.yearCandidate(formatYear(year)),
      }),
    [query, features, commands],
  );

  const run = useCallback(
    (candidate: JumpCandidate | undefined): void => {
      if (candidate === undefined) return;
      const s = store.getState();
      switch (candidate.kind) {
        case JUMP_CANDIDATE_KIND.Year:
          s.setCurrentTime(timePointYear(candidate.year), TIME_CHANGE_SOURCE.NumericJump);
          break;
        case JUMP_CANDIDATE_KIND.Feature:
          // 選択とカメラは **一覧の行とまったく同じ 1 本**を通す（教訓 5.29）。
          s.setActiveFeature(candidate.featureId);
          onFocusFeatureCamera?.(candidate.featureId);
          break;
        case JUMP_CANDIDATE_KIND.Command:
          registry.dispatch(candidate.commandId as CommandId);
          break;
      }
      onClose();
    },
    [store, registry, onClose, onFocusFeatureCamera],
  );

  if (!open) return null;

  const candidates = result.candidates;

  return (
    <div
      className="jump-palette"
      role="dialog"
      aria-label={JUMP_STRINGS.title}
      data-testid="jump-palette"
    >
      <input
        ref={inputRef}
        type="text"
        className="jump-palette__input"
        data-testid="jump-palette-input"
        aria-label={JUMP_STRINGS.inputAria}
        placeholder={JUMP_STRINGS.placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((v) => Math.min(v + 1, Math.max(candidates.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((v) => Math.max(v - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(candidates[active]);
          }
        }}
      />
      {candidates.length === 0 ? (
        <p className="jump-palette__empty" data-testid="jump-palette-empty">
          {query.trim() === '' ? JUMP_STRINGS.commandPrefixHint : JUMP_STRINGS.noCandidate}
        </p>
      ) : (
        <ul className="jump-palette__list">
          {candidates.map((c, i) => (
            <li key={candidateKey(c)}>
              <button
                type="button"
                className="jump-palette__item"
                data-testid={`jump-palette-item-${candidateKey(c)}`}
                data-kind={c.kind}
                aria-pressed={i === active}
                onClick={() => run(c)}
              >
                <span className="jump-palette__item-label">{c.label}</span>
                {c.kind === JUMP_CANDIDATE_KIND.Feature && c.qualifier !== null && (
                  <span className="jump-palette__item-note">{c.qualifier}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.truncated > 0 && (
        <p className="jump-palette__more" data-testid="jump-palette-more">
          {JUMP_STRINGS.more(result.truncated)}
        </p>
      )}
    </div>
  );
}

/** 候補の鍵（React の key と `data-testid` の末尾）。 */
function candidateKey(c: JumpCandidate): string {
  switch (c.kind) {
    case JUMP_CANDIDATE_KIND.Year:
      return `year-${String(c.year)}`;
    case JUMP_CANDIDATE_KIND.Feature:
      return c.featureId as unknown as string;
    case JUMP_CANDIDATE_KIND.Command:
      return c.commandId;
  }
}
