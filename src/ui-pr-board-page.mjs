import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { renderPage } from "./ui-layout.mjs";
import { PR_VIEW_SOURCE } from "./ui-pr-view-script.mjs";

// トップページは PR のトリアージ専用。 PC 幅では左にリスト・右に選択した PR の
// 詳細の 2 ペインで、 リストを選び替えながら詳細を読み比べられる。 狭い画面では
// ペインが縦に積まれ、 従来どおりカード → 詳細の順で読める。 運用系のパネル
// (登録リポジトリ・PR 作成・キュー) はダッシュボードページへ分離した。
const BODY = `
  <div class="pr-board">
    <section class="pr-list-pane">
      <h2>PR の判断待ち</h2>
      <p class="note">人間の判断が必要な PR を先頭に並べます。</p>
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
    </section>
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
  let selectedPrId = null;
  let openPullRequests = [];
  let selectedProjects = new Set();

  function actionsOf(pr) {
    const wrapper = element('div', 'actions');
    const geniusHumanDecision = pr.decision?.humanDecisionMergeable === true;
    if (pr.status === 'open' && (pr.checkStatus === 'test_ok' || geniusHumanDecision) && !pr.draft) {
      const merge = document.createElement('button');
      merge.textContent = geniusHumanDecision
        ? 'Genius を確認して squash merge'
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
    fragment.append(block('レビュー', reviewOf(pr)));
    fragment.append(block('差分解析 (Anatomia)', analysisOf(pr)));
    fragment.append(block('操作', actionsOf(pr)));
    prDetail.replaceChildren(fragment);
  }

  function selectPullRequest(id) {
    selectedPrId = id;
    prActionMessage.textContent = '';
    renderBoard();
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
      const prs = await request('/api/local-prs');
      renderPullRequests(prs.pullRequests);
    } catch (error) {
      prActionMessage.textContent = error.message;
    }
  }

  filterHuman.addEventListener('change', renderBoard);
  filterProjects.addEventListener('change', () => {
    selectedProjects = new Set([...filterProjects.selectedOptions].map((option) => option.value));
    renderBoard();
  });
  refresh();
  setInterval(refresh, 3000);
`;

const SCRIPT = `${CLIENT_REQUEST_SOURCE}${PR_VIEW_SOURCE}${PR_FILTER_SOURCE}${CONTROLLER_SOURCE}`;

export function renderPrBoardPage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor — PR",
    activeNav: "prs",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
