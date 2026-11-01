// UI layer (U32 / property panel): the layer-crossing contracts this unit
// CONSUMES from its dependencies (教訓 5.33 / 5.34: fix cross-layer contracts
// in the type system, both sides test against them).
//
// This unit is a CONSUMER (spec §目的「参照する側」). It does NOT own any of the
// truth below — it owns only the React UI that displays/edits through these
// contracts:
//   - the feature truth + a feature's anchor series (錨ユニット U03/U09),
//   - the ZIP-internal asset relative-reference → display-source resolution
//     (永続化ユニット — spec §やらないこと),
//   - the object-reference link target → selection update (U22),
//   - the edit-command dispatch (U16 → command base).
//
// Each contract is a narrow port: the property unit calls it, the host wires the
// real implementation. Tests inject fakes so the UI is exercised against the
// fixed contract, not the real dependency (教訓 5.41).

import type { AnchorSeries } from '../../domain/anchor-series';
import type { Feature } from '../../domain/feature';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import type { CascadedImpact } from './end-here-impact';

/**
 * Looks a feature up by id from the domain truth (錨ユニット / domain). Returns
 * `null` when the id no longer resolves (a stale reference). The property panel
 * NEVER reaches into the domain root itself — it asks through this port so the
 * domain-truth shape stays owned by its unit (単一の真実源).
 */
export interface FeatureLookup {
  featureAt(featureId: FeatureId): Feature | null;
}

/**
 * Looks up the per-feature history-anchor series (U09). The property panel
 * DISPLAYS the series (FR-84); it never re-sorts / re-validates it — ordering,
 * non-overlap and state-continuation are U09's single implementation (spec
 * §やらないこと). `null` when the feature has no series resolvable.
 */
export interface AnchorSeriesLookup {
  anchorSeriesOf(featureId: FeatureId): AnchorSeries | null;
  /**
   * その地物の編集が **実際に書き込まれる** 系列を返す（設計書 §C.6「集約地物の下位領域の錨」/
   * 裁定 §N-15）。自分の系列があればそれ、無ければ **その時刻に自分を含む親（集約地物）の
   * 系列**である。
   *
   * なぜ別の口が要るか: {@link anchorSeriesOf} は `histories.find(h => h.featureId === id)`
   * であり、実データの **86 件（3 つの集約地物の下位領域ぜんぶ）は必ず null を返す**。そのため
   * 素性欄は錨の欄ごと消えていたし、「この保存は錨を作るのか上書きするのか」も判定できな
   * かった。ドメイン側の編集（`applyEditProposal`）は `findHistoryContaining` で親の系列へ
   * 書くので、**画面もその系列を見なければ嘘になる**（教訓 5.46: 結果を決めている経路を見る）。
   *
   * 未実装のホスト（テストの偽物など）では省略できる。省略時、素性欄は今までどおり
   * 自分の系列だけを見る（honest stub — 無い機能を有るように見せない）。
   */
  governingSeriesOf?(featureId: FeatureId, at: TimePoint): GoverningAnchorSeries | null;
}

/** {@link AnchorSeriesLookup.governingSeriesOf} の結果。 */
export interface GoverningAnchorSeries {
  /** 編集が書き込まれる系列（そのまま = 親の系列のこともある）。 */
  readonly series: AnchorSeries;
  /** その系列を持っている地物の id。 */
  readonly ownerFeatureId: FeatureId;
  /**
   * 系列の持ち主の表示名。**自分の系列なら null**（借り物のときだけ名前を出す）。
   * `null` かどうかが「自分の歴史か、親の歴史か」の判定そのものである（教訓 5.18 の
   * 逆: 意味のある null を 1 つだけ持たせ、別のフラグを増やさない）。
   */
  readonly ownerName: string | null;
  /**
   * その時刻に実効なスナップショットの規模（地物数・頂点数）。新しい錨を 1 本作ると
   * これが丸ごと 1 部複製されるので、増える保存量の概算に使う（設計書 §A.3 / §D.3）。
   */
  readonly effectiveSize: { readonly featureCount: number; readonly vertexCount: number } | null;
}

/**
 * Resolves a ZIP-internal asset RELATIVE reference (e.g. `images/x.png`) to a
 * display-usable source string (e.g. a blob/object URL), or `null` when it does
 * not resolve. The real implementation lives in the persistence unit (asset I/O
 * / ZIP read); this unit only USES the contract so it never fetches an external
 * URL (FR-02 offline完結, spec §やらないこと). A `null` result is rendered as a
 * SAFE broken image — it never falls back to the raw外部 href.
 */
