// UI layer (U23 / shell): オプションバーの「吸着 ▾」ポップオーバー（設計書 §C.4 / §N-6）。
//
// 帯の設定欄（`registerOptionSlot`）へ差し込む部品。中身は設計書 §C.4 の表のとおり:
//   吸着 ON/OFF ／ 頂点 ☑ ／ **辺 ☐（灰色＋「まだ使えません」）／ 交点 ☐（同）** ／
//   許容 [ ] px ／ グリッド ☑（FR-78。従来 `add-grid-snap` として道具の帯にあったもの）
//
// **辺・交点を灰色で置く理由**（設計書 §F.1 の C1 / §N-6）: ドメインの `domain/add/snap.ts`
// の優先順位は「呼び出し側が解決済みの近接候補（FR-31）→ グリッド（FR-78）→ 生座標」の
// 3 段だけで、辺も交点も概念として無い。作るのはドメインの新規実装で、しかも §N-6 の
// 裁定待ちである。**押せる形で置いて何も起きないより、押せない形で理由を出すほうがよい**
// （C9「押すと損をするボタンを並べない」）。
//
// 置き方（増分 1 の申し送り）:
//  - **`position: fixed` にしてアンカーの矩形から座標を出す。** オプションバーの帯は
//    `overflow: hidden` なので、`position: absolute` で下へ伸ばすと切れる。作法は
//    `src/ui/shell/Tooltip.tsx` と同じ。
//  - **背面を覆う板（バックドロップ）を置かない**（K-2）。地図に重なる透明な層は
//    3 回別々の原因で「地図のクリックを奪う」事故を起こしている。閉じるのは
//    `document` の pointerdown を聞いて「自分の外なら閉じる」で足りる。
//    したがって開いている間も、**ポップオーバーの矩形の外はすべて地図に届く**。

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  clampSnapTolerancePx,
  SNAP_TOLERANCE_MAX_PX,
  SNAP_TOLERANCE_MIN_PX,
  type SnapSettings,
} from '../state/session';

import { ADD_STRINGS } from './strings';

/** ポップオーバーと窓の端との余白（px）。 */
const VIEWPORT_MARGIN = 4;
/** アンカーとの隙間（px）。 */
const ANCHOR_GAP = 4;

/**
 * 許容値に入れられる範囲を、欄のそばに **目で見える形で** 出す文字列（「1〜50px」）。
 *
 * 数値は `session.ts` の定数から組み立てる。ここに 1 と 50 を書き写すと、範囲を変えた
 * ときに画面の案内だけ古いまま残る（教訓 5.29 単一真実源）。
 *
 * **本来は `src/ui/add/strings.ts` へ移す**。この作業では strings.ts が別の人の編集中で
 * 触れないため、暫定でここに置いてある。
 */
const SNAP_TOLERANCE_RANGE_TEXT = `${SNAP_TOLERANCE_MIN_PX}〜${SNAP_TOLERANCE_MAX_PX}px`;

export interface SnapOptionsProps {
  readonly settings: SnapSettings;
  readonly onChange: (patch: Partial<SnapSettings>) => void;
  /** グリッドスナップ（FR-78）。作図セッションが無いときは undefined。 */
  readonly gridSnap: boolean | undefined;
  readonly onGridSnapChange: (on: boolean) => void;
}

interface PopoverPosition {
  readonly left: number;
  readonly top: number;
}

