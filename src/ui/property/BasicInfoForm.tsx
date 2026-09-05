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
import { PROPERTY_STRINGS, formatAreaKm2 } from './messages';
import { StyleSection } from './StyleSection';
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
  const { feature, editable, values: draft, onChange, areaKm2, existenceLabel, onSubmit } = props;

  /**
   * 名前欄・種別欄の Enter（設計書 §I.2）。**Ctrl+Enter は保存だけして次へ進まない。**
   * `onSubmit` が渡っていないとき（テスト・組み込み前）は既定のまま素通しする。
   */
  const onFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || onSubmit === undefined) return;
    e.preventDefault();
    onSubmit(!e.ctrlKey);
  };
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
          onChange={(e) => onChange({ kindLabel: e.target.value })}
          onKeyDown={onFieldKeyDown}
        />
      </label>

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
        onChange={(next) =>
          onChange({
            autoColorEnabled: next.autoColorEnabled,
            paletteTheme: next.paletteTheme,
            fillColor: next.fillColor,
            fillOpacity: next.fillOpacity,
            selectedColor: next.selectedColor,
            selectedOpacity: next.selectedOpacity,
          })
        }
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
