// E2E 専用の **観測** 口のうち、時刻レールが持つぶんの登録簿（増分 6 の中身 8）。
//
// **なぜ登録簿を挟むのか**: `window.__E2E__` を生やすのは地図のマウント
// （`ui/map/mount/observation.ts`）1 か所だけで、そこは地図の mount/unmount のたびに
// **オブジェクトごと差し替え・削除する**。レーンが自分で `window.__E2E__.getAnchorLaneStats`
// を足すと、次の差し替えで黙って消える（`ui/e2e/harness.ts` の見出しが「同じ罠」として
// 名指ししている形そのもの）。そこで **書き手は 1 つのまま**にして、レールはこの登録簿へ
// 置き、観測フックはここから読む。
//
// 本番ビルドでも読み込まれるが、ここに置くのは関数の入れ物だけで、`window` には何も
// 生やさない（生やすかどうかは観測フック側が E2E ブリッジの有無で決める）。

/** 錨レーンの規模と費用（受け入れ条件 §F.2 をそのまま測れる形）。 */
export interface AnchorLaneStats {
  /** レーンが描いている地物の id（選択が無ければ空文字）。 */
  readonly featureId: string;
  /** 集約地物の下位領域か（親の系列から選り分けたレーンか）。 */
  readonly inherited: boolean;
  /** レーンの母数（集約地物の下位領域なら選り分けたあとの本数）。 */
  readonly anchorCount: number;
  /** いま表示範囲に入っている錨の本数。 */
  readonly inView: number;
  /** 軸の画素数（＝ 1 パス集計の配列の長さ）。 */
  readonly width: number;
  /** 件数 1 の列の数（菱形の印）。 */
  readonly markCount: number;
  /** 件数 2 以上の列の数（密度帯）。 */
  readonly denseCount: number;
  /** 描く図形の数。**軸の画素数を超えない**（受け入れ条件）。 */
  readonly shapeCount: number;
  /** いちばん混んでいる列の件数。 */
  readonly maxCount: number;
  /** 直近の再集計にかかった時間（ms）。受け入れ条件は 16ms 以内。 */
  readonly lastAggregateMs: number;
  /** 再集計した回数。**再生中に増えないこと**（規則 4）を数える。 */
  readonly aggregateCount: number;
  /** 素材（系列を引いて正規化する側）を組み直した回数。選択が変わったときだけ増える。 */
  readonly sourceCount: number;
  /** 直近の素材づくりにかかった時間（ms）。 */
  readonly lastSourceMs: number;
  /** 直近の当たり判定にかかった時間（ms）。受け入れ条件は 1ms 以内。 */
  readonly lastHitTestMs: number;
  /** レーンの高さ（px）。窓が低いと 20px に縮む。 */
  readonly laneHeightPx: number;
}

/** レールの表示範囲（ズーム・スクロールの結果）。 */
export interface RailViewSnapshot {
  /** 表示範囲の左端の年。 */
  readonly minYear: number;
  /** 表示範囲の右端の年。 */
  readonly maxYear: number;
  /** 表示範囲の幅（日）。 */
  readonly spanDays: number;
  /** 軸の画素数。 */
  readonly pixelLength: number;
  /** いまの畳みの段（`rail-fold.ts` の識別子）。 */
  readonly fold: string;
  /** 現在時刻の年。 */
  readonly currentYear: number;
  /** 編集時刻バッジの文（「1200年 ｜ 錨を新しく作ります」）。 */
  readonly editTime: string;
}

/** レールが提供する観測。 */
export interface RailObservation {
  readonly getAnchorLaneStats: () => AnchorLaneStats;
  readonly getAnchorMarkPositions: () => readonly number[];
  readonly getRailView: () => RailViewSnapshot;
}

let published: RailObservation | null = null;

/** レールが自分の観測を登録する（アンマウントで null を渡して外す）。 */
export function publishRailObservation(observation: RailObservation | null): void {
  published = observation;
}

/** 観測フックが読む。まだレールが載っていなければ null。 */
export function readRailObservation(): RailObservation | null {
  return published;
}

/** レールが載っていないときに返す既定値（口そのものは常に生やす）。 */
export const ABSENT_LANE_STATS: AnchorLaneStats = {
  featureId: '',
  inherited: false,
  anchorCount: 0,
  inView: 0,
  width: 0,
  markCount: 0,
  denseCount: 0,
  shapeCount: 0,
  maxCount: 0,
  lastAggregateMs: 0,
  aggregateCount: 0,
  sourceCount: 0,
  lastSourceMs: 0,
  lastHitTestMs: 0,
  laneHeightPx: 0,
};

/** 同じく、レールが載っていないときの表示範囲。 */
export const ABSENT_RAIL_VIEW: RailViewSnapshot = {
  minYear: 0,
  maxYear: 0,
  spanDays: 0,
  pixelLength: 0,
  fold: '',
  currentYear: 0,
  editTime: '',
};
