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
// **増分 5 の手直し A4: 器を共通の `shell/OptionPopover` に載せ替えた。** 開閉の作法
// （`position: fixed` で置く・`[hidden]` の打ち消し・背面に板を置かない・外の押下と
// Escape で閉じる・状態が移ったら閉じる）を自分の中に写して持っていたのは、4 枚ある
// ポップオーバーのうちこれ 1 枚だけだった。写しが残ると経路によって新旧が混ざる
// （教訓 5.44）。そして**写しには `onOpenChange` が無かった**ので、この板を開いても
// 鍵盤の持ち主（`focusOwner`）は `map` か `tool-drawing` のままで、**開いた板の背後で
// Ctrl+Z・Delete・道具の単キー・保存が走った**（GPT #4）。器を 1 つにすれば、報せ口も
// 1 つで済む。

import { useCallback, useState } from 'react';

import { OptionPopover } from '../shell/OptionPopover';
import {
  clampSnapTolerancePx,
  SNAP_TOLERANCE_MAX_PX,
  SNAP_TOLERANCE_MIN_PX,
  type SnapSettings,
} from '../state/session';

import { ADD_STRINGS, ADD_TEXT } from './strings';

/**
 * 許容値に入れられる範囲を、欄のそばに **目で見える形で** 出す文字列（「1〜50px」）。
 *
 * 数値は `session.ts` の定数から組み立てる。ここに 1 と 50 を書き写すと、範囲を変えた
 * ときに画面の案内だけ古いまま残る（教訓 5.29 単一真実源）。
 */
const SNAP_TOLERANCE_RANGE_TEXT = ADD_TEXT.snapToleranceRange(SNAP_TOLERANCE_MIN_PX, SNAP_TOLERANCE_MAX_PX);

export interface SnapOptionsProps {
  readonly settings: SnapSettings;
  readonly onChange: (patch: Partial<SnapSettings>) => void;
  /** グリッドスナップ（FR-78）。作図セッションが無いときは undefined。 */
  readonly gridSnap: boolean | undefined;
  readonly onGridSnapChange: (on: boolean) => void;
  /**
   * **状態の指紋**（`OptionPopover` の `closeKey`）。これが変わったら開いている板を
   * 閉じる。道具を持ち替えた・年が動いた、で古い中身が開いたまま残らないようにする。
   */
  readonly closeKey: string;
  /** 開閉の報せ（`focusOwner` の `popover` を App が 1 か所で導出するため）。 */
  readonly onOpenChange?: (open: boolean) => void;
}

export function SnapOptions(props: SnapOptionsProps): JSX.Element {
  const { settings, onChange, gridSnap, onGridSnapChange, closeKey, onOpenChange } = props;

  // 許容値の欄に **打っている途中の文字**（null = 触っていない ＝ 設定の値をそのまま出す）。
  //
  // これが無いと、打つそばから値が書き換わる。欄を設定の値で直に描いていたので、
  // 「50」を打とうとして「5」まで入れた時点で店（ストア）が `clampSnapTolerancePx` で
  // 丸めた値を返し、次の 1 文字を打つ前に欄の中身が入れ替わっていた。**丸めるのは欄から
  // 離れたとき（blur）だけ**にして、打っている間は打った文字をそのまま残す。
  const [toleranceDraft, setToleranceDraft] = useState<string | null>(null);

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

  return (
    <OptionPopover
      label={ADD_STRINGS.snapMenuLabel}
      buttonTestId="option-snap-button"
      panelTestId="option-snap-panel"
      buttonClassName="snap-options__button"
      panelClassName="snap-options__panel"
      ariaLabel={ADD_STRINGS.snapMenuLabel}
      closeKey={closeKey}
      // 行が 1 本増減する（グリッドの行）ので、置き場所を測り直す契機に入れる。
      measureKey={gridSnap === undefined}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {() => (
        <>
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
        </>
      )}
    </OptionPopover>
  );
}
