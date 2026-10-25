// Owns dashboard listeners and refresh lifecycle; dependencies are explicit.
export function startDashboard({ document, request, views, createVisibleRefreshLoop, schedule = setTimeout, cancel = clearTimeout }) {
  const { cell, paragraph, listOf } = views;

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
      const proposal = repository.refactoringProposal;
      const proposalCell = cell(proposal?.status === 'suggested'
        ? '◆ リファクタリング提案 (助言)'
        : proposal?.status === 'clear' ? '直近の解析では提案なし' : '未計測',
        proposal?.status === 'suggested' ? 'warn' : '');
      if (proposal?.sourcePrNumber != null) {
        proposalCell.append(paragraph('根拠 PR #' + proposal.sourcePrNumber));
      }
      proposalCell.append(paragraph(proposal?.projectOrphanStatus === 'measured'
        ? 'プロジェクト全体の孤立関数: ' + proposal.projectOrphanCount + ' 件'
        : 'プロジェクト全体の孤立関数: 未計測'));
      if (proposal?.findings?.length) {
        proposalCell.append(listOf(proposal.findings));
        proposalCell.append(paragraph('マージは妨げません。'));
        if (proposal?.projectOrphanStatus === 'measured'
            && proposal.projectOrphanCount >= proposal.thresholds?.minimumProjectOrphans) {
          proposalCell.append(paragraph('孤立関数は静的に呼び出し元を確認できない関数であり、不要コードの断定ではありません。'));
        }
      }
      row.append(
        cell(repository.repository),
        proposalCell,
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
      const results = await Promise.allSettled([
        request('/api/jobs'),
        request('/api/repositories'),
        request('/api/local-prs?view=summary&state=open'),
        request('/api/releases'),
      ]);
      // A failed request must not release the refresh slot while peers still run.
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      const [jobs, repositories, prs, releases] = results.map((result) => result.value);
      queue.textContent = [
        'running: ' + jobs.running,
        'queued: ' + jobs.queued,
        'standard: ' + (jobs.lanes?.standard || 0),
        'fast: ' + (jobs.lanes?.fast || 0),
        '',
        ...jobs.jobs.slice(0, 20).map((job) =>
          '[' + job.reviewLane + '] ' + job.status + '  '
            + job.request.repository + '#' + job.request.number + '  ' + job.id),
      ].join('\n');
      renderRepositories(repositories.repositories, prs.pullRequests, releases.projects);
  }

  const refreshLoop = createVisibleRefreshLoop({
    refresh,
    schedule, cancel,
    isVisible: () => !document.hidden,
    onError: (error) => { queue.textContent = error.message; },
  });
  document.addEventListener('visibilitychange', () => { void refreshLoop.visibilityChanged(); });

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
          fast_lane: document.querySelector('#pr-fast-lane').checked,
        }),
      });
      prMessage.textContent = 'PR を登録しました。';
      await refreshLoop.requestRefresh();
    } catch (error) {
      prMessage.textContent = error.message;
    }
  });

  void refreshLoop.requestRefresh();
  return refreshLoop;
}