export function SnapOptions(props: SnapOptionsProps): JSX.Element {
  const { settings, onChange, gridSnap, onGridSnapChange } = props;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  // 許容値の欄に **打っている途中の文字**（null = 触っていない ＝ 設定の値をそのまま出す）。
  //
  // これが無いと、打つそばから値が書き換わる。欄を設定の値で直に描いていたので、
  // 「50」を打とうとして「5」まで入れた時点で店（ストア）が `clampSnapTolerancePx` で
  // 丸めた値を返し、次の 1 文字を打つ前に欄の中身が入れ替わっていた。**丸めるのは欄から
  // 離れたとき（blur）だけ**にして、打っている間は打った文字をそのまま残す。
  const [toleranceDraft, setToleranceDraft] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
    // 教訓 5.2: 一時的な入力途中の文字は、閉じる経路でも捨てる。
    setToleranceDraft(null);
  }, []);

  // 打っている間: 文字はそのまま残す。**すでに使える範囲に収まっている数**のときだけ
  // 設定へ流す（丸めが起きないので欄は書き換わらない）。範囲の外や数でない文字は
  // 欄から離れるまで待つ。
  const onToleranceInput = useCallback(
    (text: string): void => {
      setToleranceDraft(text);
      const parsed = Number(text);
      if (text.trim() === '' || !Number.isInteger(parsed)) return;
      if (parsed < SNAP_TOLERANCE_MIN_PX || parsed > SNAP_TOLERANCE_MAX_PX) return;
      onChange({ tolerancePx: parsed });
    },
    [onChange],
  );

  // 欄から離れたとき: ここで初めて範囲へ丸める。丸め方は `session.ts` の
  // `clampSnapTolerancePx` 1 か所に任せる（教訓 5.29）。数として読めない（空欄など）
  // ときは既定へ落とさず、いまの値へ戻す ―― 空欄にしただけで 12 に化けると驚く。
  const onToleranceBlur = useCallback((): void => {
    const text = toleranceDraft;
    setToleranceDraft(null);
    if (text === null) return;
    const parsed = Number(text);
    const next =
      text.trim() === '' || !Number.isFinite(parsed)
        ? settings.tolerancePx
        : clampSnapTolerancePx(parsed);
    if (next === settings.tolerancePx) return;
    onChange({ tolerancePx: next });
  }, [toleranceDraft, settings.tolerancePx, onChange]);

  // 開いた直後に、アンカーの矩形と実寸から置き場所を決める（Tooltip と同じ作法）。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (anchor === null || panel === null) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - p.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(a.left, VIEWPORT_MARGIN), maxLeft);
    const below = a.bottom + ANCHOR_GAP;
    const top =
      below + p.height + VIEWPORT_MARGIN <= window.innerHeight
        ? below
        : Math.max(VIEWPORT_MARGIN, a.top - p.height - ANCHOR_GAP);
    setPosition((prev) =>
      prev !== null && prev.left === left && prev.top === top ? prev : { left, top },
    );
  }, [open]);

  // 閉じる契機（教訓 5.2: 一時的 UI 状態は全経路で捨てる）: 外を押す／Escape。
  // **バックドロップは置かない**（K-2）ので、外側のクリックはそのまま地図へ届く。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panel?.contains(target) === true) return;
      if (anchor?.contains(target) === true) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 作図中の Escape は「下書きを捨てる」なので、ポップオーバーが開いているあいだは
      // こちらが先に受け取って **止める**（設計書 §D.4 の Esc の階段）。
      e.stopPropagation();
      e.preventDefault();
      close();
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className="snap-options__button"
        data-testid="option-snap-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {ADD_STRINGS.snapMenuLabel} ▾
      </button>
      <div
        id={panelId}
        ref={panelRef}
        className="snap-options__panel"
        data-testid="option-snap-panel"
        role="dialog"
        aria-label={ADD_STRINGS.snapMenuLabel}
        hidden={!open}
        style={position === null ? undefined : { left: position.left, top: position.top }}
      >
        <label className="snap-options__row">
          <input
            type="checkbox"
            data-testid="snap-enabled"
            checked={settings.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          {ADD_STRINGS.snapEnabled}
        </label>

        <label className="snap-options__row">
          <input
            type="checkbox"
            data-testid="snap-vertex"
            checked={settings.vertex}
            disabled={!settings.enabled}
            onChange={(e) => onChange({ vertex: e.target.checked })}
          />
          {ADD_STRINGS.snapVertex}
        </label>

        {/* 辺・交点はドメインに無い（§N-6 の裁定待ち）。押せない形で理由を出す。 */}
        <label className="snap-options__row snap-options__row--disabled">
          <input type="checkbox" data-testid="snap-edge" checked={false} disabled readOnly />
          {ADD_STRINGS.snapEdge}
          <span className="snap-options__note">{ADD_STRINGS.snapNotYet}</span>
        </label>
        <label className="snap-options__row snap-options__row--disabled">
          <input
            type="checkbox"
            data-testid="snap-intersection"
            checked={false}
            disabled
            readOnly
          />
          {ADD_STRINGS.snapIntersection}
          <span className="snap-options__note">{ADD_STRINGS.snapNotYet}</span>
        </label>

        <label className="snap-options__row">
          {ADD_STRINGS.snapTolerance}
          <input
            type="number"
            className="snap-options__number"
            data-testid="snap-tolerance"
            min={SNAP_TOLERANCE_MIN_PX}
            max={SNAP_TOLERANCE_MAX_PX}
            step={1}
            value={toleranceDraft ?? String(settings.tolerancePx)}
            disabled={!settings.enabled}
            onChange={(e) => onToleranceInput(e.target.value)}
            onBlur={onToleranceBlur}
          />
          {ADD_STRINGS.snapToleranceUnit}
          {/* 入れられる範囲は画面に出す。`min` / `max` だけだと、外れた値を打って
              離れた瞬間に黙って別の数へ変わり、理由が分からない。 */}
          <span className="snap-options__note" data-testid="snap-tolerance-range">
            {SNAP_TOLERANCE_RANGE_TEXT}
          </span>
        </label>

        {gridSnap !== undefined && (
          <label className="snap-options__row">
            <input
              type="checkbox"
              data-testid="add-grid-snap"
              checked={gridSnap}
              onChange={(e) => onGridSnapChange(e.target.checked)}
            />
            {ADD_STRINGS.gridSnapLabel}
          </label>
        )}
      </div>
    </>
  );
}
