// UI layer (U21 / 時刻レール): 112px の 4 段（設計書 §C.7）。
//
// (a) 読み取り 24 ／ (b) 錨レーン 28 ／ (c) 目盛り＋再生ヘッド 22 ／ (d) 操作列 32。
// 上下の余白 2+2 と枠線 1×2 を足して **112px 固定**。旧実装は 201.2px（窓の 25.1%）を
// 占めていて、しかも情報（錨）の描画面積が 0px だった ―― 帯の 35% が「直接ジャンプ」の
// 塊で、入力エラーが出ると帯が 200 → 220px に伸びて地図が動いた（現状分析 §1.3）。
//
// **すべての時刻の変更は `useTimeline` の 1 本（＝ store.setCurrentTime）を通る**
// （技術方針 2.5 の単一真実源）。この部品は地図の描画状態を React に一切持たない。
//
// **編集の意味論には触れない**（増分 6 は読む側だけ）。編集時刻バッジは素性欄と
// **同じ純粋関数**（`decideEditPlan`）から出しており、保存の経路には手を出していない。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { DomainProject } from '../../domain/persistence/index';
import { compare, normalize } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';
import { publishRailObservation } from '../e2e/rail-observation';
import { decideEditPlan, EDIT_PLAN_STRINGS } from '../property/edit-plan';
import { existenceStatusAt } from '../property/existence-status';
import { COMMAND_ID, type CommandRegistry } from '../shell/commands';
import { moveTrailerKey, type StatusMessageStore } from '../shell/status-message';
import type { SessionStore } from '../state/store';
import { nextAnchorIndex, previousAnchorIndex } from '../time/anchor-lane';
import { railFoldOf, type RailFoldLevel } from '../time/rail-fold';
import { viewMaxTime, viewMinTime, viewSpanDays } from '../time/timebar';

import type { AnchorEntry } from '../../domain/anchor-series';
import { canEdit } from '../shell/permissions';

import { AnchorLane, type LaneContextRequest } from './AnchorLane';
import { RailContextMenu } from './RailContextMenu';
import { RAIL_MENU_ITEM, composeRailMenu, type RailMenuItemId } from './rail-menu';
import { RailControls } from './RailControls';
import { RailTicks } from './RailTicks';
import { RAIL_STRINGS, railSpanNote } from './rail-strings';
import { formatTimePoint, formatYear, granularityNote } from './time-display';
import { STEP_UNIT, stepTimePoint, type StepDirection, type StepUnit } from './step';
import { useAnchorLane } from './useAnchorLane';
import { useRailView } from './useRailView';
import { useTimeline } from './useTimeline';
import { usePlayback } from './usePlayback';

/** ホイール 1 段のズームの刻み（`timebar.ZOOM_STEP` の指数）。 */
const WHEEL_NOTCHES = 1;
/** 拡大ボタン 1 押しぶんの刻み（ホイールより大きく動かす）。 */
const BUTTON_NOTCHES = 4;
/** Shift＋ホイールの横スクロール量（軸の幅に対する割合）。 */
const SCROLL_FRACTION = 0.15;

export interface TimelineProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** 目盛りラベルの目標本数。 */
  readonly targetTicks?: number;
  /**
   * コマンドの登録簿（時間のコマンドをここへ足す）。**メニューと鍵盤は同じ id を通る**
   * ので、登録しなければメニューは灰色のまま（結合点 #10）。省略時は何も登録しない。
   */
  readonly registry?: CommandRegistry;
  /** 断りの文の行き先（状態行の「直前の結果」枠）。 */
  readonly statusMessages?: StatusMessageStore;
  /** ポップオーバーの開閉を合成ルートへ報せる（鍵盤の持ち主の導出）。 */
  readonly onPopoverOpenChange?: (open: boolean) => void;
  /**
   * ドメインの根を引く口（錨レーンが系列を引くのに要る）。**合成ルートだけが型を
   * 知っている**ので受け取る形にする。渡さなければレーンは空のまま。
   */
  readonly getRoot?: () => DomainProject;
  /**
   * 板（確認・作業ダイアログ・右クリックメニュー）が開いているか。**開いたら再生を
   * 止める**（決定 (8)、2026-09-07）。板は鍵盤を持つので Space が届かず、板の後ろで
   * 年が進み続けると「何年に対して答えたのか」が変わる。閉じても自動では再開しない。
   */
  readonly modalOpen?: boolean;
  /**
   * レールの右クリックメニューの開閉を名乗る口（決定 (13)。開いているあいだ鍵盤の持ち主は
   * `modal`）。合成ルートは `toolModalChange('rail-menu')` を渡す。
   */
  readonly onMenuOpenChange?: (open: boolean) => void;
  /** 右クリック「この錨を消す」: 素性欄の錨表と同じ影響の板を合成ルートが出す。 */
  readonly onRequestAnchorDelete?: (entry: AnchorEntry) => void;
  /** 右クリック「この錨の開始年を変える」: 素性欄の存続期間の欄を開いて焦点を置く。 */
  readonly onRequestAnchorStartEdit?: (entry: AnchorEntry) => void;
}

