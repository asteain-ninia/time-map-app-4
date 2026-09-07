// UI layer (U21 / 時刻レール): 錨レーン（設計書 §C.7 の (b) / §F.2）。
//
// **canvas 1 枚で描き、錨 1 本につき DOM ノードを 1 個も作らない**（規則 5）。理由は
// 4 つ ―― (a) 5 万個の `<span>` は DOM として成立しない (b) DOM を作らなければ
// 「吹き出しが下のボタンの押下を飲み込む」「`overflow` で切れる」型の事故がレーンに
// 入り込まない (c) 描画エンジンは既に Canvas 2D で、E2E は `window.__E2E__` の隠し観測で
// 検証する形が確立している (d) **`timeline-markers` / `timeline-markers-hint` の testid、
// `.timeline-markers` クラス、「この時刻をブックマーク」ボタンの 4 つの名前を使わない**ので、
// 撤去済みの栞の E2E（`ux-cluster.spec.ts` の HB-12）が無改修で通る。
//
// 密度が高すぎるときの逃げ道は 3 つ（規則 6）。①同じ画素列を押すと 1 段拡大
// ②それ以上ほどけないときは束の吹き出し ③`[` `]` と操作列の錨ジャンプ（この部品の外）。

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { AnchorEntry } from '../../domain/anchor-series';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';
import {
  LANE_DENSE_ACTION,
  LANE_HIT,
  densityRatio,
  laneDenseAction,
  laneHitTest,
  runSegments,
  yearAtPixel,
  zoomLaneStep,
  type AnchorLaneAggregate,
  type AnchorLaneSource,
} from '../time/anchor-lane';
import { useDismissable } from '../shell/use-dismissable';
import type { TimeBarView } from '../time/timebar';

import { RAIL_STRINGS } from './rail-strings';
import { formatTimePoint } from './time-display';

/** 束の吹き出しに並べる行の上限（素性欄の錨表と同じ「前後 12 本」の考え方）。 */
export const BUNDLE_MAX_ROWS = 12;

/** 束の吹き出しの中身。 */
export interface LaneBundle {
  /** 吹き出しの横位置（画面座標）。 */
  readonly clientX: number;
  /** レーンの上端（画面座標）。吹き出しはこの上に出す。 */
  readonly laneTop: number;
  /** その範囲の錨（先頭 {@link BUNDLE_MAX_ROWS} 本）。 */
  readonly rows: readonly AnchorEntry[];
  /** その範囲の総数（行数より多いことがある）。 */
  readonly count: number;
  /** 見出しに出す年。 */
  readonly nearLabel: string;
}

export interface AnchorLaneProps {
  readonly source: AnchorLaneSource;
  readonly aggregate: AnchorLaneAggregate;
  readonly entries: readonly AnchorEntry[];
  readonly view: TimeBarView;
  readonly calendar: Calendar;
  /** 選んでいる地物があるか（無いときは淡い 1 行を出す）。 */
  readonly hasSelection: boolean;
  /** まとめ役の子で、親の系列を借りているときの持ち主の名前。 */
  readonly ownerName: string | null;
  /** 歴史の節目が時間軸の左端にしかないか（設計書 §H.4 の空状態）。 */
  readonly onlyOrigin: boolean;
  /** その年へ移動する。 */
  readonly onJumpTo: (time: TimePoint) => void;
  /** 表示範囲を差し替える（1 段拡大）。 */
  readonly onView: (next: TimeBarView) => void;
  /** 当たり判定にかかった時間を控える（観測）。 */
  readonly onHitTestMs: (ms: number) => void;
  /** レーンの高さ（px）を控える（観測）。 */
  readonly onLaneHeight: (px: number) => void;
  /**
   * 束の吹き出しを閉じる契機の指紋（共有の器の作法 4）。モード・道具・プロジェクト・
   * 選択を 1 本の文字列に畳んだもの。**時刻は入れない**（再生中に毎コマ閉じてしまう）。
   */
  readonly closeKey: string;
  /** 束の吹き出しの開閉を報せる（`focusOwner` の `popover` の導出。作法 5）。 */
  readonly onPopoverOpenChange?: ((open: boolean) => void) | undefined;
}

/** 描く色。CSS のカスタムプロパティから読む（配色の真実源を CSS 側に置く）。 */
interface LaneColors {
  readonly bar: string;
  readonly mark: string;
  readonly dense: string;
}

function readColors(el: HTMLElement): LaneColors {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string): string => {
    const v = style.getPropertyValue(name).trim();
    return v === '' ? fallback : v;
  };
  return {
    bar: pick('--rail-lane-bar', '#c7ccd4'),
    mark: pick('--rail-lane-mark', '#2f6fb5'),
    dense: pick('--rail-lane-dense', '#1f4d80'),
  };
}

