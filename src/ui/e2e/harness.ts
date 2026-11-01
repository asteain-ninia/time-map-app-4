// E2E 専用の操作口（テストハーネス）— renderer 側の登録簿。
//
// `window.__E2E__`（App.tsx の onMapMount が生やす **観測** フック: 選択中の地物・描画
// プリミティブ数など、読むだけの鏡）とは役割が違う。ここは **操作**（実データの読み込み
// など、状態を変える入口）の置き場で、`window.__E2E_HARNESS__` に生える。
//
// 別のグローバルにしている理由: `__E2E__` は地図の mount/unmount のたびに App.tsx が
// オブジェクトごと差し替え・削除する（App.tsx:711 / :1677）。他の部品がそこへ関数を足しても
// 次の差し替えで消えるので、同居できない。App.tsx は UI 再設計で作り直される予定なので、
// 作り直すときに観測フックもこの登録簿へ寄せてよい（申し送り）。
//
// 露出の門番: preload が E2E ブリッジ（`window.timeMapE2E`、src/shell/ipc/e2e-harness.ts）を
// 公開しているときだけ登録する。ブリッジは main が E2E_TEST=1 のときにしか旗を積まないので、
// 本番ビルドではこのモジュールを通っても window に何も生えない。
//
// 登録簿を部品ごとの直書きにしないのは、複数の部品が同じグローバルへ書くと互いに上書きし
// 合うから（`__E2E__` と同じ罠）。ここが唯一の書き手で、登録・解除は部品の mount/unmount に
// 揃える（教訓 5.2 一時的 UI 状態は全経路で破棄する）。

import { readE2eHarnessBridge } from '../../shell/ipc/e2e-harness';
import type { LeafReport, LeafReportQuery } from './leaf-report';
import type { ProjectStats } from './project-stats';

/** renderer 側のグローバル名（`window.__E2E_HARNESS__`）。 */
export const E2E_HARNESS_GLOBAL = '__E2E_HARNESS__';

/**
 * `loadProject` の結果。テストはこれを await して読み込みの完了を待つ。
 * - 'loaded'     ドメインが読み込んだプロジェクトに差し替わった（reflect まで到達）
 * - 'not-loaded' 拒否・修復中止・読み取り失敗などで現状維持のまま終わった
 * - 'busy'       別の file 操作（開く/新規/D&D/終了ガード）が進行中で、落とされた
 */
export type LoadProjectOutcome = 'loaded' | 'not-loaded' | 'busy';

