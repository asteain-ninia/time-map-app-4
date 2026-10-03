// UI layer (U32 / property panel): basic-info display + edit form (FR-97 / FR-99
// 前段, 教訓 5.13 / 5.24 / 5.12).
//
// Shows the target feature's basic attributes (名前・種別ラベル)、派生の面積・存続期間、
// and color info (自動配色許可・塗り色・選択時色・境界色). One `editable` judgment
// controls the WHOLE form (教訓 5.13): in view mode every input is disabled — there is
// no per-widget permission check.
//
// **下書きも保存ボタンも、ここには無い**（増分 2）。このフォームは
// {@link PropertyEditValues} を受け取って表示し、変更を親へ返すだけの **制御された
// フォーム** である。理由は 2 つ。
//   1. 保存列は素性欄の**下端に固定**する（設計書 §C.6 / C7。現物は保存ボタンの
//      `offsetTop` が 755.8px で初期表示の外にあり、誰も見なかった）。下端に置くには
//      ボタンがフォームの外＝パネルの最後の子でなければならない。
//   2. 保存の対象は名前・種別ラベル・見た目・**詳細文書**の 4 つで、詳細文書は別の
//      セクションが持っている（設計書 §C.6 の「保存の対象」）。**押さないと保存され
//      ない場所が 2 つある**状態（N-46）を 1 つに揃えるには、下書きを両方の上（パネル）
//      で持つしかない。
//
// 「打ちかけの下書きをいつ捨てるか」（教訓 5.2 / 5.12 / N-04）もパネル側の責任になった。

import { useMemo, type Ref } from 'react';

import type { Feature } from '../../domain/feature';

import type { PaletteThemeId } from '../../domain/coloring';

import type { PropertyEditValues } from './contracts';
import { PROPERTY_STRINGS, formatAreaKm2, formatLengthKm } from './messages';
import { StyleSection } from './StyleSection';
import { styleOnAutoColorToggle } from './auto-color-off';
import { type StyleValues } from './style-section';

