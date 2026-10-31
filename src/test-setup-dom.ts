// `*.test.tsx`（jsdom）だけに DOM の準備を読み込む。
//
// 本体は `src/test-support/dom-setup.ts`（jest-dom の照合・後始末・jsdom に無い API の差し替え）。
// `@testing-library/react` は react-dom ごと読むので 1 ファイルあたり 0.6 秒ほどかかり、DOM を
// 使わない node の 384 本に毎回読ませると全体の CPU 時間の 1/4 になっていた。node で読んでも
// 何もしない中身なので、ここで分ける（開発ガイド「テストの速さ」）。
if (typeof document !== 'undefined') {
  await import('./test-support/dom-setup');
}
