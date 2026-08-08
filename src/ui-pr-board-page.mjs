import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { PR_DIFF_VIEW_SOURCE } from "./ui-pr-diff-view-script.mjs";
import { renderPage } from "./ui-layout.mjs";
import { PR_EVENTS_SOURCE } from "./ui-pr-events.mjs";
import { PR_VIEW_SOURCE } from "./ui-pr-view-script.mjs";

// トップページは PR のトリアージ専用。 PC 幅では左にリスト・右に選択した PR の
// 詳細の 2 ペインで、 リストを選び替えながら詳細を読み比べられる。 狭い画面では
// ペインが縦に積まれ、 従来どおりカード → 詳細の順で読める。 運用系のパネル
// (登録リポジトリ・PR 作成・キュー) はダッシュボードページへ分離した。
const BODY = `
  <section class="test-workflow-summary">
    <h2>テストワークフロー</h2>
    <p class="note">審査中は先行QA、審査通過後は確定QAとして、人間が同じ変更を早期に確認できます。</p>
    <ul id="test-products"></ul>
    <p id="test-products-empty" class="empty">確認できる PR はありません。</p>
  </section>
  <section class="review-work-summary">
    <h2>レビュー worker queue</h2>
    <p id="review-work-capacity" class="note">worker 状態を取得中…</p>
    <div id="review-work-queues"></div>
  </section>
  <div class="pr-board">
    <section class="pr-list-pane">
      <h2>PR の判断待ち</h2>
      <p class="note">マージ可能な PR を先頭にし、それぞれ新しい順で並べます。</p>
      <div class="filter-bar">
        <label class="check"><input id="filter-human" type="checkbox">判断が必要なものだけ表示</label>
        <div class="field filter-projects">
          <label for="filter-projects">プロジェクト（複数選択可・未選択はすべて）</label>
          <select id="filter-projects" multiple></select>
        </div>
        <span id="pr-counts" class="note"></span>
      </div>
      <div class="cards" id="pr-cards"></div>
      <p id="pr-empty" class="empty">Open な PR はありません。</p>
    </section>
    <section class="pr-detail-pane">
      <h2>選択した PR の詳細</h2>
      <div id="pr-detail"><p class="empty">PR を選択してください。</p></div>
      <p id="pr-action-message" role="status"></p>
      <div class="pr-event-log">
        <div class="pr-event-log-head">
          <h3>PR 更新ログ</h3>
          <span id="pr-event-status" class="note">接続準備中…</span>
        </div>
        <ol id="pr-event-entries"></ol>
      </div>
    </section>
  </div>
  <div id="pr-log-overlay" class="log-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="pr-log-title">
    <div class="log-overlay-panel">
      <div class="log-overlay-head">
        <h2 id="pr-log-title">PR ログ</h2>
        <button id="pr-log-close" class="secondary" type="button">閉じる</button>
      </div>
      <pre id="pr-log-content"></pre>
    </div>
  </div>
  <div id="pr-diff-overlay" class="diff-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="pr-diff-title">
    <div class="diff-overlay-panel">
      <div class="log-overlay-head">
        <h2 id="pr-diff-title">変更ファイル</h2>
        <button id="pr-diff-close" class="secondary" type="button">閉じる</button>
      </div>
      <div class="diff-viewer">
        <aside class="diff-files-pane">
          <p id="pr-diff-status" class="note">変更ファイルを取得中…</p>
          <div id="pr-diff-files"></div>
        </aside>
        <section class="diff-content-pane">
          <p id="pr-diff-file-name" class="note">ファイルを選択してください。</p>
          <div id="pr-diff-content"></div>
        </section>
      </div>
    </div>
  </div>
`;

// 一覧に何を出すかの規則は DOM に触らない純関数として切り出す。 コントローラは
// これを DOM へ結ぶだけになり、 フィルタの意味 (未選択は全件・複数選択は和集合・
// 件数もフィルタ後の集合) を生成ソースの正規表現ではなく振る舞いで検証できる。
export const PR_FILTER_SOURCE = `
  function projectsOf(pullRequests) {
    return [...new Set(pullRequests.map((pr) => pr.repository))]
      .sort((left, right) => left.localeCompare(right));
  }

  function keepKnownProjects(selectedProjects, projects) {
    return new Set([...selectedProjects].filter((project) => projects.includes(project)));
  }

  function sameProjectOptions(options, projects) {
    return projects.length === options.length
      && projects.every((project, index) => options[index].value === project);
  }

  function boardView(pullRequests, selectedProjects, humanOnly) {
    const projectFiltered = selectedProjects.size === 0
      ? pullRequests
      : pullRequests.filter((pr) => selectedProjects.has(pr.repository));
    const needsHuman = projectFiltered.filter((pr) => pr.decision.state === 'needs_human');
    return { projectFiltered, needsHuman, visible: humanOnly ? needsHuman : projectFiltered };
  }
`;

