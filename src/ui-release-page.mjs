import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { renderPage } from "./ui-layout.mjs";

const BODY = `
  <section>
    <h2>リリース</h2>
    <p class="note">登録プロジェクトのローカルversionを表示します。major/minor releaseは現在のbase HEADをGitHubへ即時公開し、tagとRelease Notesを作成します。</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>repository</th><th>base</th><th>version</th><th>状態</th><th>次major</th><th>次minor</th></tr></thead>
        <tbody id="release-project-rows"></tbody>
      </table>
    </div>
    <p id="release-project-empty" class="empty">登録されたプロジェクトはありません。</p>
  </section>

  <section id="pending-publish-section" hidden>
    <h2>GitHub 未送出のマージ</h2>
    <p class="note">ローカルではマージ済みですが GitHub へ送っていません。<code>revisor publish-pending</code> で後送します。</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>repository</th><th>PR</th><th>title</th><th>保留理由</th><th>merged</th></tr></thead>
        <tbody id="pending-publish-rows"></tbody>
      </table>
    </div>
  </section>

  <div class="grid">
    <section>
      <h2>初期version登録</h2>
      <p class="note">versionファイルがない場合はbaseへ <code>uninitialized</code> のbootstrap commitを作り、指定versionをローカル管理状態として設定します。</p>
      <form id="version-initialize-form">
        <div class="field"><label for="initialize-repository">repository</label><select id="initialize-repository" required></select></div>
        <div class="field"><label for="initialize-version">initial version</label><input id="initialize-version" required pattern="(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" placeholder="0.1.0"></div>
        <label class="check"><input id="initialize-confirm" type="checkbox" required>baseへのbootstrap commitを確認しました</label>
        <button type="submit">初期versionを登録</button>
        <p id="initialize-message" role="status"></p>
      </form>
    </section>

    <section>
      <h2>major / minor 即時release</h2>
      <form id="manual-release-form">
        <div class="field"><label for="release-repository">repository</label><select id="release-repository" required></select></div>
        <dl class="meta"><dt>current</dt><dd id="release-current">—</dd><dt>next</dt><dd id="release-next">—</dd></dl>
        <div class="field"><label for="release-kind">version increment</label><select id="release-kind"><option value="minor">minor</option><option value="major">major</option></select></div>
        <div class="field"><label for="release-title">Release title</label><input id="release-title" required maxlength="256"></div>
        <div class="field"><label for="release-notes">Release Notes</label><textarea id="release-notes" required maxlength="60000"></textarea></div>
        <label class="check"><input id="release-confirm" type="checkbox" required>現在のbase HEADをGitHubへ即時公開することを確認しました</label>
        <button type="submit">GitHubへ即時release</button>
        <p id="release-message" role="status"></p>
      </form>
    </section>
  </div>
`;