export interface BasicInfoFormProps {
  /** The feature whose基本情報 is shown/edited (the resolved edit target). */
  readonly feature: Feature;
  /** Whole-form edit gate (教訓 5.13). False = view-only. */
  readonly editable: boolean;
  /** 表示・編集する下書きの値（親が持つ。単一真実源）。 */
  readonly values: PropertyEditValues;
  /** 下書きの一部を書き換える（親へ返す）。 */
  readonly onChange: (next: Partial<PropertyEditValues>) => void;
  /**
   * Available palette themes for the U33「スタイル」section dropdown (FR-109).
   * Defaults to the current feature's theme alone when a host has not wired the
   * settings-provided list, so the section still mounts and round-trips.
   */
  readonly paletteThemes?: readonly PaletteThemeId[];
  /**
   * FR-20: the DERIVED area (km²) of a 面 (leaf) feature's resolved shape at the
   * edit time. A read-only display value the PARENT computes via the geodesy unit's
   * shapeAreaKm2 (単一真実源, src/domain/geo/geodesy.ts) — never re-derived here.
   * Present only for leaf features (point / line features carry no area, so the
   * parent passes `undefined` and no 面積 row renders).
   */
  readonly areaKm2?: number;
  /**
   * **本物の存続期間**（錨の並びが正本, U-23）を初期表示に出すための 1 行
   * （「0年 → 継続中」。途中に存在しない期間があれば「0年 → 2000年、3000年 → 継続中」
   * のように穴を隠さない）。飾りの開始年／終了年は畳んだ「詳しい属性」へ下ろした
   * （裁定 §N-5 の (A)）。解決できないときは省く（値を捏造しない）。
   */
  readonly existenceLabel?: string;
  /**
   * 上位領域（親）の表示名。無ければ `null`、引けなければ `undefined`（行を出さない）。
   * **値は表示だけで、変えるのは下の 3 ボタンである**（設計書 §C.6 の「保存の対象」:
   * 保存ボタンが受け持つのは名前・種別・見た目・詳細文書の 4 つだけで、親は別経路）。
   */
  readonly parentName?: string | null;
  /**
   * FR-19 must（G-1 / 現状.md R1）: 線情報の長さ（km）。面積と同じ形の読み取り専用行で、
   * 親が測地の 1 本（`lineLengthKm`）から出す。線でなければ `undefined`（行を出さない）。
   */
  readonly lengthKm?: number;
  /**
   * 名前の入力欄への参照（増分 4）。作業のまとまりの送りが「次の未処理を選び、
   * **名前欄に焦点を入れる**」を成り立たせるために、親が焦点を入れられるようにする。
   * **DOM を名前で探さない**（結合点 #3 の反省。`property/name-focus.ts` の注記）。
   */
  readonly nameInputRef?: Ref<HTMLInputElement>;
  /**
   * 名前欄・種別欄で Enter を押したとき（増分 4 / 設計書 §I.2）。
   * `advance` は「保存して**次へ**」か「保存だけ」か（Ctrl+Enter は次へ進まない）。
   */
  readonly onSubmit?: (advance: boolean) => void;
  /**
   * この欄がいま **打ちかけを抱えていない**か（2026-09-06、2 回目の手直し）。
   *
   * 真のとき、名前欄・種別欄は `data-pristine="true"` と名乗る。大域の鍵盤の門番
   * （`focus-guard`）はこの名乗りを見て、**取り消し（Ctrl+Z / Ctrl+Y）と束の送り
   * （Alt+↑ / Alt+↓）だけ**を通す。素性欄の Enter は「保存して次へ」で焦点が次の
   * 地物の名前欄に残るので、これが無いと **送った直後に取り消せない**。
   */
  readonly pristine?: boolean;
  /**
   * 名前欄・種別欄で Escape を押したとき（2026-09-06）。焦点を一覧へ返す口。
   * 旧版は Escape で何も起きず、**焦点を外す手が鍵盤に無かった**。
   */
  readonly onEscape?: () => void;
  /**
   * 親欄の 3 ボタン（設計書 §C.6 / G-3 / FR-46 must。増分 7 の中身 3b）。
   *
   * **押した瞬間に所属変更の手順へ入る**（保存ボタンの対象ではない）。渡さない
   * 呼び出し側では従来どおり押せないまま理由を添えて出す ―― **押せるのに動かない
   * 部品を作らない**（§H.5 の作法）。
   */
  readonly onParentPick?: () => void;
  readonly onParentCreate?: () => void;
  readonly onParentClear?: () => void;
  /**
   * **この年に終わったことにする**（設計書 §A.3 の削除の入口 A。増分 7 の中身 5）。
   * 存続期間の行の隣・目立つ位置に置く。渡さない呼び出し側ではボタンを出さない。
   */
  readonly onEndHere?: () => void;
  /** 入口 A のボタンの文言（「1500年に終わったことにする」）。 */
  readonly endHereLabel?: string;
  /**
   * いま居る区間に終わりが打たれているときの状態の文（司令塔の決定 (12) / GPT #5:
   * 「この地物は○○年で終わります」）。打たれていなければ渡さない（値を捏造しない＝
   * honest absence）。いま見ている年が終わった後の表示は素性欄が別に出す
   * （`existence-status.ts`）。
   */
  readonly endStateText?: string;
  /** 入口 A を押せない理由（自分の歴史を持たない地物など）。押せるなら `null`。 */
  readonly endHereDisabledReason?: string | null;
  /**
   * この下書きで、すでに 1 度自動配色を OFF にしたか（増分 8E の再手直し / G-15）。覚えは
   * **下書きと同じ場所**（素性欄）が持ち、下書きを作り直すときに一緒に消す（このフォームは
   * 選択を外す・居ない年へ動くと外れるので、ここで覚えると下書きより先に消える）。
   * 渡されないときは false（いつも「初めての OFF」として扱う）。
   */
  readonly autoColorWentManual?: boolean;
  /** 下書きの自動配色が OFF になったことを、覚えの持ち主へ知らせる口。 */
  readonly onAutoColorWentManual?: () => void;
}

/**
 * Project the form draft into the U33 style-section values (FR-102). EVERY style
 * attribute — autoColor / palette / fill / selected AND their透過度（アルファ,
 * U33 spec 行23-26 / AC1・AC5) — is bound to the SAME draft, so a style edit
 * (including a transparency slider drag) lands on the single anchor edit + undo
 * unit and is persisted (U33 AC1 / FR-59).
 */
function styleValuesFromDraft(draft: PropertyEditValues): StyleValues {
  return {
    autoColorEnabled: draft.autoColorEnabled,
    paletteTheme: draft.paletteTheme,
    fillColor: draft.fillColor,
    fillOpacity: draft.fillOpacity,
    selectedColor: draft.selectedColor,
    selectedOpacity: draft.selectedOpacity,
  };
}

