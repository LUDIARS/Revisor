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
    main { width: min(760px, calc(100% - 32px)); margin: 40px auto; }
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
  </style>
</head>
<body>
<main>
  <section>
    <h1>Revisor</h1>
    <p class="note">独立PRレビューサービス。設定値はローカルに保存され、origin token は暗号化されます。</p>
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
        <label for="origin-token">PR gate origin token（変更時のみ入力）</label>
        <input id="origin-token" type="password" autocomplete="new-password">
        <span id="token-status" class="note"></span>
      </div>
      <div class="field">
        <label for="github-app-id">GitHub App ID</label>
        <input id="github-app-id" required autocomplete="off">
      </div>
      <div class="field">
        <label for="github-app-private-key">GitHub App private key PEM（変更時のみ入力）</label>
        <textarea id="github-app-private-key" autocomplete="off"></textarea>
        <span id="github-app-status" class="note"></span>
      </div>
      <button type="submit">設定を保存</button>
      <p id="message" role="status"></p>
    </form>
    <h2>キュー状態</h2>
    <pre id="queue">確認中…</pre>
  </section>
</main>
<script nonce="${sessionToken}">
  const sessionToken = ${jsonLiteral(sessionToken)};
  const headers = { 'X-Revisor-Session': sessionToken };
  const form = document.querySelector('#settings-form');
  const message = document.querySelector('#message');
  const queue = document.querySelector('#queue');

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
    document.querySelector('#github-app-id').value = state.settings.githubAppId;
    document.querySelector('#token-status').textContent = state.originTokenConfigured
      ? 'origin token 設定済み'
      : 'origin token 未設定';
    document.querySelector('#github-app-status').textContent = state.githubAppConfigured
      ? 'GitHub App 設定済み'
      : 'GitHub App 未設定';
  }

  async function refreshQueue() {
    try {
      const state = await request('/api/jobs');
      const rows = [
        'running: ' + state.running,
        'queued: ' + state.queued,
        '',
        ...state.jobs.slice(0, 20).map((job) =>
          job.status + '  ' + job.request.repository + '#' + job.request.number + '  ' + job.id),
      ];
      queue.textContent = rows.join('\\n');
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
          githubAppId: document.querySelector('#github-app-id').value,
          githubAppPrivateKey: document.querySelector('#github-app-private-key').value,
          originToken: document.querySelector('#origin-token').value,
        }),
      });
      document.querySelector('#origin-token').value = '';
      document.querySelector('#github-app-private-key').value = '';
      await refreshSettings();
      message.textContent = '保存しました。ワーカー数は次回起動から適用されます。';
    } catch (error) {
      message.textContent = error.message;
    }
  });

  refreshSettings().catch((error) => { message.textContent = error.message; });
  refreshQueue();
  setInterval(refreshQueue, 3000);
</script>
</body>
</html>`;
}