/** ハーネスが提供する操作の一覧。足すときはここに型を足し、所有する部品が登録する。 */
export interface E2eHarnessActions {
  /**
   * 絶対パスの .gimoza を、メニューの「開く」と同じ流れ（未保存ガード → 読込 → 修復判定 →
   * reflect → 保存先の昇格）で読み込む。所有者: ui/file-ops/FileOpsController。
   */
  readonly loadProject: (projectPath: string) => Promise<LoadProjectOutcome>;
  /**
   * いま開いているプロジェクトの規模（錨列・錨・地物・表示名の重複・最大頂点数）を返す
   * **読むだけ**の観測。所有者: ui/App。受け入れ条件が実データの規模で書かれている
   * （775 行・重複名 12 件・2,230 頂点・錨 689 件）ので、画面から数えられないものを
   * ここで数える（T-2: 隠し観測は足す一方にする）。
   */
  readonly getProjectStats: () => ProjectStats;
  /**
   * `count` 件の合成地物を載せる（増分 4）。受け入れ条件の「**5,000 行の合成データで
   * 台帳の DOM ノードが 20 個以下**」を実アプリで測るための投入口で、`loadProject` と
   * 同じ「開いたときと同じ流れ」（reflect まで）を通る。所有者: ui/App。
   *
   * 5,000 件入りの `.gimoza` をリポジトリへ置く代わりに、その場で組む
   * （実データ 775 件で 2MB あるので、5,000 件は置きたくない）。
   */
  readonly loadSyntheticProject: (count: number) => void;
  /**
   * **1 地物が `count` 本の錨を持つ**合成データを載せる（増分 6）。設計書 §F.2 の
   * 受け入れ条件が「選択中の 1 地物が 5 万錨」で書かれているので、その規模を実アプリで
   * 作れないと測れない。`asAggregateChild` を立てると **集約地物の下位領域**の形（自分の履歴を
   * 持たず親の系列に入っている）になる ―― 系列を引く経路が違うので別に測る、という
   * 受け入れ条件のための形である。所有者: ui/App。
   */
  readonly loadSyntheticAnchors: (
    count: number,
    options?: {
      readonly asAggregateChild?: boolean;
      /** 先頭の何本を **同じ年の別の月**へ置くか（束の吹き出しの相手）。 */
      readonly withinOneYear?: number;
    },
  ) => void;
  /**
   * **集約地物 1 件の錨に `childCount` 件の子が居候する**合成データを載せる
   * （増分 7 の手直し A / 司令塔の決定 (1)(2)）。実データの「デーレ共和国 60 州」と
   * 同じ形で、記録の置き場（親の錨から子の系列へ写す）が効いているかを画面から
   * 数えるための投入口である。錨は `years` のぶんだけ並ぶ。所有者: ui/App。
   */
  readonly loadSyntheticNested: (childCount: number, years?: readonly number[]) => void;
  /**
   * **集約地物を［動かす］で引く検査の合成データ**を載せる（隣どうしが頂点を共有する。
   * `buildSyntheticAggregateMoveProject`）。所有者: ui/App。
   */
  readonly loadSyntheticAggregateMove: () => void;
  /**
   * **いま見ている年**の末端地物を、id か名前で選んで中身を返す **読むだけ** の観測
   * （増分 8B の手直し / GPT 審査の重 2）。id・名前・種別・色・錨列の開始年・面積、片どうしの
   * 重なりの面積、指定した点の持ち主を返す。分割の E2E が「片が欠けていない」「元の地物の
   * id・素性・年表が残った」「片が重ならない」「引いていない腕が切られていない」を表示と
   * 独立に確かめるために使う。所有者: ui/App。
   */
  readonly getLeafReport: (query: LeafReportQuery) => LeafReport;
}

type HarnessHost = Partial<Record<typeof E2E_HARNESS_GLOBAL, Partial<E2eHarnessActions>>>;

/** preload の E2E ブリッジがある（= E2E_TEST=1 で起動した）か。 */
export function isE2eHarnessEnabled(host: object): boolean {
  return readE2eHarnessBridge(host) !== null;
}

/**
 * 操作を 1 つ登録し、解除関数を返す。ブリッジが無ければ何もしない（解除も no-op）。
 * 解除は「自分が登録した関数がまだ載っているとき」だけ外す — 別の登録に置き換わっていれば
 * 触らない。最後の操作が外れたらグローバルごと消す（本番と同じ「何も無い」状態へ戻す）。
 */
export function registerE2eHarnessAction<K extends keyof E2eHarnessActions>(
  host: object,
  name: K,
  action: E2eHarnessActions[K],
): () => void {
  if (!isE2eHarnessEnabled(host)) return () => undefined;
  const h = host as HarnessHost;
  h[E2E_HARNESS_GLOBAL] = { ...(h[E2E_HARNESS_GLOBAL] ?? {}), [name]: action };
  return () => {
    const live = h[E2E_HARNESS_GLOBAL];
    if (live === undefined || live[name] !== action) return;
    const rest: Partial<E2eHarnessActions> = { ...live };
    delete rest[name];
    if (Object.keys(rest).length === 0) {
      delete h[E2E_HARNESS_GLOBAL];
    } else {
      h[E2E_HARNESS_GLOBAL] = rest;
    }
  };
}
