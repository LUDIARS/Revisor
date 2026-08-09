import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboardPage } from "../src/ui-dashboard-page.mjs";
import { PR_FILTER_SOURCE, renderPrBoardPage } from "../src/ui-pr-board-page.mjs";
import { renderSettingsPage } from "../src/ui-settings-page.mjs";
import { renderReleasePage } from "../src/ui-release-page.mjs";
import { PR_VIEW_SOURCE } from "../src/ui-pr-view-script.mjs";
import {
  isAllowedHost,
  isAuthorizedSession,
  isLoopbackHost,
} from "../src/ui-security.mjs";

test("the top page is a two-pane PR board: list left, detail right", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /<h1>Revisor<\/h1>/);
  assert.match(page, /LUDIARS LOCAL PR WORKFLOW/);
  assert.match(page, /class="pr-board"/);
  assert.match(page, /class="pr-list-pane"/);
  assert.match(page, /class="pr-detail-pane"/);
  assert.ok(page.indexOf('class="test-workflow-summary"') < page.indexOf('class="pr-board"'));
  assert.ok(page.indexOf('class="pr-list-pane"') < page.indexOf('class="pr-detail-pane"'));
  assert.match(page, /判断が必要なものだけ表示/);
  assert.match(page, /id="filter-projects" multiple/);
  assert.match(page, /<label for="filter-projects">プロジェクト（複数選択可・未選択はすべて）<\/label>/);
  assert.match(page, /nonce="session-nonce"/);
  // 狭幅では 1 カラムへ畳む。
  assert.match(page, /@media \(max-width: 960px\)/);
});

test("the PR board exposes decision, plan, test, review and diff analysis detail", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /選択した PR の詳細/);
  assert.match(page, /block\('判断', decisionOf\(pr\)\)/);
  assert.match(page, /block\('レビュー計画', planOf\(pr\.reviewPlan\)\)/);
  assert.match(page, /block\('テスト', testsOf\(pr\)\)/);
  assert.match(page, /block\('変更内容', changedFilesOf\(pr, openChangedFiles\)\)/);
  assert.match(page, /block\('レビュー', reviewOf\(pr\)\)/);
  assert.match(page, /block\('差分解析 \(Anatomia\)', analysisOf\(pr\)\)/);
  assert.match(page, /Genius の判断カード/);
  assert.match(page, /selectedPrId = id/);
  assert.match(page, /runAction\(retry, pr\.id, 'retry'\)/);
  assert.match(page, /人間判断で squash merge/);
  // ボタンの表示条件はサービス側の述語 (decision.humanDecisionMergeable) をそのまま
  // 読む。 ここで条件を書き直すと、 マージ経路の前提とずれたボタンが復活する。
  assert.match(page, /pr\.decision\?\.humanDecisionMergeable === true/);
  // 審査が終わっている open な PR は、 マージせずに取り下げられる。
  assert.match(page, /runAction\(close, pr\.id, 'close'\)/);
  assert.match(page, /close\.textContent = '取り下げ'/);
});

test("the PR page explains early QA above the board", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /審査中は先行QA/);
  assert.match(page, /審査通過後は確定QA/);
  assert.match(page, /request\('\/api\/test-workflow'\)/);
});

test("the PR page shows live dedicated review worker queues", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /レビュー worker queue/);
  assert.match(page, /id="review-work-capacity"/);
  assert.match(page, /request\('\/api\/review-work'\)/);
  assert.match(page, /review_work\.updated/);
});

test("the PR page offers a GitHub-style changed-file and unified-diff overlay", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /id="pr-diff-overlay"/);
  assert.match(page, /変更ファイルと diff を確認/);
  assert.match(page, /request\('\/api\/local-prs\/'.*'\/files'\)/);
  assert.match(page, /\/diff\?path=/);
  assert.match(page, /function unifiedDiffView/);
  assert.match(page, /'diff-line ' \+ tone/);
});

