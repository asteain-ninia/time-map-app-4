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
import { hiddenReasonsUnderFilter } from '../map/filtered-display';
import { COMMAND_REFUSAL, type CommandRegistry, type CommandId } from '../shell/commands';
import { resolveCommandEnabled } from '../shell/permissions';
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
  /**
   * 「ほかに n 件」を選んだときの行き先（手直し C3）。打った語を一覧の絞り込み欄へ
   * 入れて、その区画へ焦点を移す。**DOM を名前で探さない**ための細い口である。
   */
  readonly onShowInList?: (query: string) => void;
}

export function JumpPalette<S>(props: JumpPaletteProps<S>): JSX.Element | null {
  const {
    store,
    registry,
    getRoot,
    getTime,
    open,
    onClose,
    onFocusFeatureCamera,
    onShowInList,
  } = props;
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const filter = useStore(store, (s) => s.filter);
  const displayControl = useStore(store, (s) => s.displayControl);
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 開くたびに 1 つ進む。コマンドの一覧を組み直す合図（手直し C1）。 */
  const [openNonce, setOpenNonce] = useState(0);

  // 開くたびに空から始める（教訓 5.2: 一時的 UI 状態は全経路で捨てる）。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setOpenNonce((n) => n + 1);
    inputRef.current?.focus();
  }, [open]);

  // **閉じる契機**（手直し C2 / K-5。表示 ▾ とまったく同じ作法）。
  //
  // 旧版は Escape を入力欄の onKeyDown でしか拾っていなかったので、**外を押して
  // 焦点が body へ行くと Escape も効かず**、しかも開いているあいだは大域の鍵盤が
  // すべて止まる（shortcutsSuspended）ので、閉じる手段が 1 つも無くなった。
  // document を capture で聞けば、焦点がどこにあっても閉じられる。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) === true) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);

  // 道具・モードが変わったら閉じる（K-5: 一時的 UI 状態は全経路で捨てる）。開いたまま
  // モードが変わると、並んでいる候補の可否が黙って変わってしまう。
  const contextRef = useRef({ mode, activeTool });
  useEffect(() => {
    const prev = contextRef.current;
    contextRef.current = { mode, activeTool };
    if (!open) return;
    if (prev.mode === mode && prev.activeTool === activeTool) return;
    onClose();
  }, [open, mode, activeTool, onClose]);

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
    // **母集団は一覧とまったく同じ 1 本**（手直し B1 と同じ判断）。表示条件で隠れて
    // いる地物も候補に出す ―― Ctrl+P は「全機能への保険の経路」なので、隠したものへ
    // 辿り着けないと保険にならない。選べば「必ず描く」で地図にも出る（設計書 §D.6）。
    const hiddenReasons = hiddenReasonsUnderFilter(resolution, filter, all);
    const dup = duplicateNamedIds(all);
    const points =
      dup.size === 0
        ? new Map<FeatureId, { lon: number; lat: number }>()
        : representativePoints(all, verticesAt(root, time), dup);
    const ledgerFeatures = buildLedgerFeatures({
      features: all,
      anchorCounts: anchorCountsOf(root),
      hiddenReasons,
      points,
    });
    const byId = new Map(ledgerFeatures.map((f) => [f.id, f]));
    const qualifiers = buildQualifiers(ledgerFeatures, byId, buildForest(all));
    return ledgerFeatures.map((f) => ({
      id: f.id,
      name: f.name,
      qualifier: qualifiers.get(f.id) ?? null,
    }));
  }, [open, getRoot, getTime, domain, currentTime, filter, displayControl]);

  /**
   * 打てるコマンド（規則 4: > を先頭に付けたときだけ候補に出る）。
   *
   * **開くたびに組み直す**（手直し C1）。registry は合成ルートが 1 回だけ作る
   * オブジェクトで、中身（登録簿）はあとから effect で埋まる。[registry] を依存に
   * すると **初回描画の空の登録簿が凍って**、> を打っても候補が永久に 0 件になる
   * （教訓 5.5 の裏面: 参照が変わらない入れ物の、変わる中身に依存している）。
   * 開閉とモードも依存に入れて、開くたびにいまの可否で数え直す。
   *
   * **可否は resolveCommandEnabled で見る**（K-6）。registry.isRunnable だけだと
   * 権限の軸（読むだけ）を通らないので、削除や面を描くが読むだけの状態でも候補に
   * 出て、しかも実行できてしまう。
   */
  const commands = useMemo(
    () =>
      (Object.keys(MENU_ITEM_LABELS) as CommandId[])
        .filter((id) =>
          resolveCommandEnabled(id, { runnable: registry.isRunnable(id), mode }),
        )
        .map((id) => ({ id: id as string, label: MENU_ITEM_LABELS[id] })),
    [registry, mode, openNonce],
  );

  const result = useMemo(
    () =>
      jumpCandidates({
        query,
        features,
        commands,
        yearLabel: (year) => JUMP_STRINGS.yearCandidate(formatYear(year)),
        moreLabel: (count) => JUMP_STRINGS.more(count),
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
        case JUMP_CANDIDATE_KIND.Command: {
          const id = candidate.commandId as CommandId;
          // **権限の関門を必ず通す**（手直し C1 / K-6）。registry.dispatch を直接
          // 呼ぶと「読むだけ」の軸を通らないので、読むだけの状態から削除が走る。
          // メニューとショートカットが通しているのと同じ 1 本を通す。
          if (!resolveCommandEnabled(id, { runnable: registry.isRunnable(id), mode })) {
            registry.reportRefusal(id, COMMAND_REFUSAL.ViewOnly);
            break;
          }
          registry.dispatch(id);
          break;
        }
        case JUMP_CANDIDATE_KIND.More:
          // 「ほかに n 件」＝ 打った語で一覧を絞り込み、一覧へ焦点を移す（手直し C3）。
          onShowInList?.(candidate.query);
          break;
      }
      onClose();
    },
    [store, registry, mode, onClose, onFocusFeatureCamera, onShowInList],
  );

  if (!open) return null;

  const candidates = result.candidates;

  return (
    <div
      className="jump-palette"
      role="dialog"
      aria-label={JUMP_STRINGS.title}
      data-testid="jump-palette"
      ref={panelRef}
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
      {/* **閉じるボタンを置く**（手直し C2）。外を押しても Escape でも閉じるが、
          閉じ方が分かる形が画面に 1 つも無いのは C9 の①（出口の無い状態）である。 */}
      <button
        type="button"
        className="jump-palette__close"
        data-testid="jump-palette-close"
        onClick={onClose}
      >
        {JUMP_STRINGS.closeLabel}
      </button>
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
    case JUMP_CANDIDATE_KIND.More:
      return 'more';
  }
}
