import assert from "node:assert/strict";
import test from "node:test";
import { renderDashboardPage } from "../src/ui-dashboard-page.mjs";
import { renderSettingsPage } from "../src/ui-settings-page.mjs";
import {
  isAllowedHost,
  isAuthorizedSession,
  isLoopbackHost,
} from "../src/ui-security.mjs";

test("the dashboard leads with the PRs waiting on a human", () => {
  const page = renderDashboardPage("session-nonce");
  assert.match(page, /<h1>Revisor<\/h1>/);
  assert.match(page, /LUDIARS LOCAL PR WORKFLOW/);
  assert.ok(page.indexOf("<h2>PR の判断待ち</h2>") >= 0);
  assert.ok(page.indexOf("<h2>PR の判断待ち</h2>") < page.indexOf("<h2>登録プロジェクト</h2>"));
  assert.match(page, /判断が必要なものだけ表示/);
  assert.match(page, /Open \/ Test OK/);
  assert.match(page, /nonce="session-nonce"/);
});

test("the dashboard exposes decision, plan, test, review and diff analysis detail", () => {
  const page = renderDashboardPage("session-nonce");
  assert.match(page, /選択した PR の詳細/);
  assert.match(page, /block\('判断', decisionOf\(pr\)\)/);
  assert.match(page, /block\('レビュー計画', planOf\(pr\.reviewPlan\)\)/);
  assert.match(page, /block\('テスト', testsOf\(pr\)\)/);
  assert.match(page, /block\('レビュー', reviewOf\(pr\)\)/);
  assert.match(page, /block\('差分解析 \(Anatomia\)', analysisOf\(pr\)\)/);
  assert.match(page, /selectedPrId = id/);
  assert.match(page, /runAction\(retry, pr\.id, 'retry'\)/);
});

test("the dashboard renders PRs as cards and keeps the risk badge in the card head", () => {
  const page = renderDashboardPage("session-nonce");
  assert.match(page, /class="cards" id="pr-cards"/);
  assert.match(page, /badge\(pr\.decision\.label, pr\.decision\.tone\)/);
  assert.match(page, /decision\.riskScore \+ ' \/ 閾値 ' \+ decision\.riskThreshold/);
  assert.match(page, /@media \(max-width: 700px\)/);
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
  assert.match(page, /並列ワーカープロセス数/);
  assert.match(page, /許可Host/);
  assert.match(page, /暗号化config/);
  assert.match(page, /プロダクト登録/);
  assert.doesNotMatch(page, /GitHub App ID/);
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

test("limits settings access to loopback and the UI session", () => {
  assert.equal(isLoopbackHost("127.0.0.1:4240"), true);
  assert.equal(isLoopbackHost("localhost:4240"), true);
  assert.equal(isLoopbackHost("review.example.com"), false);
  assert.equal(isAllowedHost("review.example.com:443", ["review.example.com"]), true);
  assert.equal(isAllowedHost("other.example.com", ["review.example.com"]), false);
  assert.equal(isAuthorizedSession({ "x-revisor-session": "a" }, "a"), true);
  assert.equal(isAuthorizedSession({ "x-revisor-session": "b" }, "a"), false);
});
