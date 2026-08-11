import { RevisorError } from "./errors.mjs";

/**
 * リポジトリごとの「公開ワークフロー」の解決だけを持つ。
 *
 * org ごとに公開経路が違う。 LUDIARS は GitHub App + Release 管理 (Revisor
 * Workflow)、 MELPOT は全 private で通常 push が通る (GitHub Workflow)。 publisher
 * が一本だと後者は App 未インストールで保留に落ちるしかないため、 どちらの経路で
 * 送るかを登録情報として持つ (`spec/plan/workflow-selection-design.md` §1.1)。
 *
 * 優先順は リポ個別指定 > org 既定 (`REVISOR_ORG_WORKFLOWS`) > グローバル既定
 * ("revisor")。 既定が "revisor" なので、 何も指定しない既存登録の挙動は不変。
 */

export const WORKFLOW_REVISOR = "revisor";
export const WORKFLOW_GITHUB = "github";
export const REPOSITORY_WORKFLOWS = [WORKFLOW_REVISOR, WORKFLOW_GITHUB];
export const DEFAULT_REPOSITORY_WORKFLOW = WORKFLOW_REVISOR;

const ORG = /^[A-Za-z0-9_.-]+$/;

export function isRepositoryWorkflow(value) {
  return REPOSITORY_WORKFLOWS.includes(value);
}

export function assertRepositoryWorkflow(value, label = "workflow") {
  if (!isRepositoryWorkflow(value)) {
    throw new RevisorError(
      `${label} must be one of ${REPOSITORY_WORKFLOWS.join(", ")}.`,
    );
  }
  return value;
}

export function repositoryOrganization(repository) {
  const owner = String(repository ?? "").split("/")[0];
  return owner || null;
}

/**
 * `REVISOR_ORG_WORKFLOWS` を読む。 書式は `MELPOT=github`。 複数指定はカンマ /
 * セミコロン / 空白区切り。
 *
 * 誤記は握り潰さない。 黙って既定 ("revisor") へ落とすと、 MELPOT の公開が理由の
 * 見えないまま保留され続けるため、 設定エラーとしてその場で投げる。
 *
 * @returns {Map<string, string>} 小文字化した org 名 → workflow
 */
export function parseOrgWorkflows(value) {
  const pairs = new Map();
  for (const entry of String(value ?? "").split(/[,;\s]+/).filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      throw new RevisorError(
        `REVISOR_ORG_WORKFLOWS entry '${entry}' must be written as <org>=<workflow>.`,
      );
    }
    const org = entry.slice(0, separator).trim();
    const workflow = entry.slice(separator + 1).trim();
    if (!ORG.test(org)) {
      throw new RevisorError(`REVISOR_ORG_WORKFLOWS entry '${entry}' has an invalid organization.`);
    }
    assertRepositoryWorkflow(workflow, `REVISOR_ORG_WORKFLOWS entry '${entry}'`);
    pairs.set(org.toLowerCase(), workflow);
  }
  return pairs;
}

export function readOrgWorkflows(env = process.env) {
  return parseOrgWorkflows(env?.REVISOR_ORG_WORKFLOWS);
}

/**
 * @param {{ repository: string, workflow?: string }} repository 登録リポジトリ
 * @param {Record<string, string|undefined>} env
 * @returns {"revisor" | "github"}
 */
export function resolveRepositoryWorkflow(repository, env = process.env) {
  const explicit = repository?.workflow;
  if (explicit !== undefined && explicit !== null) {
    return assertRepositoryWorkflow(explicit, `${repository?.repository ?? "repository"} workflow`);
  }
  const org = repositoryOrganization(repository?.repository);
  if (!org) return DEFAULT_REPOSITORY_WORKFLOW;
  return readOrgWorkflows(env).get(org.toLowerCase()) ?? DEFAULT_REPOSITORY_WORKFLOW;
}