const CONTROLLER_SOURCE = `
  const prCards = document.querySelector('#pr-cards');
  const prCounts = document.querySelector('#pr-counts');
  const prEmpty = document.querySelector('#pr-empty');
  const prDetail = document.querySelector('#pr-detail');
  const prActionMessage = document.querySelector('#pr-action-message');
  const filterHuman = document.querySelector('#filter-human');
  const filterProjects = document.querySelector('#filter-projects');
  const testProducts = document.querySelector('#test-products');
  const testProductsEmpty = document.querySelector('#test-products-empty');
  const reviewWorkCapacity = document.querySelector('#review-work-capacity');
  const reviewWorkQueues = document.querySelector('#review-work-queues');
  const prLogOverlay = document.querySelector('#pr-log-overlay');
  const prLogTitle = document.querySelector('#pr-log-title');
  const prLogContent = document.querySelector('#pr-log-content');
  const prLogClose = document.querySelector('#pr-log-close');
  const prDiffOverlay = document.querySelector('#pr-diff-overlay');
  const prDiffTitle = document.querySelector('#pr-diff-title');
  const prDiffStatus = document.querySelector('#pr-diff-status');
  const prDiffFiles = document.querySelector('#pr-diff-files');
  const prDiffFileName = document.querySelector('#pr-diff-file-name');
  const prDiffContent = document.querySelector('#pr-diff-content');
  const prDiffClose = document.querySelector('#pr-diff-close');
  let selectedPrId = null;
  let openPullRequests = [];
  let selectedProjects = new Set();
  let diffRequestVersion = 0;

  function fullLogText(pr) {
    const sections = [];
    const events = (pr.lifecycleEvents || []).slice(-50);
    sections.push(events.length === 0
      ? 'Lifecycle\\nイベントはありません。'
      : 'Lifecycle\\n' + events.map((entry) =>
        '[' + entry.at + '] ' + entry.message).join('\\n\\n'));
    const tests = (pr.ci || []).filter((entry) => entry.output && entry.output.text);
    sections.push(tests.length === 0
      ? 'Test output\\n保存されたテスト出力はありません。'
      : 'Test output\\n' + tests.map((entry) =>
        '--- ' + entry.name + ' [' + entry.status + '] ---\\n' + entry.output.text).join('\\n\\n'));
    if (pr.error) sections.push('Review error\\n' + pr.error);
    if (pr.mergeError) sections.push('Merge error\\n' + pr.mergeError);
    return sections.join('\\n\\n');
  }

  function openLogOverlay(pr) {
    prLogTitle.textContent = pr.repository + ' #' + pr.number + ' — ログ';
    prLogContent.textContent = fullLogText(pr);
    prLogOverlay.hidden = false;
    document.body.classList.add('overlay-open');
    prLogClose.focus();
  }

  function closeLogOverlay() {
    prLogOverlay.hidden = true;
    document.body.classList.remove('overlay-open');
  }

  function closeDiffOverlay() {
    diffRequestVersion += 1;
    prDiffOverlay.hidden = true;
    document.body.classList.remove('overlay-open');
  }

  async function loadDiffFile(pr, files, file, version) {
    if (version !== diffRequestVersion) return;
    renderDiffFileList(prDiffFiles, files, file.path,
      (next) => { void loadDiffFile(pr, files, next, diffRequestVersion); });
    prDiffFileName.textContent = file.path;
    prDiffContent.replaceChildren(paragraph('diff を取得中…'));
    try {
      const result = await request('/api/local-prs/' + encodeURIComponent(pr.id)
        + '/diff?path=' + encodeURIComponent(file.path));
      if (version !== diffRequestVersion) return;
      prDiffContent.replaceChildren(unifiedDiffView(result.diff || '差分はありません。'));
    } catch (error) {
      if (version !== diffRequestVersion) return;
      prDiffContent.replaceChildren(paragraph(error.message));
    }
  }

  async function openChangedFiles(pr) {
    const version = ++diffRequestVersion;
    prDiffTitle.textContent = pr.repository + ' #' + pr.number + ' — 変更ファイル';
    prDiffStatus.textContent = '変更ファイルを取得中…';
    prDiffFiles.replaceChildren();
    prDiffFileName.textContent = 'ファイルを選択してください。';
    prDiffContent.replaceChildren();
    prDiffOverlay.hidden = false;
    document.body.classList.add('overlay-open');
    prDiffClose.focus();
    try {
      const result = await request('/api/local-prs/' + encodeURIComponent(pr.id) + '/files');
      if (version !== diffRequestVersion) return;
      const files = result.files || [];
      prDiffStatus.textContent = files.length + ' ファイル変更 — '
        + result.baseSha.slice(0, 12) + ' … ' + result.headSha.slice(0, 12);
      if (files.length === 0) {
        prDiffContent.replaceChildren(paragraph('変更ファイルはありません。'));
        return;
      }
      await loadDiffFile(pr, files, files[0], version);
    } catch (error) {
      if (version !== diffRequestVersion) return;
      prDiffStatus.textContent = error.message;
    }
  }

  function actionsOf(pr) {
    const wrapper = element('div', 'actions');
    const humanOverride = pr.decision?.humanOverrideMergeable === true
      || pr.decision?.humanDecisionMergeable === true;
    if (pr.status === 'open' && (pr.checkStatus === 'test_ok' || humanOverride)) {
      const merge = document.createElement('button');
      merge.textContent = humanOverride
        ? '人間判断で squash merge'
        : 'squash merge';
      merge.addEventListener('click', () => runAction(merge, pr.id, 'merge'));
      wrapper.append(merge);
    }
    if (pr.status === 'open' && pr.checkStatus !== 'running' && pr.checkStatus !== 'queued') {
      const retry = document.createElement('button');
      retry.className = 'secondary';
      retry.textContent = '審査を再実行';
      retry.addEventListener('click', () => runAction(retry, pr.id, 'retry'));
      wrapper.append(retry);
      const close = document.createElement('button');
      close.className = 'secondary';
      close.textContent = '取り下げ';
      close.title = 'マージせずに終わらせる (別経路で main へ入った / 案を破棄した)';
      close.addEventListener('click', () => runAction(close, pr.id, 'close'));
      wrapper.append(close);
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
    fragment.append(block('判断', decisionOf(pr)));
    fragment.append(block('レビュー計画', planOf(pr.reviewPlan)));
    fragment.append(block('テスト', testsOf(pr)));
    fragment.append(block('変更内容', changedFilesOf(pr, openChangedFiles)));
    fragment.append(block('Test Workflow ログ', workflowLogOf(pr, openLogOverlay)));
    fragment.append(block('レビュー', reviewOf(pr)));
    fragment.append(block('差分解析 (Anatomia)', analysisOf(pr)));
    fragment.append(block('操作', actionsOf(pr)));
    prDetail.replaceChildren(fragment);
  }

  function selectPullRequest(id) {
    selectedPrId = id;
    prActionMessage.textContent = '';
    renderBoard();
    renderPrEventLog();
  }

  function renderTestWorkflow(products) {
    testProductsEmpty.hidden = products.length > 0;
    testProducts.replaceChildren(...products.map((product) => {
      const item = element('li', product.checkStatus === 'test_ok' ? 'ok' : 'warn');
      item.textContent = product.repository + ' #' + product.number + ' — ' + product.status;
      item.addEventListener('click', () => selectPullRequest(product.pullRequestId));
      return item;
    }));
  }

  function workItem(entry) {
    const item = element('li', entry.status === 'running' ? 'running' : 'queued');
    const request = entry.request || entry;
    const label = request.repository && request.number !== null
      ? request.repository + ' #' + request.number
      : 'PR を割り当て中';
    item.append(
      element('strong', null, label),
      element('span', null, entry.status === 'running'
        ? '実行中' + (entry.workerId ? ' (' + entry.workerId + ')' : '')
        : '待機中'),
    );
    return item;
  }

  function renderReviewWork(state) {
    const queues = state.workers?.queues || [];
    const totalWorkers = queues.reduce((sum, queue) => sum + (queue.workers?.configured || 0), 0);
    const idleWorkers = queues.reduce((sum, queue) => sum + (queue.workers?.idle || 0), 0);
    reviewWorkCapacity.textContent = '専用 worker ' + totalWorkers + ' / 空き ' + idleWorkers
      + ' — 実行中の工程と待機列を表示します。';
    const outer = (state.reviewQueue?.jobs || [])
      .filter((job) => job.status === 'queued' || job.status === 'running');
    const cards = queues.map((queue) => {
      const card = element('section', 'review-work-queue');
      const workers = queue.workers || {};
      card.append(element(
        'h3',
        null,
        queue.label + ' — 実行 ' + (workers.running || 0) + ' / 空き ' + (workers.idle || 0),
      ));
      const work = [...(queue.running || []), ...(queue.queued || [])];
      if (work.length === 0) card.append(paragraph('待機中の工程はありません。'));
      else card.append(Object.assign(document.createElement('ul'), {
        className: 'review-work-items',
      }));
      const list = card.querySelector('.review-work-items');
      if (list) list.append(...work.map(workItem));
      return card;
    });
    if (outer.length > 0) {
      const pending = element('section', 'review-work-queue');
      pending.append(element('h3', null, 'レビュー orchestration'));
      const list = element('ul', 'review-work-items');
      list.append(...outer.map(workItem));
      pending.append(list);
      cards.unshift(pending);
    }
    reviewWorkQueues.replaceChildren(...cards);
  }

  function renderProjectFilter() {
    const projects = projectsOf(openPullRequests);
    selectedProjects = keepKnownProjects(selectedProjects, projects);
    // Polling must not replace the native multiple-select while the operator is
    // choosing projects. Rebuild only when the available project set changed.
    if (sameProjectOptions(filterProjects.options, projects)) return;
    filterProjects.replaceChildren(...projects.map((project) => {
      const option = document.createElement('option');
      option.value = project;
      option.textContent = project;
      option.selected = selectedProjects.has(project);
      return option;
    }));
  }

  function renderBoard() {
    renderProjectFilter();
    const { projectFiltered, needsHuman, visible } =
      boardView(openPullRequests, selectedProjects, filterHuman.checked);
    if (selectedPrId && !visible.some((pr) => pr.id === selectedPrId)) selectedPrId = null;
    prCounts.textContent = '表示 ' + visible.length + ' 件 / 判断待ち ' + needsHuman.length
      + ' 件 / Open ' + projectFiltered.length + ' 件';
    prEmpty.hidden = visible.length > 0;
    prEmpty.textContent = openPullRequests.length === 0
      ? 'Open な PR はありません。'
      : '条件に一致する PR はありません。';
    prCards.replaceChildren(...visible.map((pr) => prCard(pr, selectedPrId, selectPullRequest)));
    renderDetail(openPullRequests.find((pr) => pr.id === selectedPrId) ?? null);
  }

  function renderPullRequests(pullRequests) {
    // The service already ordered them by who has to act next; preserving that
    // order is the point, so nothing re-sorts here.
    openPullRequests = pullRequests.filter((pr) => pr.status === 'open');
    if (selectedPrId && !openPullRequests.some((pr) => pr.id === selectedPrId)) selectedPrId = null;
    renderBoard();
  }

  async function refresh() {
    try {
      const [prs, workflow, reviewWork] = await Promise.all([
        request('/api/local-prs'),
        request('/api/test-workflow'),
        request('/api/review-work'),
      ]);
      renderPullRequests(prs.pullRequests);
      renderTestWorkflow(workflow.products);
      renderReviewWork(reviewWork);
    } catch (error) {
      prActionMessage.textContent = error.message;
    }
  }

  filterHuman.addEventListener('change', renderBoard);
  filterProjects.addEventListener('change', () => {
    selectedProjects = new Set([...filterProjects.selectedOptions].map((option) => option.value));
    renderBoard();
  });
  prLogClose.addEventListener('click', closeLogOverlay);
  prLogOverlay.addEventListener('click', (event) => {
    if (event.target === prLogOverlay) closeLogOverlay();
  });
  prDiffClose.addEventListener('click', closeDiffOverlay);
  prDiffOverlay.addEventListener('click', (event) => {
    if (event.target === prDiffOverlay) closeDiffOverlay();
  });
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !prLogOverlay.hidden) closeLogOverlay();
    if (event.key === 'Escape' && !prDiffOverlay.hidden) closeDiffOverlay();
  });
  refresh().finally(connectPrEvents);
`;

const SCRIPT = `${CLIENT_REQUEST_SOURCE}${PR_VIEW_SOURCE}${PR_DIFF_VIEW_SOURCE}${PR_FILTER_SOURCE}${PR_EVENTS_SOURCE}${CONTROLLER_SOURCE}`;

export function renderPrBoardPage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor — PR",
    activeNav: "prs",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
