// UI layer (U40 wiring): the LIVE right-click context-menu port (FR-96).
//
// ROOT FIX (bughunt2: FR-96 の右クリックメニューが NO-OP ポートに結線され、実アプリで
// 右クリックしても何も出ない). The U40 dispatcher routes EVERY right-button press to
// the `contextMenu` port (dispatch.ts:「Right button is always a context-menu
// request, never a pan」), but the composition root backed that port with
// {@link NOOP_CONTEXT_MENU_PORT} — `request(){}` — so the right-click 導線 was a
// dead end: the U20 {@link ContextMenu} component + the {@link CommandRegistry}
// path existed and were unit-tested, yet were never reached from real pointer
// input (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない状態を作らない」).
//
// This module is the missing 結線: a concrete {@link ContextMenuPort} that, on a
// right-button press, (1) promotes the hit feature into the LIVE selection through
// the SAME selection-write path a left click uses (so a menu command — e.g. 削除 —
// targets the right-clicked feature, 教訓 5.11), and (2) opens the {@link ContextMenu}
// at the cursor via an injected open-callback bridged to React state. It re-uses the
// EXISTING command-id menu mechanism (registry + permission gate) — it re-implements
// no menu rendering, positioning, or command body (単一真実源, 教訓 5.13 / 5.29).

import {
  HIT_KIND,
  replaceVertices,
  withActiveFeature,
  withoutVertexSet,
  type HitResult,
  type SelectionState,
} from '../../domain/selection';
import type { ContextMenuPort } from './ports';
import type { ScreenPoint } from '../../render';

/**
 * What an open context-menu request carries to the React mount: where to anchor
 * the menu (VIEWPORT/client px — the {@link ContextMenu} uses `position: fixed`)
 * and the hit-test result that produced it (so the menu can target the hit
 * feature). The hit is already resolved by the dispatcher's live hit-tester
 * (single truth source — what is drawn == what is hit, 教訓 5.29).
 */
export interface ContextMenuRequest {
  /** Anchor in viewport/client pixels (the menu renders position:fixed). */
  readonly clientX: number;
  readonly clientY: number;
  /** What the right-click hit (feature body / vertex / empty). */
  readonly hit: HitResult;
  /**
   * 右クリックした場所にある **測量の線**の id（増分 8C / 設計書 §E.1 V15）。近い順。
   *
   * 地図から来た要求だけが持つ（{@link LiveContextMenuPortDeps.probeSurveyLines}）。
   * 一覧の行の右クリックのように地図の外から開く要求には付かないので、行の下に
   * たまたま線が描かれていても「この線を消す」は出ない。省略・空配列は「当たっていない」。
   */
  readonly surveyLineIds?: readonly number[] | undefined;
}

/**
 * The dependencies the live context-menu port needs from the composition root.
 * All are read live per request (never a stale capture, 教訓 5.6).
 */
export interface LiveContextMenuPortDeps {
  /**
   * Convert a SURFACE-relative screen point (the dispatcher works in surface
   * space) back to VIEWPORT/client pixels for the position:fixed menu. Backed by
   * the SAME element rect the dispatcher's `toSurface` uses, so the menu opens
   * exactly under the cursor (no second transform, 教訓 5.29).
   */
  readonly surfaceToClient: (point: ScreenPoint) => { x: number; y: number };
  /**
   * Promote the right-clicked feature into the live selection so a chosen menu
   * command acts on it (教訓 5.11 — 右クリック対象がコマンドの対象になる). A
   * feature-body / vertex hit selects that feature; an empty hit leaves the
   * current selection untouched (a right-click on empty space offers only the
   * view-axis items, never silently clearing what was selected).
   */
  readonly promoteHit: (hit: HitResult) => void;
  /**
   * Open the menu in React (the bridge to component state). Called with the
   * resolved client anchor + hit; a no-op until the mount wires it.
   */
  readonly open: (request: ContextMenuRequest) => void;
  /**
   * Whether the right-click menu is currently SUSPENDED (段階7 優先規則). Optional —
   * absent ⇒ never suspended (the current App wiring). When it returns `true` the
   * request is dropped ENTIRELY — neither `promoteHit` NOR `open` runs — so a
   * right-click during a tool draft (knife/merge/…) or a modal does not open a
   * competing edit menu AND does not silently mutate the selection out from under the
   * in-progress gesture (教訓 5.2 / 5.13; the draft's own Esc owns cancellation). The
   * App binds it to `shortcutsSuspended` (modal || *Drawing).
   */
  readonly suspended?: () => boolean;
  /**
   * **選択の昇格をしてよいか**（増分 5 の手直し A1）。省略 ⇒ 常に昇格する（従来どおり）。
   *
   * `false` を返すあいだ、右クリックは **メニューを開くだけ**で選択を書き換えない。
   * 作図中（道具が下書きを持っている）に右クリックすると、昇格が背後の地物を選択へ
   * 引き上げ、それを見張っていた追加の道具が **下書きを黙って捨てて視点まで飛ばす**
   * ―― 実データで再現した重症度 4 の事故である。メニュー自体は開けなければならない
   * （設計書 §I.3 の原則①）ので、止めるのは昇格だけにする。
   */
  readonly promotes?: () => boolean;
  /**
   * **右クリックした点に当たる測量の線**を近い順に返す（増分 8C / 設計書 §E.1 V15）。
   * 省略 ⇒ 測量の線は見ない（従来どおり）。
   *
   * 当たった線があれば要求に `surveyLineIds` として載せ、**地物の昇格はしない** ――
   * 測量の線は地物より上に描かれていて、押した相手は線だからである。昇格すると、
   * 線を消すつもりの右クリックが下の国を選択へ引き上げてしまう（「測っている間は
   * 地物を選べません」とも食い違う）。
   *
   * **線に当たったメニューには地物の項目を出さない**（増分 8C の手直し / 反証 #1。
   * `MapContextMenu` の `open` が地物の模型を組まない）。昇格しないまま地物の項目を
   * 並べると、項目は **押していない、いま選んでいる別の地物** に向き、線から数 px の
   * 国を押したつもりで別の国を消す・終わらせることになる。
   *
   * **頂点・辺の把手に当たったときは呼ばない**（把手は線より上に描かれている）。
   */
  readonly probeSurveyLines?: (point: ScreenPoint) => readonly number[];
}

