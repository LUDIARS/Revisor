/**
 * `revisor version services <service...>` — 名指ししたサービスの版を答える。
 *
 * HTTP 経由 (`GET /v1/service-versions`) ではなくローカルで解決する。 「版を知りたい」
 * のは多くの場合サービスがおかしいときで、 Revisor 本体が落ちていたら答えが返らない
 * 作りでは肝心の場面で使えない。 health の到達可否はここでも個別に測るので、
 * Revisor が止まっていても他サービスの版は答えられる。
 */

import { createReviewContext } from "./review-context.mjs";
import { ReleaseService } from "./release-service.mjs";
import { collectServiceVersions, formatServiceVersionLine } from "./service-version.mjs";

function selectors(args) {
  return args.slice(2).filter((value) => !value.startsWith("--"));
}

function renderText(results) {
  return results.flatMap((result) => result.found
    ? result.services.map((service) => formatServiceVersionLine(service))
    : [`${result.requested}: not registered in Excubitor`]).join("\n");
}

export async function runServiceVersionCommand(args, {
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  createContext = createReviewContext,
  fetchImpl = fetch,
} = {}) {
  if (args[0] !== "version" || args[1] !== "services") return null;
  const context = createContext({ cwd, env });
  const releases = new ReleaseService({
    store: context.store,
    env,
    publicationCoordinator: context.publicationCoordinator,
  });
  const results = await collectServiceVersions(selectors(args), {
    cwd,
    repositories: context.store.listRepositories(),
    releaseState: (repository) => releases.releaseState(repository),
    fetchImpl,
  });
  stdout.write(args.includes("--json")
    ? `${JSON.stringify({ versions: results }, null, 2)}\n`
    : `${renderText(results)}\n`);
  return 0;
}
