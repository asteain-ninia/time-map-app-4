// 右クリックメニューに出す「この線を消す」の項目（増分 8C の中身 3 / 設計書 §E.1 V15）。
//
// 押した点に当たった測量の線（`domain/survey/surveyLinesAt` が近い順に返した id）を、
// メニューの項目の並びに直す。**どれか 1 つに勝手に決めない** ―― 当たった線が 2 本以上
// あれば、測量ごとに 1 項目ずつ並べ、どの線かは距離で言い分ける（「1,234km の線を消す」）。
// 1 本だけなら言い分ける必要が無いので「この線を消す」と言う（V15 の手順の言葉）。
//
// 距離は **大円の距離**で言う。FR-15 が必ず描くと決めている線で、オプションバーの読み取りの
// 「大円」と同じ数（`measureSurveyPair` の 1 本 ―― 教訓 5.29）。

import type { GeoParams } from '../../domain/geo/geo-params';
import { measureSurveyPair } from '../../domain/survey/measure';
import type { SurveyLine } from '../../domain/survey/survey-state';

import { SURVEY_STRINGS } from './strings';

/** 右クリックメニューの 1 項目（測量 1 回ぶん。消えるのは 2 本セット）。 */
export interface SurveyLineMenuItem {
  /** 消す測量の id（正距円筒の線と大円の線で共通）。 */
  readonly lineId: number;
  /** 項目の文字。 */
  readonly label: string;
}

/**
 * 当たった線の id（近い順）から、メニューの項目を作る。いまの `lines` に無い id は
 * 飛ばす（凍結したあとで消えた線を項目にしない）。並びは受け取った順（近い順）のまま。
 */
export function surveyLineMenuItems(
  lines: readonly SurveyLine[],
  lineIds: readonly number[],
  geoParams: GeoParams,
): SurveyLineMenuItem[] {
  const found: SurveyLine[] = [];
  for (const id of lineIds) {
    const line = lines.find((l) => l.id === id);
    if (line !== undefined && !found.includes(line)) found.push(line);
  }
  if (found.length === 1) {
    return [{ lineId: found[0]!.id, label: SURVEY_STRINGS.removeThisLine }];
  }
  return found.map((line) => ({
    lineId: line.id,
    label: SURVEY_STRINGS.removeLineOfKm(
      formatMenuKm(measureSurveyPair(line.start, line.end, geoParams).greatCircleKm),
    ),
  }));
}

/** メニューの項目に書く距離（整数の km、3 桁区切り。例「1,234km」）。 */
export function formatMenuKm(km: number): string {
  if (!Number.isFinite(km)) return SURVEY_STRINGS.noValue;
  return `${Math.round(km).toLocaleString('ja-JP')}${SURVEY_STRINGS.unitKm}`;
}
