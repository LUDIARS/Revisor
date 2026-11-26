import { setTimeout as sleep } from "node:timers/promises";
import { isGitCommand } from "./git-runtime.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:6350268c */
import augurContract_25e6e448 from '../contracts/submodule-resolver-retry.contract.mjs'; /* augur-inject:contract-predicate:0f6cab1e */

const RESOLVER_START_FAILURE = "getaddrinfo() thread failed to start";
const RETRY_DELAYS_MS = [2_000, 8_000];

/** @implements SPEC-SUBMODULE-RESOLVER-RETRY */
export function submoduleRetryDelay(invocation, result, attempt, platform) {
  if (platform !== "win32" || !isGitCommand(invocation.command, { platform })) return null;
  if (invocation.args[0] !== "submodule" || invocation.args[1] !== "update") return null;
  if (!Number.isInteger(result.exitCode) || result.exitCode <= 0 || result.ok) return null;
  if (!result.stderr?.includes(RESOLVER_START_FAILURE)) return null;
  return RETRY_DELAYS_MS[attempt - 1] ?? null;
}
// @ts-expect-error augur-inject
submoduleRetryDelay = contract(submoduleRetryDelay, { ...augurContract_25e6e448, contractId: 'C-29', mode: 'observe', sample: 1, where: 'src/submodule-retry.mjs:8', rule: 'contract-wrap', id: '25e6e448' }); /* augur-inject:contract-wrap:25e6e448 */

/** @implements SPEC-SUBMODULE-RESOLVER-RETRY */
export async function runWithSubmoduleRetry(invocation, { execute, wait = sleep, platform }) {
  for (let attempt = 1; ; attempt += 1) {
    const result = await execute(invocation);
    const delay = submoduleRetryDelay(invocation, result, attempt, platform);
    if (delay === null) return result;
    // Re-running update resumes the same checkout after a failed clone. Give
    // the resolver time before starting another Git process in that checkout.
    await wait(delay);
  }
}
