import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { renderPage } from "./ui-layout.mjs";
import { PR_VIEW_SOURCE } from "./ui-pr-view-script.mjs";

// PR のトリアージはトップページ (2 ペイン) が担う。 ここは運用の俯瞰 —
// 登録リポジトリ・PR 作成・キュー — だけを持つ。テストワークフローは PR の
// 判断と同時に読めるようトップページの先頭へ移した。
const BODY = `
  <section>
    <h2>登録プロジェクト</h2>
    <p class="note">登録済みのローカルリポジトリです。追加は<a href="/settings">設定</a>から行います。</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>repository</th><th>version</th><th>root path</th><th>base</th><th>テストケース</th><th>Open PR</th></tr></thead>
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
        <div class="field"><label for="pr-title">title</label><input id="pr-title" required></div>
        <div class="field"><label for="pr-head">head branch</label><input id="pr-head" required placeholder="feat/local-change"></div>
        <div class="field"><label for="pr-author">author</label><input id="pr-author" required value="local"></div>
        <div class="field"><label for="pr-labels">labels (comma separated)</label><input id="pr-labels"></div>
        <div class="field"><label for="pr-body">body</label><textarea id="pr-body"></textarea></div>
        <button type="submit">PR を登録して審査開始</button>
        <p id="pr-message" role="status"></p>
      </form>
    </section>
    <section>
      <h2>キュー</h2><pre id="queue">確認中…</pre>
    </section>
  </div>
`;

const CONTROLLER_SOURCE = `
  const repositoryRows = document.querySelector('#repository-rows');
  const repositoryEmpty = document.querySelector('#repository-empty');
  const queue = document.querySelector('#queue');
  const prMessage = document.querySelector('#pr-message');

  function renderRepositories(repositories, pullRequests, releaseProjects) {
    repositoryEmpty.hidden = repositories.length > 0;
    repositoryRows.replaceChildren(...repositories.map((repository) => {
      const openCount = pullRequests.filter((pr) =>
        pr.status === 'open'
        && pr.repository.toLowerCase() === repository.repository.toLowerCase()).length;
      const row = document.createElement('tr');
      const releaseProject = releaseProjects.find((candidate) =>
        candidate.repository.toLowerCase() === repository.repository.toLowerCase());
      row.append(
        cell(repository.repository),
        cell(releaseProject?.version.version || '未登録',
          releaseProject?.version.status === 'ready' ? 'ok' : 'warn'),
        cell(repository.rootPath),
        cell(repository.baseRef),
        cell(repository.testCases.map((entry) => entry.name).join(', ')),
        cell(openCount),
      );
      return row;
    }));
    const select = document.querySelector('#pr-repository');
    const selected = select.value;
    select.replaceChildren(...repositories.map((repository) => {
      const option = document.createElement('option');
      option.value = repository.repository;
      option.textContent = repository.repository;
      return option;
    }));
    if (selected) select.value = selected;
  }

  async function refresh() {
    try {
      const [jobs, repositories, prs, releases] = await Promise.all([
        request('/api/jobs'),
        request('/api/repositories'),
        request('/api/local-prs'),
        request('/api/releases'),
      ]);
      queue.textContent = [
        'running: ' + jobs.running,
        'queued: ' + jobs.queued,
        '',
        ...jobs.jobs.slice(0, 20).map((job) =>
          job.status + '  ' + job.request.repository + '#' + job.request.number + '  ' + job.id),
      ].join('\\n');
      renderRepositories(repositories.repositories, prs.pullRequests, releases.projects);
    } catch (error) {
      queue.textContent = error.message;
    }
  }

  document.querySelector('#pr-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    prMessage.textContent = '登録中…';
    try {
      await request('/api/local-prs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: document.querySelector('#pr-repository').value,
          title: document.querySelector('#pr-title').value,
          body: document.querySelector('#pr-body').value,
          author: document.querySelector('#pr-author').value,
          labels: document.querySelector('#pr-labels').value
            .split(',').map((label) => label.trim()).filter(Boolean),
          head_ref: document.querySelector('#pr-head').value,
        }),
      });
      prMessage.textContent = 'PR を登録しました。';
      await refresh();
    } catch (error) {
      prMessage.textContent = error.message;
    }
  });

  refresh();
  setInterval(refresh, 3000);
`;

const SCRIPT = `${CLIENT_REQUEST_SOURCE}${PR_VIEW_SOURCE}${CONTROLLER_SOURCE}`;

export function renderDashboardPage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor — ダッシュボード",
    activeNav: "dashboard",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