export function BasicInfoForm(props: BasicInfoFormProps): JSX.Element {
  const {
    feature,
    editable,
    values: draft,
    onChange,
    areaKm2,
    existenceLabel,
    parentName,
    lengthKm,
    onSubmit,
    onEscape,
  } = props;

  /**
   * 名前欄・種別欄の Enter（設計書 §I.2）。**Ctrl+Enter は保存だけして次へ進まない。**
   * `onSubmit` が渡っていないとき（テスト・組み込み前）は既定のまま素通しする。
   */
  const onFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      // **焦点を一覧へ返す**（2026-09-06）。旧版は Escape で何も起きず、鍵盤だけでは
      // 欄から出られなかった（実測）。打ちかけは捨てない ―― 捨てるかどうかは
      // §D.4 の Esc の階段が決めることで、ここは「どこへ戻すか」だけを担う。
      if (onEscape === undefined) return;
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== 'Enter' || onSubmit === undefined) return;
    e.preventDefault();
    onSubmit(!e.ctrlKey);
  };
  /**
   * 親欄の 3 ボタンを押せるか（増分 7 の中身 3b）。**3 つとも配線されているときだけ**
   * 押せる ―― 1 つでも欠けていると「押せるのに動かない部品」ができる（§H.5 の作法）。
   * 読むだけのときも押せない（教訓 5.13: 権限の関門は 1 か所で、ここは `editable` を見る）。
   */
  const parentActionsReady =
    editable &&
    props.onParentPick !== undefined &&
    props.onParentCreate !== undefined &&
    props.onParentClear !== undefined;
  const parentDisabledReason = editable
    ? PROPERTY_STRINGS.parentDisabledReason
    : PROPERTY_STRINGS.viewOnlyNotice;
  const endHereReason = props.endHereDisabledReason ?? null;

  // Default the palette dropdown to the feature's current theme alone so the
  // section mounts even when the host has not wired the settings-provided list.
  const paletteThemes = useMemo(
    () => props.paletteThemes ?? [feature.color.paletteTheme],
    [props.paletteThemes, feature.color.paletteTheme],
  );
  return (
    <section className="basic-info" data-testid="basic-info">
      <h3>{PROPERTY_STRINGS.basicInfoTitle}</h3>

      {!editable && (
        <p className="basic-info__notice" data-testid="view-only-notice">
          {PROPERTY_STRINGS.viewOnlyNotice}
        </p>
      )}

      <label className="basic-info__field">
        <span>{PROPERTY_STRINGS.nameLabel}</span>
        <input
          type="text"
          aria-label={PROPERTY_STRINGS.nameLabel}
          value={draft.name}
          disabled={!editable}
          {...(props.nameInputRef !== undefined ? { ref: props.nameInputRef } : {})}
          data-pristine={props.pristine === true ? 'true' : 'false'}
          onChange={(e) => onChange({ name: e.target.value })}
          onKeyDown={onFieldKeyDown}
        />
      </label>

      {/*
        FR-40 — 種別ラベル（「州」「都市」など）。データ構造にも保存形式にも最初から
        あるのに **入力欄がどこにも無かった**（現状.md R5）。保存の対象 4 つのうちの
        1 つ（設計書 §C.6）なので、名前の隣に置く。空欄＝付いていない。
      */}
      <label className="basic-info__field">
        <span>{PROPERTY_STRINGS.kindLabelLabel}</span>
        <input
          type="text"
          aria-label={PROPERTY_STRINGS.kindLabelLabel}
          placeholder={PROPERTY_STRINGS.kindLabelPlaceholder}
          value={draft.kindLabel}
          disabled={!editable}
          data-pristine={props.pristine === true ? 'true' : 'false'}
          onChange={(e) => onChange({ kindLabel: e.target.value })}
          onKeyDown={onFieldKeyDown}
        />
      </label>

      {/*
        **上位領域（親）の行**（現状.md B27 / 設計書 §C.6）。増分 2 までは行そのものが
        無く、「いま何の下に居るのか」が素性欄から読めなかった。

        **2 行にする**（値の行とボタンの行）。設計書 §C.6 の「横の収まり」が求めている
        形で、内容幅 264px に「ラベル 64 ＋ 入力 200」と 3 つのボタンを同居させると
        物理的に入らない。ボタン行は 88＋88＋80 ＝ 256px で収まる。

        **3 ボタンは手順の配線が揃っているときだけ有効**（§H.5 の作法）。所属を変えるのは
        「押した瞬間に手順へ入る」操作で、手順そのもの（3 択の板・進行表示・分け残しの
        名前入力）は合成ルートが繋ぐ。**押せるのに動かない部品を作らない**ので、繋がって
        いないホストでは押せなくして理由を添える。
      */}
      {parentName !== undefined && (
        <div className="basic-info__parent" data-testid="parent-row">
          <div className="basic-info__field basic-info__field--readonly">
            <span>{PROPERTY_STRINGS.parentLabel}</span>
            <output data-testid="parent-value">
              {parentName ?? PROPERTY_STRINGS.parentNone}
            </output>
          </div>
          <div className="basic-info__parent-buttons" data-testid="parent-buttons">
            <button
              type="button"
              data-testid="parent-pick"
              disabled={!parentActionsReady}
              title={parentActionsReady ? undefined : parentDisabledReason}
              onClick={props.onParentPick}
            >
              {PROPERTY_STRINGS.parentPickLabel}
            </button>
            <button
              type="button"
              data-testid="parent-create"
              disabled={!parentActionsReady}
              title={parentActionsReady ? undefined : parentDisabledReason}
              onClick={props.onParentCreate}
            >
              {PROPERTY_STRINGS.parentCreateLabel}
            </button>
            <button
              type="button"
              data-testid="parent-clear"
              disabled={!parentActionsReady}
              title={parentActionsReady ? undefined : parentDisabledReason}
              onClick={props.onParentClear}
            >
              {PROPERTY_STRINGS.parentClearLabel}
            </button>
          </div>
          {!parentActionsReady && (
            <p className="basic-info__parent-reason" data-testid="parent-disabled-reason">
              {parentDisabledReason}
            </p>
          )}
        </div>
      )}

      {/*
        FR-19 must（G-1 / 現状.md R1）: 線情報の **長さ**。面積（下）と対になる行で、
        計算関数 `lineLengthKm` はテスト以外から呼ばれていなかった。
      */}
      {lengthKm !== undefined && (
        <div className="basic-info__field basic-info__field--readonly" data-testid="length-row">
          <span>{PROPERTY_STRINGS.lengthLabel}</span>
          <output data-testid="length-value">{formatLengthKm(lengthKm)}</output>
        </div>
      )}

      {/*
        FR-20: the 面積（km²）of a 面 (leaf) feature. A READ-ONLY derived row — no
        input, never part of the edit draft / save intent — computed by the parent
        via the geodesy shapeAreaKm2 (単一真実源).
      */}
      {areaKm2 !== undefined && (
        <div className="basic-info__field basic-info__field--readonly" data-testid="area-row">
          <span>{PROPERTY_STRINGS.areaLabel}</span>
          <output data-testid="area-value">{formatAreaKm2(areaKm2)}</output>
        </div>
      )}

      {/*
        **本物の存続期間**（U-23: 正本は錨の並び）。初期表示に出るのはこれだけで、
        飾りの開始年／終了年は下の「詳しい属性」へ下ろした（裁定 §N-5 の (A)）。
        「1500 年に滅ぶ」を記録しようとして飾りの欄を直しても何も起きない、という
        事故がこれで消える（現状分析 N-05 / BH1-11「終了年 9999」）。
      */}
      {existenceLabel !== undefined && (
        <div
          className="basic-info__field basic-info__field--readonly"
          data-testid="existence-row"
        >
          <span>{PROPERTY_STRINGS.existenceLabel}</span>
          <output data-testid="existence-value">{existenceLabel}</output>
        </div>
      )}

      {/*
        **削除の入口 A**（設計書 §A.3 / 増分 7 の中身 5）。「消す」と言われる操作の実体は
        たいてい **消滅ではなく終了**なので、目立つ位置に置くのはこちらである。全部の年から
        消すほうは畳んだ「取り返しのつかないこと」の中にある。
        T25「1500 年に滅ぶを記録する」が 30 秒かかっていたのは、この分岐が言葉として
        立っていなかったからである。
      */}
      {props.onEndHere !== undefined && props.endHereLabel !== undefined && (
        <div className="basic-info__end-here" data-testid="end-here-row">
          <button
            type="button"
            data-testid="end-here"
            disabled={!editable || endHereReason !== null}
            title={endHereReason ?? PROPERTY_STRINGS.endHereHint}
            onClick={props.onEndHere}
          >
            {props.endHereLabel}
          </button>
          {endHereReason !== null && (
            <p className="basic-info__end-here-reason" data-testid="end-here-reason">
              {endHereReason}
            </p>
          )}
          {/* **終わっている状態を読める形にする**（司令塔の決定 (12)）。押したあと
              「終わったのかどうか」が素性欄のどこにも出ていなかった。 */}
          {props.endStateText !== undefined && (
            <p className="basic-info__end-here-state" data-testid="end-here-state">
              {props.endStateText}
            </p>
          )}
        </div>
      )}

      {/*
        U33「スタイル」section (FR-102): owns 自動配色許可・使用パレット・通常表示色・
        選択表示色 as the single permission-gated section (教訓 5.13). It binds to the
        SAME draft as the rest of the form, so a style change (incl. palette) lands
        on the single anchor edit + undo unit (U33 AC1 / FR-59). The sole basic-color
        attribute it does NOT own — 境界色 (FR-97) — stays in the 色情報 fieldset below.
      */}
      <StyleSection
        values={styleValuesFromDraft(draft)}
        paletteThemes={paletteThemes}
        sectionEnabled={editable}
        onChange={(raw) => {
          // 増分 8E（G-15 / FR-100）: 自動配色を OFF にした瞬間は、いま塗られている色を
          // 手動色として残す（規則は auto-color-off.ts の 1 か所）。
          // 往復しても打ち込んだ手動色を失わないよう、「この下書きで 1 度 OFF にしたか」は
          // 素性欄が下書きと一緒に覚えている（増分 8E の再手直し）。
          const next = styleOnAutoColorToggle(
            feature,
            styleValuesFromDraft(draft),
            raw,
            props.autoColorWentManual ?? false,
          );
          if (!next.autoColorEnabled) props.onAutoColorWentManual?.();
          onChange({
            autoColorEnabled: next.autoColorEnabled,
            paletteTheme: next.paletteTheme,
            fillColor: next.fillColor,
            fillOpacity: next.fillOpacity,
            selectedColor: next.selectedColor,
            selectedOpacity: next.selectedOpacity,
          });
        }}
      />

      <fieldset className="basic-info__colors" disabled={!editable}>
        <legend>{PROPERTY_STRINGS.colorSectionTitle}</legend>

        <label className="basic-info__field">
          <span>{PROPERTY_STRINGS.borderColorLabel}</span>
          <input
            type="text"
            aria-label={PROPERTY_STRINGS.borderColorLabel}
            value={draft.borderColor}
            disabled={!editable}
            onChange={(e) => onChange({ borderColor: e.target.value })}
          />
        </label>
      </fieldset>

      {/*
        飾りの開始年／終了年（裁定 §N-5 の (A)）。**値は残す**（U-28「詳細パネルには
        全属性を出す」は折りたたみの中でも守られる）が、初期表示からは下ろす。これらは
        地物がいつ現れていつ消えるかを **一切動かさない** 表示専用の属性で、本物は上の
        「続く」行（＝錨の並び）である。

        **読み取り専用にした**（増分 2 の手直し A7 / GPT#8）。保存の対象は名前・種別
        ラベル・見た目・詳細文書の 4 つ **だけ** と契約したのに、この 2 欄が
        {@link PropertyEditValues} に載っていたので、「表示専用の飾り」と説明した欄を
        触っただけで現在年に新しい錨が立ち、保存量と取り消し履歴が増えていた。
      */}
      <details className="basic-info__advanced" data-testid="basic-info-advanced">
        <summary data-testid="basic-info-advanced-summary">
          {PROPERTY_STRINGS.advancedAttributesTitle}
        </summary>
        <p className="basic-info__advanced-hint">{PROPERTY_STRINGS.advancedAttributesHint}</p>

        <div className="basic-info__field basic-info__field--readonly">
          <span>{PROPERTY_STRINGS.startYearLabel}</span>
          <output data-testid="decorative-start-year">{feature.attributes.startYear}</output>
        </div>

        <div className="basic-info__field basic-info__field--readonly">
          <span>{PROPERTY_STRINGS.endYearLabel}</span>
          <output data-testid="decorative-end-year">{feature.attributes.endYear}</output>
        </div>
      </details>
    </section>
  );
}
