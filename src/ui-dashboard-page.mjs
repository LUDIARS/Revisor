import { startDashboard } from "./ui-dashboard-controller.mjs";
import { createPrViews } from "./ui-pr-view-script.mjs";
import { externalVerificationClears } from "./external-verification.mjs";
import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { renderPage } from "./ui-layout.mjs";
import { createVisibleRefreshLoop } from "./ui-visible-refresh-loop.mjs";

// PR のトリアージはトップページ (2 ペイン) が担う。 ここは運用の俯瞰 —
// 登録リポジトリ・PR 作成・キュー — だけを持つ。テストワークフローは PR の
// 判断と同時に読めるようトップページの先頭へ移した。
const BODY = `
  <section>
    <h2>登録プロジェクト</h2>
    <p class="note">登録済みのローカルリポジトリです。追加は<a href="/settings">設定</a>から行います。</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>repository</th><th>リファクタリング</th><th>version</th><th>root path</th><th>base</th><th>テストケース</th><th>Open PR</th></tr></thead>
        <tbody id="repository-rows"></tbody>
      </table>
    </div>
    <p id="repository-empty" class="empty">登録されたプロジェクトはありません。</p>
  </section>

  <div class="grid">
    <section>
      <h2>ローカル PR 作成</h2>
      <form id="pr-form">
        <div class="field"><label for="pr-repository">repository</label><select id="pr-repository" required></select></div>
        <div class="field"><label for="pr-title">PR タイトル</label><input id="pr-title" required></div>
        <div class="field"><label for="pr-head">head branch</label><input id="pr-head" required placeholder="feat/local-change"></div>
        <div class="field"><label for="pr-author">author</label><input id="pr-author" required value="local"></div>
        <div class="field"><label for="pr-labels">labels (comma separated)</label><input id="pr-labels"></div>
        <div class="field"><label class="check"><input id="pr-fast-lane" type="checkbox">ファストレーンを明示的に使う</label><span class="note">新しい実装をすぐ試したい場合だけ選択します。未選択の PR は通常キューへ入ります。</span></div>
        <div class="field"><label for="pr-body">PR内容</label><textarea id="pr-body" required placeholder="## 実装内容&#10;- 実装したことを具体的に記載する。&#10;&#10;## 受け入れ条件&#10;- 満たすべき条件を具体的に記載する。"></textarea></div>
        <button type="submit">PR を登録して審査開始</button>
        <p id="pr-message" role="status"></p>
      </form>
    </section>
    <section>
      <h2>キュー</h2><pre id="queue">確認中…</pre>
    </section>
  </div>
`;


const SCRIPT = `${CLIENT_REQUEST_SOURCE}\n${externalVerificationClears.toString()}\n${createPrViews.toString()}\n${createVisibleRefreshLoop.toString()}\n(${startDashboard.toString()})({ document, request, views: createPrViews(document, externalVerificationClears), createVisibleRefreshLoop });`;

export function renderDashboardPage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor — ダッシュボード",
    activeNav: "dashboard",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
