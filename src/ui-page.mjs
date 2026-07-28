function jsonLiteral(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderSettingsPage(sessionToken) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Revisor Settings</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; background: #10141c; color: #edf1f7; }
    main { width: min(1100px, calc(100% - 32px)); margin: 40px auto; display: grid; gap: 20px; }
    section { background: #19202c; border: 1px solid #2d394a; border-radius: 14px; padding: 24px; }
    h1 { margin-top: 0; } h2 { margin-top: 32px; }
    .field { display: grid; gap: 8px; margin: 18px 0; }
    input, select, textarea, button { font: inherit; border-radius: 8px; border: 1px solid #40506a; padding: 10px 12px; }
    input, select, textarea { color: inherit; background: #111722; }
    textarea { min-height: 120px; resize: vertical; }
    button { color: white; background: #405bd8; border-color: #5871e5; cursor: pointer; }
    .check { display: flex; gap: 10px; align-items: center; }
    pre { white-space: pre-wrap; background: #0e131b; border-radius: 8px; padding: 14px; overflow: auto; }
    .note { color: #aebbd0; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #2d394a; padding: 10px 8px; vertical-align: top; }
    .ok { color: #62d59a; } .warn { color: #f5c66b; } .bad { color: #ff7d8d; }
  </style>
</head>
<body>
<main>
  <section>
    <h1>Revisor</h1>
    <p class="note">LUDIARS LOCAL PR WORKFLOW。作業ブランチを GitHub へ送らず、ローカルで CI・Anatomia・レビュー・squash merge を完結します。</p>
    <form id="settings-form">
      <div class="field">
        <label for="anatomia-folder">Anatomiaフォルダ</label>
        <input id="anatomia-folder" required placeholder="E:\\Document\\Ars\\Anatomia">
      </div>
      <div class="field">
        <label for="fallback-reviewer">Cc文脈がない場合のレビュアー</label>
        <select id="fallback-reviewer">
          <option value="codex-sol">Codex Sol</option>
          <option value="claude-opus">Claude Opus</option>
        </select>
      </div>
      <div class="field">
        <label for="worker-count">並列ワーカープロセス数（1〜8、次回起動から適用）</label>
        <input id="worker-count" type="number" min="1" max="8" step="1" required>
      </div>
      <div class="field">
        <label class="check">
          <input id="concordia-context" type="checkbox">
          Cc HTTPまたは読み取り専用DBから元セッション文脈を取得する
        </label>
      </div>
      <div class="field">
        <label for="workflow-token">ローカル workflow API token（変更時のみ入力）</label>
        <input id="workflow-token" type="password" autocomplete="new-password">
        <span id="token-status" class="note"></span>
      </div>
      <div class="field">
        <label for="allowed-hosts">許可Host（Cloudflare Tunnel等、1行1件）</label>
        <textarea id="allowed-hosts" placeholder="revisor.example.com"></textarea>
        <span class="note">localhost / 127.0.0.1 / ::1 は常に許可されます。登録値は暗号化configへ保存し、保存直後から反映します。</span>
      </div>
      <button type="submit">設定を保存</button>
      <p id="message" role="status"></p>
    </form>
  </section>
  <div class="grid">
    <section>
      <h2>プロダクト登録</h2>
      <p class="note">登録時にテストケースが必須です。登録すると main の pre-push 流出ガードも設置されます。</p>
      <form id="repository-form">
        <div class="field"><label>repository</label><input id="repository-name" required placeholder="LUDIARS/Revisor"></div>
        <div class="field"><label>root path</label><input id="repository-path" required placeholder="E:\\Document\\Ars\\Revisor"></div>
        <div class="field"><label>base branch</label><input id="repository-base" required value="main"></div>
        <div class="field"><label>test cases (JSON)</label><textarea id="repository-tests" required>[
  {"name":"unit","command":"npm","args":["test"],"cwd":"."},
  {"name":"check","command":"npm","args":["run","check"],"cwd":"."}
]</textarea></div>
        <button type="submit">登録</button>
        <p id="repository-message" role="status"></p>
      </form>
    </section>
    <section>
      <h2>ローカル PR 作成</h2>
      <form id="pr-form">
        <div class="field"><label>repository</label><select id="pr-repository" required></select></div>
        <div class="field"><label>title</label><input id="pr-title" required></div>
        <div class="field"><label>head branch</label><input id="pr-head" required placeholder="feat/local-change"></div>
        <div class="field"><label>author</label><input id="pr-author" required value="local"></div>
        <div class="field"><label>labels (comma separated)</label><input id="pr-labels"></div>
        <div class="field"><label class="check"><input id="pr-draft" type="checkbox">draft</label></div>
        <div class="field"><label>body</label><textarea id="pr-body"></textarea></div>
        <button type="submit">PR を登録して審査開始</button>
        <p id="pr-message" role="status"></p>
      </form>
    </section>
  </div>
  <section>
    <h2>PR 状況</h2>
    <table><thead><tr><th>PR</th><th>状態</th><th>CI</th><th>Anatomia</th><th>操作</th></tr></thead><tbody id="pr-rows"></tbody></table>
    <h3>キュー</h3><pre id="queue">確認中…</pre>
  </section>
  <section>
    <h2>テストワークフロー</h2>
    <p class="note">このローカル審査を通過した Open / Test OK のプロダクトだけを表示します。</p>
    <ul id="test-products"></ul>
  </section>
</main>
<script nonce="${sessionToken}">
  const sessionToken = ${jsonLiteral(sessionToken)};
  const headers = { 'X-Revisor-Session': sessionToken };
  const form = document.querySelector('#settings-form');
  const message = document.querySelector('#message');
  const queue = document.querySelector('#queue');
  const repositoryMessage = document.querySelector('#repository-message');
  const prMessage = document.querySelector('#pr-message');

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function refreshSettings() {
    const state = await request('/api/settings');
    document.querySelector('#anatomia-folder').value = state.settings.anatomiaFolder;
    document.querySelector('#fallback-reviewer').value = state.settings.fallbackReviewer;
    document.querySelector('#worker-count').value = String(state.settings.workerCount);
    document.querySelector('#concordia-context').checked = state.settings.concordiaContextEnabled;
    document.querySelector('#allowed-hosts').value = state.allowedHosts.join('\\n');
    document.querySelector('#token-status').textContent = state.workflowTokenConfigured
      ? 'workflow token 設定済み'
      : 'workflow token 未設定';
  }

  function escapeText(value) {
    return String(value ?? '');
  }

  async function refreshWorkflow() {
    try {
      const [state, repositories, prs, workflow] = await Promise.all([
        request('/api/jobs'),
        request('/api/repositories'),
        request('/api/local-prs'),
        request('/api/test-workflow'),
      ]);
      const rows = [
        'running: ' + state.running,
        'queued: ' + state.queued,
        '',
        ...state.jobs.slice(0, 20).map((job) =>
          job.status + '  ' + job.request.repository + '#' + job.request.number + '  ' + job.id),
      ];
      queue.textContent = rows.join('\\n');
      const select = document.querySelector('#pr-repository');
      const selected = select.value;
      select.replaceChildren(...repositories.repositories.map((repository) => {
        const option = document.createElement('option');
        option.value = repository.repository;
        option.textContent = repository.repository;
        return option;
      }));
      if (selected) select.value = selected;
      const body = document.querySelector('#pr-rows');
      body.replaceChildren(...prs.pullRequests.map((pr) => {
        const row = document.createElement('tr');
        const score = pr.anatomia
          ? [
              'score Δ ' + pr.anatomia.complexityScoreDelta,
              'orphans ' + (pr.anatomia.quality?.changedOrphans?.length || 0),
              'violations ' + (pr.anatomia.architecture?.changedViolations?.length || 0),
            ].join(', ')
          : 'pending';
        const tests = Array.isArray(pr.ci)
          ? pr.ci.map((test) => test.name + ': ' + test.status).join(', ')
          : 'pending';
        for (const value of [
          pr.repository + '#' + pr.number + ' ' + pr.title,
          (pr.draft ? 'draft / ' : '') + pr.status + ' / ' + pr.checkStatus,
          tests,
          score,
        ]) {
          const cell = document.createElement('td');
          cell.textContent = escapeText(value);
          row.append(cell);
        }
        const action = document.createElement('td');
        if (pr.status === 'open' && pr.checkStatus === 'test_ok') {
          const button = document.createElement('button');
          button.textContent = 'squash merge';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await request('/api/local-prs/' + encodeURIComponent(pr.id) + '/merge', { method: 'POST' });
              await refreshWorkflow();
            } catch (error) {
              prMessage.textContent = error.message;
              button.disabled = false;
            }
          });
          action.append(button);
        }
        row.append(action);
        return row;
      }));
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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '保存中…';
    try {
      await request('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anatomiaFolder: document.querySelector('#anatomia-folder').value,
          fallbackReviewer: document.querySelector('#fallback-reviewer').value,
          workerCount: Number(document.querySelector('#worker-count').value),
          concordiaContextEnabled: document.querySelector('#concordia-context').checked,
          workflowToken: document.querySelector('#workflow-token').value,
          allowedHosts: document.querySelector('#allowed-hosts').value
            .split('\\n').map((host) => host.trim()).filter(Boolean),
        }),
      });
      document.querySelector('#workflow-token').value = '';
      await refreshSettings();
      message.textContent = '保存しました。ワーカー数は次回起動から適用されます。';
    } catch (error) {
      message.textContent = error.message;
    }
  });

  document.querySelector('#repository-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    repositoryMessage.textContent = '登録中…';
    try {
      await request('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repository: document.querySelector('#repository-name').value,
          root_path: document.querySelector('#repository-path').value,
          base_ref: document.querySelector('#repository-base').value,
          test_cases: JSON.parse(document.querySelector('#repository-tests').value),
        }),
      });
      repositoryMessage.textContent = '登録しました。';
      await refreshWorkflow();
    } catch (error) {
      repositoryMessage.textContent = error.message;
    }
  });

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
      await refreshWorkflow();
    } catch (error) {
      prMessage.textContent = error.message;
    }
  });

  refreshSettings().catch((error) => { message.textContent = error.message; });
  refreshWorkflow();
  setInterval(refreshWorkflow, 3000);
</script>
</body>
</html>`;
}