export function AnchorLane(props: AnchorLaneProps): JSX.Element {
  const {
    source,
    aggregate,
    entries,
    view,
    calendar,
    hasSelection,
    ownerName,
    onlyOrigin,
    onJumpTo,
    onView,
    onHitTestMs,
    onLaneHeight,
    closeKey,
    onPopoverOpenChange,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bundleRef = useRef<HTMLDivElement | null>(null);
  const [bundle, setBundle] = useState<LaneBundle | null>(null);
  const closeBundle = useCallback(() => {
    setBundle(null);
  }, []);

  // 閉じる契機（共有の器の作法 3・4・5 を hook 1 つで満たす）。
  //   ・外の押下と Escape（`useDismissable`）
  //   ・モード・道具・プロジェクト・選択が変わったとき（`closeKey`）
  //   ・表示範囲と系列が変わったとき（下の指紋に畳んで渡す）
  const viewKey = `${String(view.min as number)}|${String(view.max as number)}|${String(view.pixelLength)}`;
  useDismissable({
    open: bundle !== null,
    close: closeBundle,
    closeKey: `${closeKey}|${viewKey}|${String(source.starts.length)}`,
    insideRefs: [bundleRef],
    onOpenChange: onPopoverOpenChange,
  });

  // 空状態は 3 つ。**「選んでいるのに 0 年にしか節目が無い」を出せるようにする**
  // （2026-09-07 の手直し）―― 旧版は「錨が 1 本も無い」ときにしか文を出さなかったので、
  // 実データ 689 件がまさに該当する §H.4 の文が **構造上どこにも出なかった**。
  const emptyText =
    !hasSelection
      ? RAIL_STRINGS.laneEmptyNoSelection
      : source.starts.length === 0
        ? RAIL_STRINGS.laneEmptyNoAnchors
        : onlyOrigin
          ? RAIL_STRINGS.laneEmptyOnlyOrigin
          : null;
  const emptyKind =
    !hasSelection
      ? 'no-selection'
      : source.starts.length === 0
        ? 'no-anchors'
        : onlyOrigin
          ? 'only-origin'
          : 'none';

  // 器の実寸。**高さだけが変わる場合も測り直す**（2026-09-07 の手直し）―― レーンは
  // 窓が低いと 28px → 20px に縮むが、旧版は描き直しの契機が「系列・表示範囲」だけだったので
  // canvas の内部解像度が 28px のまま残り、縦に潰れた絵が出ていた。
  // `devicePixelRatio` の変化（別の画面へ窓を移す）でも測り直す。
  const [metrics, setMetrics] = useState({ width: 0, height: 0, dpr: 1 });
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const parent = canvas.parentElement;
    if (parent === null) return;
    let mq: MediaQueryList | null = null;
    const measure = (): void => {
      const rect = parent.getBoundingClientRect();
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(rect.height));
      const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      onLaneHeight(height);
      setMetrics((prev) =>
        prev.width === width && prev.height === height && prev.dpr === dpr
          ? prev
          : { width, height, dpr },
      );
      armDpr(dpr);
    };
    const armDpr = (dpr: number): void => {
      if (typeof window.matchMedia !== 'function') return;
      const next = window.matchMedia(`(resolution: ${String(dpr)}dppx)`);
      if (mq !== null) mq.removeEventListener('change', onDprChange);
      mq = next;
      mq.addEventListener('change', onDprChange);
    };
    const onDprChange = (): void => {
      measure();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => {
      ro.disconnect();
      if (mq !== null) mq.removeEventListener('change', onDprChange);
    };
  }, [onLaneHeight]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const { width, height, dpr } = metrics;
    if (width === 0 || height === 0) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    canvas.style.width = `${String(width)}px`;
    canvas.style.height = `${String(height)}px`;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const colors = readColors(canvas);

    // ①存続している期間の細い帯。空白の期間は塗らない（FR-60 の条文どおり）。
    const midY = Math.round(height / 2);
    ctx.fillStyle = colors.bar;
    const segments = runSegments(source, view);
    for (const seg of segments) {
      ctx.fillRect(seg.startPx, midY - 1, Math.max(1, seg.endPx - seg.startPx), 2);
    }
    // ①-b 終端の印（司令塔の決定 (12)）。「この年に終わったことにする」を押したあと、
    // **どこで終わったのか**がレーンで読めるようにする。錨の菱形とは形を変えて
    // （縦の太い棒）区別できるようにしてある。
    for (const seg of segments) {
      if (!seg.closed) continue;
      const half = Math.min(6, Math.floor(height / 2) - 1);
      ctx.fillRect(Math.max(0, seg.endPx - 1), midY - half, 2, half * 2);
    }

    // ②画素の列ごとの印と密度帯。**図形の数は軸の画素数で頭打ちになる**（規則 2）。
    const counts = aggregate.counts;
    const maxCount = aggregate.maxCount;
    const markHalf = Math.min(5, Math.floor(height / 2) - 1);
    for (let x = 0; x < aggregate.width; x += 1) {
      const c = counts[x] as number;
      if (c === 0) continue;
      if (c === 1) {
        // 菱形の印。
        ctx.fillStyle = colors.mark;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, midY - markHalf);
        ctx.lineTo(x + 0.5 + markHalf, midY);
        ctx.lineTo(x + 0.5, midY + markHalf);
        ctx.lineTo(x + 0.5 - markHalf, midY);
        ctx.closePath();
        ctx.fill();
        continue;
      }
      // 2 本以上は高さと濃さで件数を出す縦棒（個別の印は描かない）。
      const ratio = densityRatio(c, maxCount);
      const barHeight = Math.max(4, Math.round(ratio * (height - 4)));
      ctx.globalAlpha = 0.45 + 0.55 * ratio;
      ctx.fillStyle = colors.dense;
      ctx.fillRect(x, midY - barHeight / 2, 1, barHeight);
      ctx.globalAlpha = 1;
    }
  }, [source, aggregate, view, metrics]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const started = performance.now();
      const hit = laneHitTest(source, view, px);
      onHitTestMs(performance.now() - started);

      if (hit.kind === LANE_HIT.None) {
        // 何も無いところを押したら「その年へ移動」（中身 4: レールのクリック）。
        onJumpTo(yearAtPixel(px, view, calendar));
        return;
      }
      if (hit.kind === LANE_HIT.Single) {
        const entry = entries[hit.firstIndex];
        if (entry !== undefined) onJumpTo(entry.start);
        return;
      }
      // 2 本以上 ―― まだほどけるなら 1 段拡大、ほどけないなら束の吹き出し（規則 6）。
      if (laneDenseAction(source, view, hit, calendar) === LANE_DENSE_ACTION.Zoom) {
        onView(zoomLaneStep(view, px, calendar));
        return;
      }
      const rows = entries.slice(hit.firstIndex, hit.firstIndex + BUNDLE_MAX_ROWS);
      const near = entries[hit.firstIndex];
      setBundle({
        clientX: e.clientX,
        laneTop: rect.top,
        rows,
        count: hit.count,
        nearLabel: near === undefined ? '' : formatTimePoint(near.start),
      });
    },
    [source, view, entries, calendar, onJumpTo, onView, onHitTestMs],
  );

  const laneTitle = useMemo(() => {
    if (!hasSelection) return RAIL_STRINGS.laneEmptyNoSelection;
    if (ownerName !== null) {
      return `${RAIL_STRINGS.laneInheritedPrefix}${ownerName}${RAIL_STRINGS.laneInheritedSuffix}`;
    }
    return RAIL_STRINGS.laneLabel;
  }, [hasSelection, ownerName]);

  return (
    <div className="rail__lane" data-testid="rail-lane">
      <canvas
        ref={canvasRef}
        className="rail__lane-canvas"
        data-testid="anchor-lane"
        role="img"
        aria-label={laneTitle}
        title={laneTitle}
        onPointerDown={handlePointerDown}
      />
      {emptyText !== null && (
        <p className="rail__lane-empty" data-testid="anchor-lane-empty" data-kind={emptyKind}>
          {emptyText}
        </p>
      )}
      {ownerName !== null && (
        <p className="rail__lane-owner" data-testid="anchor-lane-owner">
          {`${RAIL_STRINGS.laneInheritedPrefix}${ownerName}${RAIL_STRINGS.laneInheritedSuffix}`}
        </p>
      )}
      {bundle !== null && (
        <div
          ref={bundleRef}
          className="rail__bundle"
          data-testid="anchor-bundle"
          /* **画面座標で置く**（`position: fixed`）。レールは `overflow: hidden` なので、
             帯の子として上へ伸ばすと切れて中の行が押せない ―― ポップオーバーの器
             （`shell/OptionPopover` の作法 1）と同じ理由・同じ形にする。 */
          style={{
            left: `${String(Math.round(bundle.clientX))}px`,
            bottom: `${String(Math.round(window.innerHeight - bundle.laneTop + 4))}px`,
          }}
          role="group"
          aria-label={RAIL_STRINGS.bundleTitle(bundle.nearLabel, bundle.count)}
        >
          <div className="rail__bundle-head" data-testid="anchor-bundle-title">
            {RAIL_STRINGS.bundleTitle(bundle.nearLabel, bundle.count)}
          </div>
          <ul className="rail__bundle-list">
            {bundle.rows.map((entry) => (
              <li key={entry.anchor.id}>
                <button
                  type="button"
                  data-testid={`anchor-bundle-row-${entry.anchor.id}`}
                  onClick={() => {
                    onJumpTo(entry.start);
                    closeBundle();
                  }}
                >
                  {formatTimePoint(entry.start)}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="rail__bundle-close"
            data-testid="anchor-bundle-close"
            onClick={closeBundle}
          >
            {RAIL_STRINGS.bundleClose}
          </button>
        </div>
      )}
    </div>
  );
}
