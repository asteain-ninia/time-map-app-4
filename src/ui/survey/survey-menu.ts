// 右クリックメニューに出す「この線を消す」の項目（増分 8C の中身 3 / 設計書 §E.1 V15）。
//
// 押した点に当たった測量の線（`domain/survey/surveyLinesAt` が近い順に返した id）を、
// メニューの項目の並びに直す。**どれか 1 つに勝手に決めない** ―― 当たった線が 2 本以上
// あれば、測量ごとに 1 項目ずつ並べ、どの線かは距離で言い分ける（「1,234km の線を消す」）。
// 1 本だけなら言い分ける必要が無いので「この線を消す」と言う（V15 の手順の言葉）。
//
// 距離は **大円の距離**で言う。FR-15 が必ず描くと決めている線で、オプションバーの読み取りの
// 「大円」と同じ数（`measureSurveyPair` の 1 本 ―― 教訓 5.29）。
//
// **距離の文がほかの候補と同じになったときだけ、端点の緯度経度を添える**（増分 8C の手直し /
// GPT #1）。距離は整数の km に丸めるので、形の違う線（赤道上の東西 20° と、赤道を横切る南北
// 20° など）でも同じ文になり、どれを消すのか選べなかった。端点は小数 1 桁から始め、まだ同じなら
// 桁を増やす。端点まで同じ（同じ 2 点を 2 回測った）なら見た目も同じなので、測った順を添える。

import type { WorldCoordinate } from '../../domain/coordinate';
import type { GeoParams } from '../../domain/geo/geo-params';
import { COMPASS, DATE_LINE_DEG, representativeLon } from '../../domain/survey/coords-format';
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
  const kmLabels = found.map((line) =>
    formatMenuKm(measureSurveyPair(line.start, line.end, geoParams).greatCircleKm),
  );
  const items = found.map((line, i) => ({
    lineId: line.id,
    label: SURVEY_STRINGS.removeLineOfKm(kmLabels[i]!),
  }));
  // 文が同じになった候補の組ごとに、端点を添えて言い分ける。
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => {
    const group = groups.get(item.label);
    if (group === undefined) groups.set(item.label, [i]);
    else group.push(i);
  });
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ends = distinctEnds(members.map((i) => found[i]!));
    members.forEach((i, k) => {
      const line = found[i]!;
      const order = lines.indexOf(line) + 1;
      const text = ends.distinct ? ends.texts[k]! : SURVEY_STRINGS.endsWithOrder(ends.texts[k]!, order);
      items[i] = { lineId: line.id, label: SURVEY_STRINGS.removeLineOfKmWithEnds(kmLabels[i]!, text) };
    });
  }
  return items;
}

/** 端点の小数の桁。1 桁で言い分けられなければ増やす（最後は読み取りの十進と同じ 6 桁）。 */
const END_DIGITS = [1, 2, 4, 6] as const;

/**
 * 候補の線の端点の文。言い分けられる最小の桁で作る。6 桁でも同じなら `distinct: false`
 * （同じ 2 点を測った線 ―― 呼び出し側が測った順を添える）。
 */
function distinctEnds(lines: readonly SurveyLine[]): { texts: string[]; distinct: boolean } {
  let texts: string[] = [];
  for (const digits of END_DIGITS) {
    texts = lines.map(
      (line) => `${formatEnd(line.start, digits)} → ${formatEnd(line.end, digits)}`,
    );
    if (new Set(texts).size === texts.length) return { texts, distinct: true };
  }
  return { texts, distinct: false };
}

/** 端点 1 つ（「北緯 10.0° 東経 20.0°」）。語と経度の折りたたみは読み取りの十進と同じ規則。 */
function formatEnd(point: WorldCoordinate, digits: number): string {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return SURVEY_STRINGS.noValue;
  const latWord = point.lat < 0 ? COMPASS.south : COMPASS.north;
  const lat = `${latWord} ${Math.abs(point.lat).toFixed(digits)}°`;
  const norm = representativeLon(point.lon);
  const magnitude = Math.abs(norm).toFixed(digits);
  // 日付変更線ちょうどは東西の語を付けない（`coords-format.ts` の DATE_LINE_DEG の説明）。
  const lon =
    magnitude === DATE_LINE_DEG.toFixed(digits)
      ? `${magnitude}°`
      : `${norm < 0 ? COMPASS.west : COMPASS.east} ${magnitude}°`;
  return `${lat} ${lon}`;
}

/** メニューの項目に書く距離（整数の km、3 桁区切り。例「1,234km」）。 */
export function formatMenuKm(km: number): string {
  if (!Number.isFinite(km)) return SURVEY_STRINGS.noValue;
  return `${Math.round(km).toLocaleString('ja-JP')}${SURVEY_STRINGS.unitKm}`;
}
