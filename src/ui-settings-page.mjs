import { CLIENT_REQUEST_SOURCE } from "./ui-client-request.mjs";
import { renderPage } from "./ui-layout.mjs";

const BODY = `
  <section>
    <h2>設定</h2>
    <form id="settings-form">
      <div class="field">
        <label for="anatomia-folder">Anatomiaフォルダ</label>
        <input id="anatomia-folder" required placeholder="E:\\\\Document\\\\Ars\\\\Anatomia">
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
        <label class="check">
          <input id="security-scan-enabled" type="checkbox">
          Codex Security スキャンを実行する（初回レビュー時とマージ直前のみ）
        </label>
        <span class="note">codex-security CLI（npm i -g @openai/codex-security）と ChatGPT/Codex サブスクリプションのサインインが必要です。スキャンは --auth chatgpt 固定で、OPENAI_API_KEY 等による従量課金へは切り替わりません。</span>
      </div>
      <div class="field">
        <label for="security-severity">セキュリティ finding のブロック閾値</label>
        <select id="security-severity">
          <option value="critical">critical</option>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
      </div>
      <div class="field">
        <label for="security-max-cost">スキャン1回あたりの上限コスト（USD）</label>
        <input id="security-max-cost" type="number" min="0.5" step="0.5" required>
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
  <section>
    <h2>プロダクト登録</h2>
    <p class="note">登録時にテストケースが必須です。登録すると main の pre-push 流出ガードも設置されます。</p>
    <form id="repository-form">
      <div class="field"><label for="repository-name">repository</label><input id="repository-name" required placeholder="LUDIARS/Revisor"></div>
      <div class="field"><label for="repository-path">root path</label><input id="repository-path" required placeholder="E:\\\\Document\\\\Ars\\\\Revisor"></div>
      <div class="field"><label for="repository-base">base branch</label><input id="repository-base" required value="main"></div>
      <div class="field"><label for="repository-tests">test cases (JSON)</label><textarea id="repository-tests" required>[
  {"name":"unit","command":"npm","args":["test"],"cwd":"."},
  {"name":"check","command":"npm","args":["run","check"],"cwd":"."}
]</textarea></div>
      <button type="submit">登録</button>
      <p id="repository-message" role="status"></p>
    </form>
    <h3>登録済み</h3>
    <table>
      <thead><tr><th>repository</th><th>root path</th><th>base</th><th>テストケース</th></tr></thead>
      <tbody id="repository-rows"></tbody>
    </table>
  </section>
`;

const SCRIPT = `${CLIENT_REQUEST_SOURCE}
  const form = document.querySelector('#settings-form');
  const message = document.querySelector('#message');
  const repositoryMessage = document.querySelector('#repository-message');
  const repositoryRows = document.querySelector('#repository-rows');

  function cell(value) {
    const node = document.createElement('td');
    node.textContent = String(value ?? '');
    return node;
  }

  async function refreshSettings() {
    const state = await request('/api/settings');
    document.querySelector('#anatomia-folder').value = state.settings.anatomiaFolder;
    document.querySelector('#fallback-reviewer').value = state.settings.fallbackReviewer;
    document.querySelector('#worker-count').value = String(state.settings.workerCount);
    document.querySelector('#concordia-context').checked = state.settings.concordiaContextEnabled;
    document.querySelector('#security-scan-enabled').checked = state.settings.securityScanEnabled;
    document.querySelector('#security-severity').value = state.settings.securityFailOnSeverity;
    document.querySelector('#security-max-cost').value = String(state.settings.securityMaxCostUsd);
    document.querySelector('#allowed-hosts').value = state.allowedHosts.join('\\n');
    document.querySelector('#token-status').textContent = state.workflowTokenConfigured
      ? 'workflow token 設定済み'
      : 'workflow token 未設定';
  }

  async function refreshRepositories() {
    const state = await request('/api/repositories');
    repositoryRows.replaceChildren(...state.repositories.map((repository) => {
      const row = document.createElement('tr');
      row.append(
        cell(repository.repository),
        cell(repository.rootPath),
        cell(repository.baseRef),
        cell(repository.testCases.map((entry) => entry.name).join(', ')),
      );
      return row;
    }));
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
          securityScanEnabled: document.querySelector('#security-scan-enabled').checked,
          securityFailOnSeverity: document.querySelector('#security-severity').value,
          securityMaxCostUsd: Number(document.querySelector('#security-max-cost').value),
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
      await refreshRepositories();
    } catch (error) {
      repositoryMessage.textContent = error.message;
    }
  });

  refreshSettings().catch((error) => { message.textContent = error.message; });
  refreshRepositories().catch((error) => { repositoryMessage.textContent = error.message; });
`;

export function renderSettingsPage(sessionToken) {
  return renderPage({
    sessionToken,
    title: "Revisor Settings",
    activeNav: "settings",
    bodyHtml: BODY,
    scriptSource: SCRIPT,
  });
}