/**
 * Resolve the LIVE selection a right-click promote produces from the current
 * selection + hit — the SAME rule a LEFT click applies (単一の選択書き込み経路,
 * 教訓 5.11 / 5.29):
 *   - a FEATURE BODY hit → that feature becomes the sole active feature AND any
 *     vertex selection is CLEARED (mirrors the U22 reducer's body branch —
 *     `withoutVertexSet(withActiveFeature(...))`, reducer.ts). The earlier
 *     right-click path set the active feature ONLY, so a stale vertex set from a
 *     prior rubber-band survived and a following 削除 wrongly targeted THOSE
 *     vertices on ANOTHER feature instead of the right-clicked body (bughunt5
 *     HOLE-2 degradation — the left-click path already cleared it, this is the
 *     asymmetry fix);
 *   - a VERTEX hit → that feature is active AND the vertex set is REPLACED with
 *     the single hit vertex (unchanged from the prior behaviour: setActiveFeature
 *     + replaceVertexSelection, composed here through the SAME U22 builders);
 *   - an EMPTY hit → the current selection is returned UNCHANGED (the caller never
 *     promotes on empty space — a right-click there keeps what was selected).
 * Pure — no store access; the caller writes the result through `restoreSelection`.
 */
export function promoteHitToSelection(
  current: SelectionState,
  hit: HitResult,
): SelectionState {
  switch (hit.kind) {
    case HIT_KIND.FeatureBody:
      return withoutVertexSet(withActiveFeature(current, hit.featureId));
    case HIT_KIND.Vertex:
      return replaceVertices(
        withActiveFeature(current, hit.featureId),
        hit.featureId,
        new Set([hit.vertexId]),
      );
    default:
      // Edge / Empty: not a promote target — leave the selection untouched.
      return current;
  }
}

/**
 * Build the LIVE {@link ContextMenuPort} the dispatcher requests on a right-button
 * press. The dispatcher hands a SURFACE point + hit; the port converts the point to
 * client space, promotes the hit feature into selection, then opens the menu. It
 * holds NO menu state — that lives in the React mount (technique 2.3: the live input
 * path stays off React re-render until an actual menu opens).
 */
export function createLiveContextMenuPort(
  deps: LiveContextMenuPortDeps,
): ContextMenuPort {
  return {
    request(point: ScreenPoint, hit: HitResult): void {
      // 段階7 優先規則: while suspended (tool draft / modal) DROP the request whole —
      // skip BOTH promoteHit AND open together, so no menu opens and the LIVE
      // selection is left UNCHANGED (a stray promote during a knife draft would
      // desync the session's own selection assumptions, 教訓 5.2 / 5.6).
      if (deps.suspended?.() === true) return;
      // 測量の線に当たったか（増分 8C）。当たっていれば、その線が押した相手になる。
      //
      // **頂点・辺の把手に当たったときは線を調べない**（増分 8C の手直し / 反証 #1）。
      // 把手は測量の線より上に描かれている（`ui/add/host-ports.ts` の重ね順）ので、
      // 押した相手は把手である。把手の当たりは把手が描かれているときにしか返らない
      // （`mount/hit-test.ts` の `handlesDrawn`）ので、見えていない把手が線に勝つことは無い。
      const handleHit = hit.kind === HIT_KIND.Vertex || hit.kind === HIT_KIND.Edge;
      const surveyLineIds = handleHit ? [] : (deps.probeSurveyLines?.(point) ?? []);
      // Promote the hit feature FIRST so the menu's command target is the
      // right-clicked feature (削除 etc.), exactly as a left click would select it
      // (単一の選択書き込み経路, 教訓 5.11). Empty space keeps the current selection.
      //
      // **下書きを持っているあいだは昇格しない**（増分 5 の手直し A1）。メニューは
      // 開くが選択は動かさないので、作図中の右クリックが下書きを壊さない。
      //
      // **測量の線に当たったときも昇格しない**（増分 8C。`probeSurveyLines` の注記）。
      if (
        hit.kind !== HIT_KIND.Empty &&
        surveyLineIds.length === 0 &&
        deps.promotes?.() !== false
      ) {
        deps.promoteHit(hit);
      }
      const { x, y } = deps.surfaceToClient(point);
      deps.open(
        surveyLineIds.length === 0
          ? { clientX: x, clientY: y, hit }
          : { clientX: x, clientY: y, hit, surveyLineIds },
      );
    },
  };
}