export interface AssetResolver {
  resolveAsset(relativeReference: string): string | null;
}

/**
 * The edit-command dispatch port (U16 → command base). The property unit builds
 * the EDIT INTENT (which feature, which anchor's start time as the edit time,
 * which new values) and hands it off; command application + undo/redo history is
 * the command unit's responsibility (spec §やらないこと). The host wires the
 * real bridge; tests assert the intent that was dispatched.
 */
export interface EditDispatch {
  dispatchEdit(intent: PropertyEditIntent): void;
}

/**
 * The存続期間編集 dispatch port (HB3-12, 教訓 5.7 配線漏れ修正). DISTINCT from
 * {@link EditDispatch}: a property/style edit ({@link PropertyEditIntent}) rewrites the
 * anchor's full-state SNAPSHOT at a time (U44 applyEditProposal → applyPastEdit) and
 * NEVER touches an anchor's start/end interval. A feature's existence on the time axis
 * is governed by {@link AnchorSeries} entry start/end, which only U09 `changeStart` /
 * `setEnd` / `deleteAnchor` move. The property panel hands the existence-edit INTENT
 * (which feature, which anchor, the operation) to the command base; the host wires the
 * real bridge to those U09 ops (a whole-state-swap command recorded as ONE undo unit,
 * mirroring 全錨 delete) and tests assert the intent that was dispatched.
 */
export interface AnchorIntervalEditDispatch {
  dispatchAnchorInterval(intent: AnchorIntervalEditIntent): void;
  /**
   * この編集を確定すると一緒に終わる集約地物（確定と同じ数え方の空打ち。B78）。錨を消す前の
   * 板が使う。押した瞬間に 1 度だけ呼ぶ。
   */
  describeAnchorIntervalCascade?(intent: AnchorIntervalEditIntent): readonly CascadedImpact[];
}

/** The three存続期間 operations (FR-54〜FR-59, §5.6). A typed constant (教訓 5.19). */
export const ANCHOR_INTERVAL_OP = {
  /** Move when the feature appears (U09 changeStart). */
  ChangeStart: 'changeStart',
  /** Set / change / clear (`null`) when the feature disappears (U09 setEnd). */
  SetEnd: 'setEnd',
  /** Remove this anchor entirely (U09 deleteAnchor; refused for the sole anchor). */
  Delete: 'delete',
  /**
   * 「この年に終わったことにする」（増分 7 の手直し 3 回目）: その年から先の、**途切れずに
   * 続いている記録をまとめて**終わらせる（`domain/affiliation/interval-edit.ts` の `endRunAt`）。
   * 存続期間の欄の「終わり」（`SetEnd`）は錨 1 本の終わりを打つ操作のまま。
   */
  EndHere: 'endHere',
} as const;

export type AnchorIntervalOp =
  (typeof ANCHOR_INTERVAL_OP)[keyof typeof ANCHOR_INTERVAL_OP];

/**
 * The存続期間編集 intent (HB3-12). Names the target feature, the specific anchor
 * (by id — the routing key for every U09 by-id edit), and the operation. The command
 * base resolves the feature's {@link AnchorSeries}, runs the matching U09 op, and
 * records the result as one undo unit; a rejected op surfaces honestly (never silent).
 */
export type AnchorIntervalEditIntent =
  | {
      readonly featureId: FeatureId;
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.ChangeStart;
      /** The new start time the anchor should appear at (U09 changeStart). */
      readonly newStart: TimePoint;
    }
  | {
      readonly featureId: FeatureId;
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.SetEnd;
      /** The new end time, or `null` to clear it (open-ended). */
      readonly newEnd: TimePoint | null;
    }
  | {
      readonly featureId: FeatureId;
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.Delete;
    }
  | {
      readonly featureId: FeatureId;
      /** その年に効いている錨。 */
      readonly anchorId: AnchorId;
      readonly op: typeof ANCHOR_INTERVAL_OP.EndHere;
      /** 終わる年。 */
      readonly at: TimePoint;
    };

/*
 * 詳細文書に専用の dispatch 口があった（DetailDocumentDispatch / DetailDocumentEditIntent）。
 * **増分 2 で無くした**（N-46 / 設計書 §C.6 の「保存の対象」）。素性欄の保存の対象は
 * 名前・種別ラベル・見た目・**詳細文書**の 4 つと決めたので、詳細文書は
 * {@link PropertyEditValues.detailDocument} として同じ 1 本の保存経路を通る。
 * こうすると「押さないと保存されない」場所が画面に 1 つになり、名前と文書を続けて直しても
 * **取り消しは 1 手**で済む（以前は別々の取り消し単位だった）。
 */

