import { readWorkflowToken } from "./config.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:ac1db2b7 */
import augurContract_2795a9f2 from '../contracts/workflow-authorization-headers.contract.mjs'; /* augur-inject:contract-predicate:d0fde43d */

// Mutating requests to the local Revisor API (anything but a loopback GET) must carry
// the workflow token that server.mjs checks. CLI commands that talk to the running
// service over HTTP resolve it from the same encrypted local config the service reads,
// so no secret is passed on the command line or printed.
function missingTokenMessage(error) {
  const reason = /could not be decrypted/.test(String(error?.message))
    ? "Revisor のローカル設定にある workflow トークンを復号できません (鍵ファイルが設定と対応していない可能性があります)"
    : "Revisor のローカル設定に workflow トークンが設定されていません";
  return `${reason}。常駐中の Revisor と同じ設定 (REVISOR_CONFIG_PATH / REVISOR_KEY_PATH) を参照する環境で実行するか、`
    + "Revisor の設定画面で workflow トークンを設定してから再実行してください。";
}

export function workflowAuthorizationHeaders(env = process.env, readToken = readWorkflowToken) {
  let token;
  try {
    token = readToken(env);
  } catch (error) {
    throw new Error(missingTokenMessage(error));
  }
  return { authorization: `Bearer ${token}` };
}
// @ts-expect-error augur-inject
workflowAuthorizationHeaders = contract(workflowAuthorizationHeaders, { ...augurContract_2795a9f2, contractId: 'C-22', mode: 'observe', sample: 1, where: 'src/workflow-authorization.mjs:15', rule: 'contract-wrap', id: '2795a9f2' }); /* augur-inject:contract-wrap:2795a9f2 */