test("the compact PR menu puts the number before the review state and omits merge risk", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /class="cards" id="pr-cards"/);
  assert.match(page, /function menuDecisionLabel\(pr\)/);
  assert.match(page, /'レビュー項目があります'/);
  assert.match(page, /element\('span', 'pr-number', '#' \+ pr\.number\)/);
  assert.match(page, /badge\(menuDecisionLabel\(pr\), menuTone\)/);
  assert.doesNotMatch(page, /function prCardChips\(pr\)/);
  assert.doesNotMatch(page, /function riskLabel\(decision\)/);
  assert.match(page, /@media \(max-width: 700px\)/);
});

test("the generated PR board script stays syntactically valid", () => {
  const page = renderPrBoardPage("session-nonce");
  const script = page.match(/<script nonce="session-nonce">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "expected the PR board page to include its inline script");
  assert.doesNotThrow(() => new Function(script));
});

// The filter rules are pure, so they are exercised as functions instead of being
// matched in the generated source: a regex over the script passes for code that
// never runs, and breaks on a rename that changes nothing the operator sees.
function boardFilters() {
  return new Function(`${PR_FILTER_SOURCE}
    return { projectsOf, keepKnownProjects, sameProjectOptions, boardView };`)();
}

function fakePr(id, repository, state) {
  return { id, number: Number(id), repository, title: id, decision: { state } };
}

test("no project selected means every project, and selecting projects unions them", () => {
  const { boardView } = boardFilters();
  const prs = [
    fakePr("1", "Revisor", "needs_human"),
    fakePr("2", "Cernere", "auto_ok"),
    fakePr("3", "Actio", "needs_human"),
  ];
  const all = boardView(prs, new Set(), false);
  assert.deepEqual(all.visible.map((pr) => pr.id), ["1", "2", "3"]);
  const picked = boardView(prs, new Set(["Revisor", "Actio"]), false);
  assert.deepEqual(picked.visible.map((pr) => pr.id), ["1", "3"]);
});

test("the counts and the human-only filter apply to the project-filtered set", () => {
  const { boardView } = boardFilters();
  const prs = [
    fakePr("1", "Revisor", "needs_human"),
    fakePr("2", "Revisor", "auto_ok"),
    fakePr("3", "Cernere", "needs_human"),
  ];
  const board = boardView(prs, new Set(["Revisor"]), true);
  // Open も判断待ちも Cernere を数えない。 表示は判断待ちの 1 件だけ。
  assert.deepEqual(board.projectFiltered.map((pr) => pr.id), ["1", "2"]);
  assert.deepEqual(board.needsHuman.map((pr) => pr.id), ["1"]);
  assert.deepEqual(board.visible.map((pr) => pr.id), ["1"]);
});

test("the project filter rebuilds its options only when the project set changed", () => {
  const { projectsOf, sameProjectOptions } = boardFilters();
  const projects = projectsOf([
    fakePr("1", "Revisor", "needs_human"),
    fakePr("2", "Actio", "auto_ok"),
    fakePr("3", "Revisor", "auto_ok"),
  ]);
  assert.deepEqual(projects, ["Actio", "Revisor"]);
  // 3 秒ごとの更新で option を作り直すと、選択中の multiple-select が閉じる。
  assert.equal(sameProjectOptions([{ value: "Actio" }, { value: "Revisor" }], projects), true);
  assert.equal(sameProjectOptions([{ value: "Actio" }], projects), false);
  assert.equal(sameProjectOptions([{ value: "Actio" }, { value: "Cernere" }], projects), false);
});

// A selected project whose last PR closed must drop out of the selection, or the
// rebuilt options and the selection disagree and the board filters on a project
// the operator can no longer see or unselect.
test("a project that no longer has an open PR drops out of the selection", () => {
  const { keepKnownProjects, boardView } = boardFilters();
  const kept = keepKnownProjects(new Set(["Revisor", "Cernere"]), ["Actio", "Revisor"]);
  assert.deepEqual([...kept], ["Revisor"]);
  // 残った選択がそのまま絞り込みに効く。 空になれば未選択と同じく全件へ戻る。
  const prs = [fakePr("1", "Revisor", "needs_human"), fakePr("2", "Actio", "auto_ok")];
  assert.deepEqual(boardView(prs, kept, false).visible.map((pr) => pr.id), ["1"]);
  assert.deepEqual(
    boardView(prs, keepKnownProjects(new Set(["Cernere"]), ["Actio", "Revisor"]), false)
      .visible.map((pr) => pr.id),
    ["1", "2"],
  );
});