export function Timeline<S>(props: TimelineProps<S>): JSX.Element {
  const {
    store,
    targetTicks = 10,
    registry,
    statusMessages,
    onPopoverOpenChange,
    getRoot,
    modalOpen = false,
    onMenuOpenChange,
    onRequestAnchorDelete,
    onRequestAnchorStartEdit,
  } = props;
  const t = useTimeline(store);
  const playback = usePlayback(store, t.calendar);
  const rail = useRailView(store, t.calendar, t.currentTime);
  const lane = useAnchorLane(store, rail.view, t.calendar, t.timelineMin, getRoot);
  const activeTool = useStore(store, (s) => s.activeTool);
  const mode = useStore(store, (s) => s.mode);
  // プロジェクトを開き直した回数。**ポップオーバーの指紋と表示範囲の作り直しに使う**。
  const projectLoadNonce = useStore(store, (s) => s.projectLoadNonce);

  // 決定 (8): 板が開いたら再生を止める（閉じても自動では再開しない）。
  const pausePlayback = playback.pause;
  const wasPlayingRef = useRef(false);
  wasPlayingRef.current = playback.isPlaying;
  useEffect(() => {
    if (!modalOpen) return;
    if (!wasPlayingRef.current) return;
    pausePlayback();
  }, [modalOpen, pausePlayback]);

  const [fold, setFold] = useState<RailFoldLevel>(() =>
    railFoldOf(typeof window === 'undefined' ? 1280 : window.innerWidth),
  );
  const [focusYearSignal, setFocusYearSignal] = useState(0);

  // **畳みは窓幅だけで決まる**（設計書 §B.4）。見張るのは窓そのもの ―― 下限のある器を
  // 見張ると、一度畳んだあと幅が動かなくなって二度と戻らない（教訓 5.69）。
  useEffect(() => {
    const onResize = (): void => {
      setFold(railFoldOf(window.innerWidth));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // 軸の画素数。レーンの器を測る（同じ内寸を目盛りの軸も使う ―― CSS の
  // `--rail-unit-gutter` を両方の行が読むので、構造上ずれない）。
  const laneBoxRef = useRef<HTMLDivElement | null>(null);
  const { setPixelLength } = rail;
  useEffect(() => {
    const el = laneBoxRef.current;
    if (el === null) return;
    const measure = (): void => {
      setPixelLength(Math.max(0, Math.round(el.getBoundingClientRect().width)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [setPixelLength]);

  // 送りの単位（年・月・日）。**操作列と目盛りの矢印キーが同じ 1 つを読む**。
  const [stepUnit, setStepUnit] = useState<StepUnit>(STEP_UNIT.Year);

  // --- 断りの文（状態行へ） --------------------------------------------------
  const refuse = useCallback(
    (message: string): void => {
      statusMessages?.failure(message);
    },
    [statusMessages],
  );

  /**
   * **断りを引っ込める**（2026-09-07 の手直し）。
   *
   * 状態行は時間では消えない（教訓 5.12）ので、範囲外の断りを出したあとに **成功した
   * 移動をしても断りが残り続け**、成功と失敗が見分けられなかった。教訓 5.12 が消してよいと
   * 定める契機のうち **「成功した置換操作」**にあたるので、時刻が動いたら中立の結果へ
   * 置き換える。
   */
  const succeeded = useCallback(
    (message: string): void => {
      statusMessages?.notice(message);
    },
    [statusMessages],
  );

  /**
   * **「移動しました」は、実際に動いたと確かめてから言う**（2026-09-07 の最終手直し）。
   *
   * 時刻の変更は **止められることがある** ―― 作図の下書きを持ったままレールで年を
   * 動かすと、ストアの関門（`shell/useDraftTimeGate`）が「捨てますか」の板を出して
   * **年を動かさない**（教訓 5.71）。旧版はストアへ書いた直後に言い切っていたので、板が
   * 出ているあいだ状態行だけが「5000年へ移動しました」と言い、画面の年は 1500 のままだった。
   *
   * 確かめる相手は **ストアの現物**である。頼んだ時刻がストアにあれば動いた、無ければ黙る。
   */
  const pendingMoveRef = useRef<TimePoint | null>(null);
  const announceMove = useCallback(
    (point: TimePoint): void => {
      // すでにその時刻に居るなら、これ以上何も動かない ―― その場で言ってよい。
      if (compare(t.currentTime, point, t.calendar) === 0) {
        succeeded(
          RAIL_STRINGS.movedTo(formatTimePoint(point)) +
            (statusMessages?.takeMoveTrailers(moveTrailerKey(point)) ?? ''),
        );
        return;
      }
      // 動くはずのときは **印だけ置く**。実際に動いたかは下の見張りが確かめる。
      pendingMoveRef.current = point;
    },
    [t.currentTime, t.calendar, succeeded, statusMessages],
  );

  /**
   * 頼んだ移動が **本当に効いたか**を見てから言う。
   *
   * 見るのは **ストアの現物**である。板に「捨てる」と答えられて年が動いたときは、印が
   * 残っているのでここで言う。
   */
  useEffect(() => {
    const point = pendingMoveRef.current;
    if (point === null) return;
    pendingMoveRef.current = null;
    const live = store.getState().currentTime;
    if (compare(live, point, t.calendar) !== 0) return;
    // 移動と同時に起きたこと（居なくなった印を外した・その年に錨を作った）は、控えから
    // 取り出して **同じ 1 つの文**の後ろへ続ける（上書きして読めなくしない）。
    succeeded(
      RAIL_STRINGS.movedTo(formatTimePoint(point)) +
        (statusMessages?.takeMoveTrailers(moveTrailerKey(point)) ?? ''),
    );
  }, [t.currentTime, t.calendar, store, succeeded, statusMessages]);

  // --- 時刻を動かす（すべて `useTimeline` の 1 本を通る） ---------------------
  const jumpTo = useCallback(
    (point: TimePoint) => {
      const message = t.outOfRangeMessage(point);
      if (message !== null) {
        refuse(message);
        return;
      }
      t.jumpToTime(point);
      announceMove(point);
    },
    [t, refuse, announceMove],
  );

  /**
   * 送り。**端を越えるときは端まで動かして、そう言う**（決定 (4)、2026-09-07 の手直し）。
   *
   * 直接打った年は「その年へ行きたい」という明確な意図なので動かさずに断るが、送りは
   * 「その向きへ進みたい」なので **端で止めるほうが素直**である。旧版は端を越えると
   * 何も起きず、100 年送りが 9950 年で無反応になった（そこから 10000 年へ行く手が無い）。
   *
   * `amount` ぶんの送りは `stepTimePoint` を `amount` 回まわす（月・日は暦の繰り上がりが
   * あるので回数で送る ―― 計算は U02 の 1 本に任せる）。
   */
  const step = useCallback(
    (unit: StepUnit, direction: StepDirection, amount: number) => {
      let next = t.currentTime;
      for (let i = 0; i < amount; i += 1) {
        next = stepTimePoint(next, unit, direction, t.calendar);
      }
      if (t.outOfRangeMessage(next) !== null) {
        const edge = direction < 0 ? t.timelineMin : t.timelineMax;
        // **すでに端に居るなら動かないし、動いたとも言わない**（2026-09-07 の最終
        // 手直し）。旧版は端で押すたびに「端の 0 年へ移動しました」と言っていたが、
        // 1 年も動いていないので画面が嘘をつく。
        if (compare(t.currentTime, edge, t.calendar) === 0) {
          refuse(RAIL_STRINGS.alreadyAtEdge(formatYear(edge.year)));
          return;
        }
        t.jumpToTime(edge);
        refuse(RAIL_STRINGS.stepClampedTo(formatYear(edge.year)));
        return;
      }
      t.jumpToTime(next);
      announceMove(next);
    },
    [t, refuse, announceMove],
  );

  const jumpYear = useCallback(
    (point: TimePoint): string | null => {
      // 断りの文は `useTimeline` の 1 本（`RAIL_STRINGS.outOfRange`）から来る ――
      // ここで組み立て直すと写しが 2 枚になる（教訓 5.44）。
      const message = t.outOfRangeMessage(point);
      if (message !== null) {
        refuse(message);
        return message;
      }
      t.jumpToTime(point);
      announceMove(point);
      return null;
    },
    [t, refuse, announceMove],
  );

  // --- 前後の錨へ（二分探索。対数時間） --------------------------------------
  const jumpAnchor = useCallback(
    (direction: -1 | 1) => {
      if (lane.featureId === null) {
        refuse(RAIL_STRINGS.noSelectionForAnchorJump);
        return;
      }
      const day = normalize(t.currentTime, t.calendar) as number;
      const index =
        direction < 0
          ? previousAnchorIndex(lane.source.starts, day)
          : nextAnchorIndex(lane.source.starts, day);
      if (index < 0 || index >= lane.entries.length) {
        refuse(direction < 0 ? RAIL_STRINGS.noPreviousAnchor : RAIL_STRINGS.noNextAnchor);
        return;
      }
      const entry = lane.entries[index];
      if (entry === undefined) return;
      rail.revealTime(entry.start);
      jumpTo(entry.start);
    },
    [lane, t, rail, jumpTo, refuse],
  );

  // --- 直前にいた年へ戻る（Alt+←） -------------------------------------------
  const historyRef = useRef<TimePoint[]>([]);
  const suppressPushRef = useRef(false);
  const lastTimeRef = useRef<TimePoint | null>(null);
  const playingRef = useRef(playback.isPlaying);
  playingRef.current = playback.isPlaying;

  const pushHistory = useCallback((point: TimePoint): void => {
    historyRef.current.push(point);
    if (historyRef.current.length > 50) historyRef.current.shift();
  }, []);

  useEffect(() => {
    const previous = lastTimeRef.current;
    lastTimeRef.current = t.currentTime;
    if (previous === null) return;
    if (suppressPushRef.current) {
      // **時刻が実際に変わったときだけ**印を降ろす（2026-09-07 の手直し）。
      // 旧版は「戻る」が同じ年へ戻った場合（＝何も変わらない）にも印が残り、
      // 次の本物の移動が 1 つ積まれなかった。
      suppressPushRef.current = false;
      return;
    }
    // **再生で動いた年は積まない**（2026-09-07 の手直し）。旧版は再生の 1 コマごとに
    // 積んでいたので、2 秒再生しただけで 50 件の履歴が「1 年ずつの年」で埋まり、
    // Alt+← が「1 年ずつ戻る」ボタンに化けていた（実測: 60 回押して 3 つの年しか出ない）。
    if (playingRef.current) return;
    pushHistory(previous);
  }, [t.currentTime, pushHistory]);

  /**
   * **再生を始めた年は 1 回だけ積む**（2026-09-07 の最終手直し）。
   *
   * 再生で動いた年は積まない（上）ので、旧版は 3000 年から再生して止めたあと Alt+← を
   * 押すと **3000 年を飛ばして 2000 年**（その前に居た年）へ戻っていた。「再生を始めた
   * ところへ戻る」は再生の直後にいちばん欲しい 1 手なので、開始の年だけを積む。
   * 積むのは開始の瞬間の 1 回だけで、コマごとには積まない。
   */
  useEffect(() => {
    if (!playback.isPlaying) return;
    const at = lastTimeRef.current;
    if (at === null) return;
    pushHistory(at);
    // 積んだ年をもう一度積まないよう、次の「時刻が動いた」は素通りさせる。
    suppressPushRef.current = true;
  }, [playback.isPlaying, pushHistory]);

  const goBack = useCallback(() => {
    const previous = historyRef.current.pop();
    if (previous === undefined) {
      refuse(RAIL_STRINGS.noBackHistory);
      return;
    }
    suppressPushRef.current = true;
    rail.revealTime(previous);
    t.jumpToTime(previous);
    announceMove(previous);
  }, [t, rail, refuse, announceMove]);

  // --- 鍵盤のコマンド（`commands.ts` と `menu.ts` の両方に足してある＝結合点 #10） ---
  //
  // **登録は 1 回だけにする。** 送りもジャンプも現在時刻に依存するので、素直に依存へ
  // 入れると再生の 1 コマごとに 11 個のコマンドを登録し直すことになる。実体は ref 越しに
  // 読み、登録する関数の同一性を保つ（教訓 5.5 の逆側 ―― 変化する値を掴んだまま
  // 登録しっぱなしにしないための ref）。
  const actionsRef = useRef({ step, jumpAnchor, goBack, toggle: playback.toggle });
  actionsRef.current = { step, jumpAnchor, goBack, toggle: playback.toggle };

  useEffect(() => {
    if (registry === undefined) return;
    const a = actionsRef;
    registry.register(COMMAND_ID.TimeStepBack1, {
      run: () => a.current.step(STEP_UNIT.Year, -1, 1),
    });
    registry.register(COMMAND_ID.TimeStepForward1, {
      run: () => a.current.step(STEP_UNIT.Year, 1, 1),
    });
    registry.register(COMMAND_ID.TimeStepBack10, {
      run: () => a.current.step(STEP_UNIT.Year, -1, 10),
    });
    registry.register(COMMAND_ID.TimeStepForward10, {
      run: () => a.current.step(STEP_UNIT.Year, 1, 10),
    });
    registry.register(COMMAND_ID.TimeStepBack100, {
      run: () => a.current.step(STEP_UNIT.Year, -1, 100),
    });
    registry.register(COMMAND_ID.TimeStepForward100, {
      run: () => a.current.step(STEP_UNIT.Year, 1, 100),
    });
    registry.register(COMMAND_ID.TimePrevAnchor, { run: () => a.current.jumpAnchor(-1) });
    registry.register(COMMAND_ID.TimeNextAnchor, { run: () => a.current.jumpAnchor(1) });
    registry.register(COMMAND_ID.TimeFocusYear, {
      run: () => setFocusYearSignal((n) => n + 1),
    });
    registry.register(COMMAND_ID.TimeTogglePlay, { run: () => a.current.toggle() });
    registry.register(COMMAND_ID.TimeBack, { run: () => a.current.goBack() });
    return () => {
      registry.unregister(COMMAND_ID.TimeStepBack1);
      registry.unregister(COMMAND_ID.TimeStepForward1);
      registry.unregister(COMMAND_ID.TimeStepBack10);
      registry.unregister(COMMAND_ID.TimeStepForward10);
      registry.unregister(COMMAND_ID.TimeStepBack100);
      registry.unregister(COMMAND_ID.TimeStepForward100);
      registry.unregister(COMMAND_ID.TimePrevAnchor);
      registry.unregister(COMMAND_ID.TimeNextAnchor);
      registry.unregister(COMMAND_ID.TimeFocusYear);
      registry.unregister(COMMAND_ID.TimeTogglePlay);
      registry.unregister(COMMAND_ID.TimeBack);
    };
  }, [registry]);

  // --- 編集時刻バッジ（中身 9。素性欄と同じ純粋関数から出す） ------------------
  const currentDay = useMemo(
    () => normalize(t.currentTime, t.calendar) as number,
    [t.currentTime, t.calendar],
  );
  const featurePresent = useMemo(
    () =>
      lane.source.runs.some(
        (r) => currentDay >= r.startDay && (r.endDay === null || currentDay < r.endDay),
      ),
    [lane.source, currentDay],
  );
  const editPlan = useMemo(
    () =>
      decideEditPlan({
        currentTime: t.currentTime,
        series: lane.governingSeries,
        featurePresent: lane.featureId !== null && featurePresent,
        // 居ない理由が「もう終わっている」なら見出しでもそう言う（素性欄と同じ 1 本）。
        featureEnded:
          existenceStatusAt(lane.governingSeries, lane.featureId, t.currentTime, t.calendar)
            .kind === 'ended',
        calendar: t.calendar,
        // **素性欄と同じ材料を渡す**（2026-09-07 の手直し）。渡さないと同じ純粋関数から
        // 出た文が画面の 2 か所で食い違う（片方だけ「約 306 KB 増えます」になる）。
        snapshotSize: lane.snapshotSize,
      }),
    [
      t.currentTime,
      t.calendar,
      lane.featureId,
      lane.governingSeries,
      lane.snapshotSize,
      featurePresent,
    ],
  );

  // --- 観測口（中身 8） -------------------------------------------------------
  //
  // **観測は画面と同じ値を出す**（2026-09-07 の最終手直し）。地物を選んでいないときの
  // バッジは年だけを出す（行き先を指す相手が画面に無いため）のに、観測だけが
  // 「0年｜この年にはまだありません」を返していた ―― 観測が画面と違うものを言うと、
  // 検査は通るのに画面は違う、が起こる（教訓 5.18 の趣旨）。
  const editTimeText =
    lane.featureId === null
      ? editPlan.badgeTime
      : `${editPlan.badgeTime}${EDIT_PLAN_STRINGS.badgeSeparator}${editPlan.badgeNote}`;
  // **観測は 1 回だけ登録する**（毎レンダーで登録し直さない）。中身は ref 越しに読むので、
  // 再生で時刻が動いてもここは走らない。
  const observedRef = useRef({
    stats: lane.stats,
    marks: lane.markPositions,
    view: rail.view,
    calendar: t.calendar,
    currentYear: t.currentTime.year,
    fold,
    editTime: editTimeText,
  });
  observedRef.current = {
    stats: lane.stats,
    marks: lane.markPositions,
    view: rail.view,
    calendar: t.calendar,
    currentYear: t.currentTime.year,
    fold,
    editTime: editTimeText,
  };
  useEffect(() => {
    publishRailObservation({
      getAnchorLaneStats: () => observedRef.current.stats(),
      getAnchorMarkPositions: () => observedRef.current.marks(),
      getRailView: () => {
        const o = observedRef.current;
        return {
          minYear: viewMinTime(o.view, o.calendar).year,
          maxYear: viewMaxTime(o.view, o.calendar).year,
          spanDays: viewSpanDays(o.view),
          pixelLength: o.view.pixelLength,
          fold: o.fold,
          currentYear: o.currentYear,
          editTime: o.editTime,
        };
      },
    });
    return () => {
      publishRailObservation(null);
    };
  }, []);

  // --- ホイール（ズーム／Shift で横スクロール） -------------------------------
  //
  // **React の `onWheel` では `preventDefault()` が効かない**（2026-09-07 の手直し）。
  // React 17 以降は wheel を root へ **passive で**張るので、`e.preventDefault()` は
  // 無視され、コンソールに「Unable to preventDefault inside passive event listener」が
  // 1 走行で 96 件出ていた（ページ全体のスクロールも止まらない）。地図側と同じく
  // **自分で `{ passive: false }` で張る**。
  const railWheelRef = useRef<HTMLDivElement | null>(null);
  const wheelStateRef = useRef({ scrollByPixels: rail.scrollByPixels, zoomAt: rail.zoomAt, pixelLength: rail.view.pixelLength });
  wheelStateRef.current = {
    scrollByPixels: rail.scrollByPixels,
    zoomAt: rail.zoomAt,
    pixelLength: rail.view.pixelLength,
  };
  useEffect(() => {
    const el = railWheelRef.current;
    if (el === null) return;
    const onWheelNative = (e: WheelEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      // レーンと目盛りの上だけ（操作列の `select` のホイールは奪わない）。
      const zone = (target as Element).closest?.('[data-rail-wheel="true"]');
      if (zone === null || zone === undefined) return;
      e.preventDefault();
      const rect = zone.getBoundingClientRect();
      const focusPx = e.clientX - rect.left;
      const w = wheelStateRef.current;
      if (e.shiftKey) {
        w.scrollByPixels((e.deltaY > 0 ? 1 : -1) * w.pixelLength * SCROLL_FRACTION);
        return;
      }
      w.zoomAt(e.deltaY > 0 ? WHEEL_NOTCHES : -WHEEL_NOTCHES, focusPx);
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheelNative);
    };
  }, []);

  // --- 右クリック（設計書 §I.3。増分 7 の申し送り §10 の 1 つ目） ---------------
  //
  // 中身の操作はどれも **既存の経路を呼ぶだけ**（`rail-menu.ts` の注記）。可否と理由は
  // 純粋な組み立て 1 か所で決める。
  const [railMenu, setRailMenu] = useState<LaneContextRequest | null>(null);
  const closeRailMenu = useCallback(() => {
    setRailMenu(null);
  }, []);
  // 閉じる契機は Escape と外の押下（`RailContextMenu`）。選択・道具・プロジェクトが
  // 変わったときも閉じる（束の吹き出しと同じ指紋）。
  const railMenuKey = `${mode}|${String(activeTool)}|${String(projectLoadNonce)}|${String(lane.featureId)}`;
  useEffect(() => {
    setRailMenu(null);
  }, [railMenuKey]);
  const openRailMenu = useCallback(
    (request: LaneContextRequest) => {
      // **板が鍵盤を持っているあいだは開かない**（地図の右クリックと同じ＝
      // `suspendsContextMenu`）。
      if (modalOpen) return;
      setRailMenu(request);
    },
    [modalOpen],
  );
  const editable = canEdit(mode);
  const railMenuItems = useMemo(() => {
    if (railMenu === null) return [];
    if (railMenu.kind === 'anchor') {
      return composeRailMenu({
        kind: 'anchor',
        editable,
        inheritedOwner: lane.inherited ? (lane.ownerName ?? '') : null,
        soleAnchor: (lane.governingSeries?.entries.length ?? 0) <= 1,
      });
    }
    const at = railMenu.time;
    return composeRailMenu({
      kind: 'empty',
      editable,
      hasSelection: lane.featureId !== null,
      anchorAtYear:
        lane.governingSeries?.entries.some((e) => compare(e.start, at, t.calendar) === 0) ??
        false,
    });
  }, [railMenu, editable, lane, t.calendar]);
  const onRailMenuSelect = useCallback(
    (id: RailMenuItemId) => {
      const request = railMenu;
      if (request === null) return;
      switch (id) {
        case RAIL_MENU_ITEM.JumpToAnchor:
          if (request.kind === 'anchor') jumpTo(request.entry.start);
          return;
        case RAIL_MENU_ITEM.ChangeAnchorStart:
          if (request.kind === 'anchor') {
            jumpTo(request.entry.start);
            onRequestAnchorStartEdit?.(request.entry);
          }
          return;
        case RAIL_MENU_ITEM.DeleteAnchor:
          if (request.kind === 'anchor') onRequestAnchorDelete?.(request.entry);
          return;
        case RAIL_MENU_ITEM.JumpHere:
          if (request.kind === 'empty') jumpTo(request.time);
          return;
        case RAIL_MENU_ITEM.CreateAnchorHere:
          if (request.kind !== 'empty') return;
          jumpTo(request.time);
          // **年が本当に動いたときだけ**作る ―― 下書きの「捨てますか」が年を戻したら、
          // 戻った年に錨を作ってはいけない（教訓 5.71）。作る側の可否と断りの文は
          // Ctrl+K と同じコマンド 1 本が持つ。
          if (compare(store.getState().currentTime, request.time, t.calendar) !== 0) return;
          {
            // 作った（または断られた）文を、移動の知らせの後ろへ続ける（バグ狩り 2-4: 移動の
            // 文で上書きされ、押しても何も起きなかったように見えていた）。
            const before = statusMessages?.get() ?? null;
            registry?.dispatch(COMMAND_ID.EditCreateAnchorHere);
            const after = statusMessages?.get() ?? null;
            if (after !== null && after !== before) {
              statusMessages?.stageMoveTrailer(moveTrailerKey(request.time), after.text);
            }
          }
          return;
        case RAIL_MENU_ITEM.MakeLeftEdge:
          if (request.kind === 'empty') rail.scrollByPixels(request.px);
          return;
        case RAIL_MENU_ITEM.FitAll:
          rail.fitAll();
          return;
      }
    },
    [
      railMenu,
      jumpTo,
      onRequestAnchorStartEdit,
      onRequestAnchorDelete,
      store,
      t.calendar,
      registry,
      rail,
      statusMessages,
    ],
  );

  const spanDays = viewSpanDays(rail.view);
  /**
   * 開いている板を閉じる契機の指紋（共有の器の作法 4）。**プロジェクトを入れる**
   * （2026-09-07 の手直し）―― 旧版は道具・モード・畳みだけだったので、別のファイルを
   * 開いても「年月日 ▾」が開いたままで、**前のプロジェクトの年が入った欄**が残った。
   * 時刻は入れない（再生の 1 コマごとに閉じてしまう ―― 追認した判断）。
   */
  const popoverCloseKey = `${mode}|${String(activeTool)}|${fold}|${String(projectLoadNonce)}|${String(lane.featureId)}`;
  const zoomFocusPx = rail.playheadOutside ? rail.view.pixelLength / 2 : rail.playheadPx;

  return (
    <div
      className="rail timeline"
      data-testid="timeline"
      aria-label={RAIL_STRINGS.railLabel}
      ref={railWheelRef}
    >
      {/* (a) 読み取り 24px */}
      <div className="rail__readout" data-testid="rail-readout">
        {/* 表示範囲の左端。**年だけ**を出す（司令塔の追認、2026-09-07）―― 拡大すると
            左端は年の途中になるが、全日付を出すと 88px の枠に収まらず読みにくい。 */}
        <span className="rail__view-min" data-testid="rail-view-min">
          {formatYear(viewMinTime(rail.view, t.calendar).year)}
        </span>
        {/* 編集時刻バッジ。**地物を選んでいないときは行き先を言わない**
            （2026-09-07 の手直し）―― 旧版は誰も選んでいないのに
            「この年にはまだありません」と出ており、**何が「まだ無い」のか指す相手が
            画面に無かった**。選んでいないときは年だけを出す。 */}
        <span
          className="rail__badge"
          data-testid="rail-edit-time-badge"
          data-plan={lane.featureId === null ? 'none' : editPlan.kind}
          title={granularityNote(t.currentTime)}
        >
          <span className="rail__badge-time" data-testid="timeline-current">
            {formatTimePoint(t.currentTime)}
          </span>
          {lane.featureId !== null && (
            <>
              <span className="rail__badge-sep" aria-hidden="true">
                {EDIT_PLAN_STRINGS.badgeSeparator}
              </span>
              <span className="rail__badge-note" data-testid="rail-edit-time-note">
                {editPlan.badgeNote}
              </span>
            </>
          )}
        </span>
        <span className="rail__span-note" data-testid="rail-span-note">
          {railSpanNote(spanDays, rail.view.pixelLength)}
        </span>
        {/* 隠し観測（既存の `app-active-feature` と同じ方式）。 */}
        <span data-testid="app-edit-time" hidden>
          {editTimeText}
        </span>
      </div>

      {/* (b) 錨レーン 28px（窓が低いと 20px）。器はここで測る。
          **ホイールはレーンの上でも効く**（§I.2 は「レールの上」と書いている）。
          目盛りの行だけに付けると、印を見ながら拡大しようとして何も起きない。 */}
      <div className="rail__lane-box" ref={laneBoxRef} data-rail-wheel="true">
        <AnchorLane
          source={lane.source}
          aggregate={lane.aggregate}
          entries={lane.entries}
          view={rail.view}
          calendar={t.calendar}
          hasSelection={lane.featureId !== null}
          ownerName={lane.ownerName}
          onlyOrigin={lane.onlyOrigin}
          onJumpTo={jumpTo}
          onView={rail.setView}
          onHitTestMs={lane.recordHitTestMs}
          onLaneHeight={lane.recordLaneHeight}
          closeKey={popoverCloseKey}
          {...(onPopoverOpenChange ? { onPopoverOpenChange } : {})}
          onContextMenuAt={openRailMenu}
        />
      </div>
      {railMenu !== null && (
        <RailContextMenu
          clientX={railMenu.clientX}
          clientY={railMenu.clientY}
          target={railMenu.kind}
          items={railMenuItems}
          onSelect={onRailMenuSelect}
          onClose={closeRailMenu}
          onModalChange={onMenuOpenChange}
        />
      )}

      {/* (c) 目盛り＋再生ヘッド 22px */}
      <RailTicks
        view={rail.view}
        calendar={t.calendar}
        targetTicks={targetTicks}
        fraction={rail.fraction}
        playheadOutside={rail.playheadOutside}
        onFraction={(f) => { jumpTo(rail.timeAtFraction(f)); }}
        onArrowStep={(direction) => { step(stepUnit, direction, 1); }}
      />

      {/* (d) 操作列 32px */}
      <RailControls
        fold={fold}
        onStep={step}
        unit={stepUnit}
        onUnitChange={setStepUnit}
        onRefuse={refuse}
        playback={playback}
        currentTime={t.currentTime}
        calendar={t.calendar}
        onJumpTime={jumpYear}
        /* **拡大の焦点は再生ヘッド**（2026-09-07 の手直し）。軸の中央を焦点にすると、
           1200 年を見ているのに 1 押しで 2588〜7411 年になり、**現在年も印も視野の外**へ
           出ていた（実測）。現在時刻が視野の外にいるときだけ中央を使う。 */
        onZoomIn={() => rail.zoomAt(-BUTTON_NOTCHES, zoomFocusPx)}
        onZoomOut={() => rail.zoomAt(BUTTON_NOTCHES, zoomFocusPx)}
        onZoomFit={rail.fitAll}
        onPrevAnchor={() => jumpAnchor(-1)}
        onNextAnchor={() => jumpAnchor(1)}
        focusYearSignal={focusYearSignal}
        closeKey={popoverCloseKey}
        {...(onPopoverOpenChange ? { onPopoverOpenChange } : {})}
      />
    </div>
  );
}