const SCRIPT = `${CLIENT_REQUEST_SOURCE}
  let releaseProjects = [];
  const rows = document.querySelector('#release-project-rows');
  const empty = document.querySelector('#release-project-empty');
  const initializeSelect = document.querySelector('#initialize-repository');
  const releaseSelect = document.querySelector('#release-repository');
  const releaseKind = document.querySelector('#release-kind');
  const initializeMessage = document.querySelector('#initialize-message');
  const releaseMessage = document.querySelector('#release-message');

  function cell(value, className = '') {
    const node = document.createElement('td');
    node.textContent = String(value ?? '');
    if (className) node.className = className;
    return node;
  }

  function statusLabel(version) {
    if (version.status === 'missing') return 'versionファイル未登録';
    if (version.status === 'uninitialized') return '初期version未設定';
    if (version.status === 'invalid') return version.error || 'version状態が不正';
    return version.managed ? '設定済み' : 'skip-worktree未設定';
  }

  function optionsFor(projects, selected) {
    return projects.map((project) => {
      const option = document.createElement('option');
      option.value = project.repository;
      option.textContent = project.repository;
      option.selected = project.repository === selected;
      return option;
    });
  }

  function selectedReleaseProject() {
    return releaseProjects.find((project) => project.repository === releaseSelect.value) || null;
  }

  function refreshPreview() {
    const project = selectedReleaseProject();
    document.querySelector('#release-current').textContent = project?.version.version || '—';
    document.querySelector('#release-next').textContent = !project
      ? '—'
      : (releaseKind.value === 'major' ? project.nextMajor : project.nextMinor);
  }

  function renderPendingPublishes(pending) {
    const section = document.querySelector('#pending-publish-section');
    section.hidden = pending.length === 0;
    if (pending.length === 0) {
      document.querySelector('#pending-publish-rows').replaceChildren();
      return;
    }
    document.querySelector('#pending-publish-rows').replaceChildren(...pending.map((entry) => {
      const row = document.createElement('tr');
      row.append(
        cell(entry.repository),
        cell(entry.number === null ? '—' : '#' + entry.number),
        cell(entry.title || '—'),
        cell(entry.reason || '—', 'warn'),
        cell(entry.mergedAt || '—'),
      );
      return row;
    }));
  }

  async function refreshReleases() {
    const selectedInitialize = initializeSelect.value;
    const selectedRelease = releaseSelect.value;
    const state = await request('/api/releases');
    renderPendingPublishes(state.pendingPublishes || []);
    releaseProjects = state.projects;
    empty.hidden = releaseProjects.length > 0;
    rows.replaceChildren(...releaseProjects.map((project) => {
      const tone = project.version.status === 'ready' && project.version.managed
        ? 'ok'
        : (project.version.status === 'invalid' ? 'bad' : 'warn');
      const row = document.createElement('tr');
      row.append(
        cell(project.repository),
        cell(project.baseRef),
        cell(project.version.version || '—'),
        cell(statusLabel(project.version), tone),
        cell(project.nextMajor || '—'),
        cell(project.nextMinor || '—'),
      );
      return row;
    }));
    const initializable = releaseProjects.filter((project) =>
      project.version.status === 'missing' || project.version.status === 'uninitialized');
    const releasable = releaseProjects.filter((project) =>
      project.version.status === 'ready' && project.version.managed);
    initializeSelect.replaceChildren(...optionsFor(initializable, selectedInitialize));
    releaseSelect.replaceChildren(...optionsFor(releasable, selectedRelease));
    document.querySelector('#version-initialize-form').querySelector('button').disabled =
      initializable.length === 0;
    document.querySelector('#manual-release-form').querySelector('button').disabled =
      releasable.length === 0;
    refreshPreview();
  }

  releaseSelect.addEventListener('change', refreshPreview);
  releaseKind.addEventListener('change', refreshPreview);

  document.querySelector('#version-initialize-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button');
    submit.disabled = true;
    initializeMessage.textContent = '登録中…';
    try {
      const repository = initializeSelect.value;
      const result = await request('/api/releases/' + encodeURIComponent(repository) + '/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: document.querySelector('#initialize-version').value,
          confirm: document.querySelector('#initialize-confirm').checked,
        }),
      });
      initializeMessage.textContent = result.project.repository + ' を ' + result.project.version + ' で登録しました。';
      document.querySelector('#initialize-confirm').checked = false;
      await refreshReleases();
    } catch (error) {
      initializeMessage.textContent = error.message;
      await refreshReleases().catch(() => { submit.disabled = false; });
    }
  });

  document.querySelector('#manual-release-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const project = selectedReleaseProject();
    const submit = event.currentTarget.querySelector('button');
    submit.disabled = true;
    releaseMessage.textContent = 'GitHubへ公開中…';
    try {
      const repository = releaseSelect.value;
      const result = await request('/api/releases/' + encodeURIComponent(repository) + '/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: releaseKind.value,
          expectedVersion: project.version.version,
          title: document.querySelector('#release-title').value,
          notes: document.querySelector('#release-notes').value,
          confirm: document.querySelector('#release-confirm').checked,
        }),
      });
      if (result.release.releaseUrl) {
        const link = document.createElement('a');
        link.href = result.release.releaseUrl;
        link.textContent = result.release.tag + ' を公開しました。';
        link.target = '_blank';
        link.rel = 'noreferrer';
        releaseMessage.replaceChildren(link);
      } else {
        releaseMessage.textContent = result.release.tag + ' を公開しました。';
      }
      document.querySelector('#release-confirm').checked = false;
      await refreshReleases();
    } catch (error) {
      releaseMessage.textContent = error.message;
      await refreshReleases().catch(() => { submit.disabled = false; });
    }
  });

  refreshReleases().catch((error) => { releaseMessage.textContent = error.message; });
`;

export function renderReleasePage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor — リリース",
    activeNav: "releases",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