test("the board wires the pure filters into its event-driven render", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /selectedProjects = keepKnownProjects\(selectedProjects, projects\)/);
  assert.match(page, /sameProjectOptions\(filterProjects\.options, projects\)/);
  assert.match(page, /boardView\(openPullRequests, selectedProjects, filterHuman\.checked\)/);
});

test("the detail view no longer dumps the raw Anatomia payload", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.doesNotMatch(page, /生データ/);
  assert.doesNotMatch(page, /JSON\.stringify\(pr\.anatomia/);
});

test("the dashboard keeps the operational panels and hands PR triage to the top page", () => {
  const page = renderDashboardPage("session-nonce");
  assert.match(page, /<h2>登録プロジェクト<\/h2>/);
  assert.match(page, /<h2>ローカル PR 作成<\/h2>/);
  assert.doesNotMatch(page, /class="cards" id="pr-cards"/);
  assert.match(page, /href="\/dashboard" class="active"/);
  assert.match(page, /<th>version<\/th>/);
  assert.match(page, /request\('\/api\/releases'\)/);
  assert.doesNotMatch(page, /push guard/i);
  assert.doesNotMatch(page, /<h2>テストワークフロー<\/h2>/);
  assert.match(page, /<label for="pr-body">PR内容<\/label>/);
  assert.match(page, /## 実装内容/);
  assert.match(page, /## 受け入れ条件/);
});

test("the PR board receives realtime status events and logs them below the detail", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /id="pr-event-entries"/);
  assert.ok(page.indexOf('id="pr-detail"') < page.indexOf('class="pr-event-log"'));
  assert.match(page, /new WebSocket\(url, 'revisor-session\.' \+ sessionToken\)/);
  assert.match(page, /await refresh\(\)/);
  assert.doesNotMatch(page, /setInterval\(refresh, 3000\)/);
  assert.match(page, /main \{ width: calc\(100% - 32px\)/);
  assert.match(page, /grid-template-columns: minmax\(340px, 2fr\) minmax\(0, 3fr\)/);
  assert.match(page, /visible\.slice\(-50\)/);
  assert.match(page, /behavior: 'smooth'/);
});

test("each PR exposes persistent filtered Test Workflow logs and a full-screen Log overlay", () => {
  const page = renderPrBoardPage("session-nonce");
  assert.match(page, /block\('Test Workflow ログ', workflowLogOf\(pr, openLogOverlay\)\)/);
  assert.match(page, /\['review_passed', 'Test OK'\]/);
  assert.match(page, /\(pr\.lifecycleEvents \|\| \[\]\)\.slice\(-50\)/);
  assert.match(page, /logButton\.textContent = 'Log'/);
  assert.match(page, /class="log-overlay" hidden/);
  assert.match(page, /position: fixed; inset: 0; z-index: 1000/);
  assert.match(page, /source\.textContent = '該当PRを開く'/);
  assert.match(page, /looksLikePullRequest/);
});

test("the Releases tab exposes initialization and confirmed immediate publication", () => {
  const page = renderReleasePage("session-nonce");
  assert.match(page, /href="\/releases" class="active"/);
  assert.match(page, /初期version登録/);
  assert.match(page, /major \/ minor 即時release/);
  assert.match(page, /現在のbase HEADをGitHubへ即時公開することを確認しました/);
  assert.match(page, /\/api\/releases\/.*\/initialize/);
  assert.match(page, /\/api\/releases\/.*\/publish/);
  const script = page.match(/<script nonce="session-nonce">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("the dashboard keeps configuration on the settings page", () => {
  const page = renderDashboardPage("session-nonce");
  assert.doesNotMatch(page, /Anatomiaフォルダ/);
  assert.doesNotMatch(page, /許可Host/);
  assert.doesNotMatch(page, /プロダクト登録/);
  assert.match(page, /href="\/settings"/);
});

test("renders a dedicated token-free settings page", () => {
  const page = renderSettingsPage("session-nonce");
  assert.match(page, /Anatomiaフォルダ/);
  assert.match(page, /id="anatomia-review-gate"/);
  assert.match(page, /各レビュー工程の並列 worker 数/);
  assert.match(page, /許可Host/);
  assert.match(page, /暗号化config/);
  assert.match(page, /プロダクト登録/);
  assert.match(page, /GitHub App ID/);
  assert.match(page, /GitHub App 秘密鍵/);
  assert.match(page, /githubAppPrivateKey: document\.querySelector\('#github-app-private-key'\)/);
  const settingsForm = page.slice(
    page.indexOf('<form id="settings-form">'),
    page.indexOf('<form id="allowed-hosts-form">'),
  );
  assert.match(settingsForm, /id="github-app-id"/);
  assert.match(settingsForm, /id="github-app-private-key"/);
  assert.match(page, /nonce="session-nonce"/);
  assert.doesNotMatch(page, /origin-secret/);
  assert.doesNotMatch(page, /<h2>PR の判断待ち<\/h2>/);
});

test("the settings page owns the auto-merge threshold and the plan advisor", () => {
  const page = renderSettingsPage("session-nonce");
  assert.match(page, /許容するマージリスク/);
  assert.match(page, /オートマージする/);
  assert.match(page, /人間による動作確認が必要な PR はオートマージしない/);
  assert.match(page, /レビュー計画の決定者/);
  assert.match(page, /Augur CLI に相談する/);
  assert.match(page, /autoMergeRiskThreshold: Number/);
});

test("the settings page owns the review scale thresholds", () => {
  const page = renderSettingsPage({ nonce: "test-nonce" });
  assert.match(page, /id="large-review-line-threshold"/);
  assert.match(page, /id="multi-domain-review-threshold"/);
  assert.match(page, /largeReviewLineThreshold:/);
  assert.match(page, /multiDomainReviewThreshold:/);
  assert.match(page, /id="cost-validation-review"/);
  assert.match(page, /id="cost-validation-genius"/);
  assert.match(page, /id="cost-validation-anatomia-domain"/);
  assert.match(page, /各レビュー工程の並列 worker 数/);
  assert.match(page, /costValidationSkipReview:/);
  assert.match(page, /costValidationSkipGenius:/);
  assert.match(page, /anatomiaReviewGateEnabled:/);
  assert.match(page, /costValidationSkipAnatomiaDomain:/);
});

// The page script reads every control by id, so a missing field throws on
// `.value` and takes the whole settings page down rather than just its own row.
test("the settings page owns the security scan effort and model", () => {
  const page = renderSettingsPage("session-nonce");
  assert.match(page, /id="security-effort"/);
  assert.match(page, /id="security-model"/);
  assert.match(page, /securityScanEffort: document\.querySelector\('#security-effort'\)/);
  assert.match(page, /securityScanModel: document\.querySelector\('#security-model'\)\.value\.trim\(\)/);
  // The default is medium; xhigh must stay reachable for repos that want depth.
  assert.match(page, /<option value="xhigh">xhigh<\/option>/);
});

// `PUT /api/settings` now answers 400 when the body carries `allowedHosts`, so
// one stray line in the general form would break every settings save. The
// textarea is also filled on load only: refreshing after a general save would
// discard an allowed-host edit that has not been submitted yet.
test("the settings page saves allowed hosts from their own form", () => {
  const page = renderSettingsPage("session-nonce");
  assert.match(page, /id="allowed-hosts-form"/);
  assert.match(page, /request\('\/api\/settings\/allowed-hosts', \{/);
  const generalSave = page.slice(
    page.indexOf("form.addEventListener"),
    page.indexOf("allowedHostsForm.addEventListener"),
  );
  assert.ok(generalSave.length > 0);
  assert.doesNotMatch(generalSave, /allowedHosts/);
  const refresh = page.slice(
    page.indexOf("async function refreshSettings"),
    page.indexOf("async function refreshRepositories"),
  );
  assert.ok(refresh.length > 0);
  assert.doesNotMatch(refresh, /#allowed-hosts/);
});

test("limits settings access to loopback and the UI session", () => {
  assert.equal(isLoopbackHost("127.0.0.1:4240"), true);
  assert.equal(isLoopbackHost("localhost:4240"), true);
  assert.equal(isLoopbackHost("review.example.com"), false);
  assert.equal(isAllowedHost("review.example.com:443", ["review.example.com"]), true);
  assert.equal(isAllowedHost("other.example.com", ["review.example.com"]), false);
  assert.equal(isAuthorizedSession({ "x-revisor-session": "a" }, "a"), true);
  assert.equal(isAuthorizedSession({ "x-revisor-session": "b" }, "a"), false);
});

// The PR detail view is client script, so it is exercised the way the browser does:
// evaluated against a minimal DOM. Asserting on the source text would pass even if
// the failed-output section were never appended.
function fakeDocument() {
  const node = (tag) => ({
    tag,
    className: "",
    textContent: "",
    children: [],
    dataset: {},
    style: {},
    tabIndex: 0,
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute() {},
    addEventListener() {},
  });
  return {
    createElement: node,
    createDocumentFragment: () => node("#fragment"),
    createTextNode: (value) => ({ ...node("#text"), textContent: String(value) }),
  };
}

function renderTests(pr) {
  const view = new Function("document", `${PR_VIEW_SOURCE}\nreturn testsOf;`);
  return view(fakeDocument())(pr);
}

function renderedText(node) {
  return [node.textContent, ...(node.children ?? []).map(renderedText)].join(" ");
}

test("the PR detail renders the Anatomia front-gate outcome", () => {
  const view = new Function("document", `${PR_VIEW_SOURCE}\nreturn reviewOf;`);
  const rendered = view(fakeDocument())({
    anatomiaGate: {
      status: "blocked",
      message: "Anatomia review gate found a blocking reason.",
    },
    reasons: ["Anatomia changed violation: forbidden dependency"],
    advisories: [],
  });
  assert.match(renderedText(rendered), /Anatomia 前段ゲート blocked/);
  assert.match(renderedText(rendered), /forbidden dependency/);
});

function renderCard(pr) {
  const view = new Function("document", `${PR_VIEW_SOURCE}\nreturn prCard;`);
  return view(fakeDocument())(pr, null, () => {});
}

function renderOverview(pr) {
  const view = new Function("document", `${PR_VIEW_SOURCE}\nreturn overviewOf;`);
  return view(fakeDocument())(pr);
}

function flatten(node) {
  const own = node.textContent ? [node.textContent] : [];
  return [...own, ...(node.children ?? []).flatMap(flatten)];
}

function firstNode(node, predicate) {
  if (predicate(node)) return node;
  return (node.children ?? []).map((child) => firstNode(child, predicate)).find(Boolean) ?? null;
}

test("the test panel shows the output of failed cases only", () => {
  const rendered = renderTests({
    ci: [
      { name: "unit", status: "passed", exitCode: 0, durationMs: 1000 },
      {
        name: "typecheck",
        status: "failed",
        exitCode: 1,
        durationMs: 2000,
        output: { text: "--- stderr ---\nTS2345: not assignable", truncated: false },
      },
    ],
  });
  const texts = flatten(rendered);
  assert.equal(texts.includes("失敗したテストの出力 (秘匿値はマスク済み)"), true);
  assert.equal(texts.includes("typecheck"), true);
  assert.equal(texts.some((entry) => entry.includes("TS2345: not assignable")), true);
  assert.equal(texts.some((entry) => entry.includes("(末尾のみ)")), false);
});

test("the test panel marks a truncated output as a tail", () => {
  const rendered = renderTests({
    ci: [{
      name: "unit",
      status: "failed",
      exitCode: 1,
      durationMs: 1000,
      output: { text: "[truncated: kept the last 12288 of 40000 bytes]\nnot ok 9", truncated: true },
    }],
  });
  const texts = flatten(rendered);
  assert.equal(texts.includes("unit (末尾のみ)"), true);
  assert.equal(texts.some((entry) => entry.includes("[truncated: kept the last 12288")), true);
});

// The menu card is the one place where dropping a field is invisible in the
// source: `doesNotMatch` on a deleted helper still passes if the card grew a new
// one. Rendering it and comparing the whole text list pins the 3 items exactly.
test("the menu card carries the number, review state and project only", () => {
  const texts = flatten(renderCard({
    id: "pr-42",
    number: 42,
    repository: "Revisor",
    title: "compact the PR menu",
    decision: { state: "needs_human", label: "人間の判断が必要", tone: "bad", riskScore: 87 },
  }));
  assert.deepEqual(texts, ["#42", "レビュー項目があります", "Revisor", "compact the PR menu"]);
});

test("the menu card keeps the plain decision label for states other than needs_human", () => {
  const card = renderCard({
    id: "pr-7",
    number: 7,
    repository: "Revisor",
    title: "自動マージ可の PR",
    decision: { state: "auto_ok", label: "自動マージ可", tone: "ok", riskScore: 12 },
  });
  assert.deepEqual(flatten(card), ["#7", "自動マージ可", "Revisor", "自動マージ可の PR"]);
  assert.equal(card.dataset.tone, "ok");
});

test("a Test OK PR overrides a human-decision label with a green Test OK badge", () => {
  const card = renderCard({
    id: "pr-ok",
    number: 8,
    repository: "Revisor",
    title: "approved",
    checkStatus: "test_ok",
    decision: { state: "needs_human", label: "人間の判断が必要", tone: "bad" },
  });
  assert.deepEqual(flatten(card), ["#8", "Test OK", "Revisor", "approved"]);
  assert.equal(card.dataset.tone, "ok");
});

test("the PR detail renders structured source links safely", () => {
  const rendered = renderOverview({
    repository: "LUDIARS/Revisor",
    number: 261,
    title: "Keep source links",
    status: "open",
    checkStatus: "queued",
    author: "local",
    headRef: "feat/source-links",
    baseRef: "main",
    headSha: "a".repeat(40),
    reviewedHeadSha: null,
    baseSha: "b".repeat(40),
    labels: [],
    updatedAt: "2026-08-06T00:00:00.000Z",
    body: "",
    sourceLinks: [{
      label: "Discord セッション投稿",
      url: "https://discord.com/channels/1/2/3",
    }],
  });
  const link = firstNode(rendered, (node) => node.tag === "a");
  assert.equal(link?.href, "https://discord.com/channels/1/2/3");
  assert.equal(link?.target, "_blank");
  assert.equal(link?.rel, "noopener noreferrer");
  assert.equal(flatten(rendered).includes("Discord セッション投稿"), true);
});

test("the PR detail presents body text as an independent PR content section", () => {
  const rendered = renderOverview({
    repository: "LUDIARS/Revisor",
    number: 262,
    title: "PR 内容を表示する",
    status: "open",
    checkStatus: "queued",
    author: "local",
    headRef: "feat/pr-content",
    baseRef: "main",
    headSha: "a".repeat(40),
    reviewedHeadSha: null,
    baseSha: "b".repeat(40),
    labels: [],
    updatedAt: "2026-08-08T00:00:00.000Z",
    body: "## 実装内容\n- 表示する。\n\n## 受け入れ条件\n- 独立項目で読める。",
    sourceLinks: [],
  });
  assert.equal(flatten(rendered).includes("PR内容"), true);
  assert.equal(flatten(rendered).some((entry) => entry.includes("## 実装内容")), true);
});

test("a review recorded before test output was kept still renders its table", () => {
  const rendered = renderTests({
    ci: [
      { name: "unit", status: "failed", exitCode: 1, durationMs: 1000 },
      { name: "smoke", status: "skipped", reason: "変更種別を担当しません" },
    ],
  });
  const texts = flatten(rendered);
  assert.equal(texts.includes("unit"), true);
  assert.equal(texts.includes("失敗したテストの出力 (秘匿値はマスク済み)"), false);
});