/**
 * The edit intent the property panel hands to the command base. It names the
 * target feature, the edit TIME (**always the CURRENT time** — context上の時刻,
 * never system time, 教訓 5.15), and the new values. The command unit decides how
 * to apply it (FR-55 past-edit semantics).
 *
 * **編集時刻は現在時刻である**（増分 2 / 設計書 §D.3 / 裁定 §N-2 の (A)）。以前は
 * 「選択中の錨の開始時刻」だったので、画面に「1200年」と出ていても保存すると 0 年の
 * 錨が黙って書き換わり、**「1500 年から国名が変わった」を記録する手段が画面に 1 つも
 * 無かった**。同じ時刻に錨があれば上書き、無ければその時刻を開始とする錨が 1 本増える
 * （FR-57 must）。どちらになるかは {@link EditPlan} が押す前に文字で見せる。
 * 渡す時刻は**年へ丸めてある**（錨の開始に月日を焼き付けない、U-14）。
 */
export interface PropertyEditIntent {
  readonly featureId: FeatureId;
  /** The edit time = the CURRENT time, rounded to the year (教訓 5.15 / §D.3). */
  readonly editTime: TimePoint;
  /** The new basic attributes + color values (FR-97). */
  readonly attributes: PropertyEditValues;
}

/** The editable基本情報 values (FR-97 / FR-100): basic attributes + 種別ラベル +
 * color info + 使用パレット + 詳細文書. paletteTheme is part of the single anchor
 * edit so a palette change is one undo unit alongside the other style attributes
 * (U33 AC1 / FR-59).
 *
 * **保存の対象は 4 つ**（設計書 §C.6 の「保存の対象」）: 名前・種別ラベル・見た目
 * （色・不透明度・パレット）・詳細文書。**親（所属）は含まない** — 親の変更は
 * `applyAffiliationProposal` という別の経路で、古い親と新しい親の両方に錨を立てる
 * ので、1 つの保存ボタンでは表せない（増分 7）。
 *
 * 種別ラベルと詳細文書がここに載ったのは増分 2 である。前者は入力欄がどこにも無く
 * （現状.md R5）、後者は**別の保存ボタン**を持っていて「押さないと保存されない」場所が
 * 画面に 2 つあった（N-46）。1 回の押下＝1 つの取り消し単位に揃えた。
 *
 * **飾りの開始年／終了年はここに載せない**（増分 2 の手直し A7 / GPT#8）。載っていた
 * ときは「表示専用の飾り」と説明した欄を触っただけで現在年に新しい錨が立ち、保存量と
 * 取り消し履歴が増えていた。契約どおり保存の対象は 4 つだけにし、飾りの 2 欄は
 * 読み取り専用の表示にした（値は地物が持っているものをそのまま出す）。
 *
 * この型は**ドメインの {@link CarriedAttributes} と同じ形**である（構造的に代入できる）。
 * 保存した属性を後ろの錨へ引き継ぐ範囲の予告（A1）を、画面とドメインで同じ計算に
 * 通すためである（教訓 5.29 単一の真実源）。 */
export interface PropertyEditValues {
  readonly name: string;
  /**
   * 種別ラベル（FR-40。「州」「都市」など利用者が自由に付ける表示用の文字列）。
   * 地物種別（点/線/末端/集約）とは別物で、形にも階層にも影響しない。空文字は
   * 「付いていない」を意味する（ドメイン側で absent へ正規化される）。
   */
  readonly kindLabel: string;
  readonly autoColorEnabled: boolean;
  readonly fillColor: string;
  /** 通常表示色の透過度（アルファ, 0..1）— a persisted style attribute (U33 AC1・AC5). */
  readonly fillOpacity: number;
  readonly selectedColor: string;
  /** 選択表示色の透過度（アルファ, 0..1）— a persisted style attribute (U33 AC1・AC5). */
  readonly selectedOpacity: number;
  readonly borderColor: string;
  /** 使用パレット（テーマ名）— the style attribute (FR-100 / U33 AC1). */
  readonly paletteTheme: string;
  /**
   * 詳細文書（FR-98）の生 Markdown。空文字は「文書なし」（ドメインが absent へ
   * 正規化する — 唯一の空の形）。**同じ保存で一緒に確定する**ので、名前と文書を
   * 続けて直しても取り消しは 1 手で済む（N-46）。
   */
  readonly detailDocument: string;
}
