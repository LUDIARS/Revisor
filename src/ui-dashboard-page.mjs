import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { renderPage } from "./ui-layout.mjs";

const BODY = `
  <section>
    <h2>Open PR</h2>
    <p class="note">ローカル審査中および審査済みの Open な PR です。行を選ぶと下に詳細が出ます。</p>
    <table>
      <thead><tr><th>PR</th><th>ブランチ</th><th>状態</th><th>テスト</th><th>差分解析</th><th>更新</th></tr></thead>
      <tbody id="pr-rows"></tbody>
    </table>
    <p id="pr-empty" class="empty">Open な PR はありません。</p>

    <h3>選択した PR の詳細</h3>
    <div id="pr-detail"><p class="empty">PR を選択してください。</p></div>
    <p id="pr-action-message" role="status"></p>
  </section>

  <section>
    <h2>登録プロジェクト</h2>
    <p class="note">登録済みのローカルリポジトリです。追加は<a href="/settings">設定</a>から行います。</p>
    <table>
      <thead><tr><th>repository</th><th>root path</th><th>base</th><th>テストケース</th><th>push guard</th><th>Open PR</th></tr></thead>
      <tbody id="repository-rows"></tbody>
    </table>
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
        <div class="field"><label class="check"><input id="pr-draft" type="checkbox">draft</label></div>
        <div class="field"><label for="pr-body">body</label><textarea id="pr-body"></textarea></div>
        <button type="submit">PR を登録して審査開始</button>
        <p id="pr-message" role="status"></p>
      </form>
    </section>
    <section>
      <h2>テストワークフロー</h2>
      <p class="note">このローカル審査を通過した Open / Test OK のプロダクトだけを表示します。</p>
      <ul id="test-products"></ul>
      <h3>キュー</h3><pre id="queue">確認中…</pre>
    </section>
  </div>
`;

const SCRIPT = `${CLIENT_REQUEST_SOURCE}
  const prRows = document.querySelector('#pr-rows');
  const prEmpty = document.querySelector('#pr-empty');
  const prDetail = document.querySelector('#pr-detail');
  const prActionMessage = document.querySelector('#pr-action-message');
  const repositoryRows = document.querySelector('#repository-rows');
  const repositoryEmpty = document.querySelector('#repository-empty');
  const queue = document.querySelector('#queue');
  const prMessage = document.querySelector('#pr-message');
  let selectedPrId = null;

  function text(value) {
    return String(value ?? '');
  }

  function statusClass(pr) {
    if (pr.checkStatus === 'test_ok') return 'ok';
    if (pr.checkStatus === 'failed' || pr.checkStatus === 'action_required') return 'bad';
    if (pr.checkStatus === 'running' || pr.checkStatus === 'queued') return 'warn';
    return 'idle';
  }

  function testSummary(pr) {
    if (!Array.isArray(pr.ci) || pr.ci.length === 0) return '—';
    const passed = pr.ci.filter((entry) => entry.status === 'passed').length;
    return passed + '/' + pr.ci.length + ' passed';
  }

  function analysisSummary(pr) {
    if (!pr.anatomia) return '—';
    return 'score Δ ' + text(pr.anatomia.complexityScoreDelta)
      + ' / orphans ' + ((pr.anatomia.quality && pr.anatomia.quality.changedOrphans || []).length)
      + ' / violations ' + ((pr.anatomia.architecture && pr.anatomia.architecture.changedViolations || []).length);
  }

  function cell(value, className) {
    const node = document.createElement('td');
    node.textContent = text(value);
    if (className) node.className = className;
    return node;
  }

  function definition(list, term, value) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = text(value);
    list.append(dt, dd);
  }

  function block(title, node) {
    const heading = document.createElement('h3');
    heading.textContent = title;
    const fragment = document.createDocumentFragment();
    fragment.append(heading, node);
    return fragment;
  }

  function paragraph(message) {
    const node = document.createElement('p');
    node.className = 'empty';
    node.textContent = message;
    return node;
  }

  function listOf(values, emptyMessage) {
    if (!values || values.length === 0) return paragraph(emptyMessage);
    const list = document.createElement('ul');
    for (const value of values) {
      const item = document.createElement('li');
      item.textContent = text(value);
      list.append(item);
    }
    return list;
  }

  function overviewOf(pr) {
    const list = document.createElement('dl');
    list.className = 'meta';
    definition(list, 'PR', pr.repository + ' #' + pr.number);
    definition(list, 'title', pr.title);
    definition(list, '状態', (pr.draft ? 'draft / ' : '') + pr.status + ' / ' + pr.checkStatus);
    definition(list, 'author', pr.author);
    definition(list, 'branch', pr.headRef + ' → ' + pr.baseRef);
    definition(list, 'head SHA', pr.headSha);
    definition(list, 'reviewed head SHA', pr.reviewedHeadSha || '—');
    definition(list, 'base SHA', pr.baseSha);
    definition(list, 'labels', pr.labels.join(', ') || '—');
    definition(list, '更新', pr.updatedAt);
    if (pr.body) definition(list, 'body', pr.body);
    return list;
  }

  function testsOf(pr) {
    if (!Array.isArray(pr.ci) || pr.ci.length === 0) {
      return paragraph('テスト結果はまだありません。');
    }
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['テストケース', '結果', 'exit code', '所要']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const entry of pr.ci) {
      const row = document.createElement('tr');
      row.append(
        cell(entry.name),
        cell(entry.status, entry.status === 'passed' ? 'ok' : 'bad'),
        cell(entry.exitCode),
        cell(Math.round((entry.durationMs || 0) / 1000) + ' s'),
      );
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function reviewOf(pr) {
    const wrapper = document.createElement('div');
    const list = document.createElement('dl');
    list.className = 'meta';
    definition(list, 'レビュアー', pr.reviewer || '未実施');
    definition(list, '流出スキャン', pr.leakage
      ? (pr.leakage.totalFindings + ' 件 / 追加 ' + pr.leakage.scannedAddedLines + ' 行を検査')
      : '未実施');
    if (pr.error) definition(list, 'エラー', pr.error);
    if (pr.humanQuestion) definition(list, '人間への確認', pr.humanQuestion);
    wrapper.append(list);
    wrapper.append(block('ブロック理由', listOf(pr.reasons, 'ブロック理由はありません。')));
    wrapper.append(block('所見 (マージは止めない)', listOf(pr.advisories, '所見はありません。')));
    const findings = (pr.leakage && pr.leakage.findings || [])
      .map((finding) => finding.rule + '  ' + finding.path + ':' + finding.line);
    wrapper.append(block('流出候補', listOf(findings, '流出候補はありません。')));
    return wrapper;
  }

  function analysisOf(pr) {
    if (!pr.anatomia) return paragraph('差分解析はまだありません。');
    const wrapper = document.createElement('div');
    const list = document.createElement('dl');
    list.className = 'meta';
    definition(list, '解析元', pr.anatomia.source);
    definition(list, 'complexity score', pr.anatomia.baselineComplexityScore
      + ' → ' + (pr.anatomia.baselineComplexityScore + pr.anatomia.complexityScoreDelta)
      + ' (Δ ' + pr.anatomia.complexityScoreDelta + ')');
    definition(list, '対象ドメイン', (pr.anatomia.domain && pr.anatomia.domain.hasTargetDomain)
      ? (pr.anatomia.domain.targetDomains || [])
          .map((entry) => (entry && entry.name) || entry).join(', ') || 'あり'
      : 'なし');
    wrapper.append(list);
    const quality = pr.anatomia.quality || {};
    const architecture = pr.anatomia.architecture || {};
    wrapper.append(block(
      '孤立した変更関数',
      listOf((quality.changedOrphans || []).map((entry) =>
        entry.file ? entry.name + '  ' + entry.file + ':' + entry.line : text(entry.name)),
        '孤立した変更関数はありません。'),
    ));
    wrapper.append(block(
      'アーキテクチャ違反',
      listOf((architecture.changedViolations || [])
        .map((entry) => '[' + entry.severity + '] ' + (entry.message || entry.rule)),
        'アーキテクチャ違反はありません。'),
    ));
    const raw = document.createElement('pre');
    raw.textContent = JSON.stringify(pr.anatomia, null, 2);
    wrapper.append(block('生データ', raw));
    return wrapper;
  }

  function actionsOf(pr) {
    const wrapper = document.createElement('div');
    if (pr.status === 'open' && pr.checkStatus === 'test_ok' && !pr.draft) {
      const merge = document.createElement('button');
      merge.textContent = 'squash merge';
      merge.addEventListener('click', () => runAction(merge, pr.id, 'merge'));
      wrapper.append(merge);
    }
    if (pr.status === 'open' && pr.checkStatus !== 'running' && pr.checkStatus !== 'queued') {
      const retry = document.createElement('button');
      retry.className = 'secondary';
      retry.textContent = '審査を再実行';
      retry.addEventListener('click', () => runAction(retry, pr.id, 'retry'));
      wrapper.append(retry);
    }
    return wrapper;
  }

  async function runAction(button, id, action) {
    button.disabled = true;
    prActionMessage.textContent = '';
    try {
      await request('/api/local-prs/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      await refresh();
    } catch (error) {
      prActionMessage.textContent = error.message;
      button.disabled = false;
    }
  }

  function renderDetail(pr) {
    if (!pr) {
      prDetail.replaceChildren(paragraph('PR を選択してください。'));
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(overviewOf(pr));
    fragment.append(block('テスト', testsOf(pr)));
    fragment.append(block('レビュー', reviewOf(pr)));
    fragment.append(block('差分解析 (Anatomia)', analysisOf(pr)));
    fragment.append(block('操作', actionsOf(pr)));
    prDetail.replaceChildren(fragment);
  }

  function renderPullRequests(pullRequests) {
    const open = pullRequests.filter((pr) => pr.status === 'open');
    prEmpty.hidden = open.length > 0;
    if (selectedPrId && !open.some((pr) => pr.id === selectedPrId)) selectedPrId = null;
    prRows.replaceChildren(...open.map((pr) => {
      const row = document.createElement('tr');
      row.className = pr.id === selectedPrId ? 'selectable selected' : 'selectable';
      row.append(
        cell(pr.repository + ' #' + pr.number + ' ' + pr.title),
        cell(pr.headRef + ' → ' + pr.baseRef),
        cell((pr.draft ? 'draft / ' : '') + pr.checkStatus, statusClass(pr)),
        cell(testSummary(pr)),
        cell(analysisSummary(pr)),
        cell(pr.updatedAt),
      );
      row.addEventListener('click', () => {
        selectedPrId = pr.id;
        prActionMessage.textContent = '';
        renderPullRequests(pullRequests);
      });
      return row;
    }));
    renderDetail(open.find((pr) => pr.id === selectedPrId) ?? null);
  }

  function renderRepositories(repositories, pullRequests) {
    repositoryEmpty.hidden = repositories.length > 0;
    repositoryRows.replaceChildren(...repositories.map((repository) => {
      const openCount = pullRequests.filter((pr) =>
        pr.status === 'open'
        && pr.repository.toLowerCase() === repository.repository.toLowerCase()).length;
      const row = document.createElement('tr');
      row.append(
        cell(repository.repository),
        cell(repository.rootPath),
        cell(repository.baseRef),
        cell(repository.testCases.map((entry) => entry.name).join(', ')),
        cell(repository.pushGuard ? repository.pushGuard.status : '未実行',
          repository.pushGuard && repository.pushGuard.status !== 'safe' ? 'warn' : 'idle'),
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
      const [jobs, repositories, prs, workflow] = await Promise.all([
        request('/api/jobs'),
        request('/api/repositories'),
        request('/api/local-prs'),
        request('/api/test-workflow'),
      ]);
      queue.textContent = [
        'running: ' + jobs.running,
        'queued: ' + jobs.queued,
        '',
        ...jobs.jobs.slice(0, 20).map((job) =>
          job.status + '  ' + job.request.repository + '#' + job.request.number + '  ' + job.id),
      ].join('\\n');
      renderPullRequests(prs.pullRequests);
      renderRepositories(repositories.repositories, prs.pullRequests);
      const products = document.querySelector('#test-products');
      products.replaceChildren(...workflow.products.map((product) => {
        const item = document.createElement('li');
        item.className = 'ok';
        item.textContent = product.repository + ' #' + product.number + ' — ' + product.status;
        return item;
      }));
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
          draft: document.querySelector('#pr-draft').checked,
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

export function renderDashboardPage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor",
    activeNav: "dashboard",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
