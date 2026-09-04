// One place that decides "what kind of change is this", so the review plan, the
// merge-risk score, and the runtime-verification judgement all reason about the
// same profile instead of each re-deriving it from raw paths.

const DOC_FILE = /\.(md|markdown|mdx|txt|adoc|rst)$/i;

// Settings text that carries no domain of its own. Deliberately narrower than the
// `config` change kind below: this list decides a gate relaxation, so it names the
// declarative formats and the well-known dotfiles only and contains no code
// extension — a `.js`/`.mjs`/`.ts`/`.py` file that happens to configure something
// is still code and still owes a target domain.
//
// `.jsonl` sits with `.json` on purpose: JSON Lines is the same declarative family,
// and anchoring on `\.json$` silently left it out. The gap made an untracking chore
// unmergeable — deleting a generated `*.jsonl` index classified as code, so the
// change owed a target domain it could never have (Concordia#12).
const CONFIG_FILE =
  /(?:^|\/)(?:\.env\.(?:example|sample|template)|\.editorconfig|\.gitignore|\.gitattributes|\.gitmodules|\.npmrc|\.nvmrc|\.dockerignore|\.eslintignore|\.prettierignore)$|\.(?:ya?ml|json|jsonl|jsonc|json5|toml|ini|cfg|conf|properties)$/i;

// Dependency manifests match CONFIG_FILE by extension but are not settings text:
// editing them pulls third-party code into the build, so they are excluded from
// the narrow docs/config relaxation and keep its other risk signals. The broader
// non-code policy below still avoids inventing an application domain for them.
const DEPENDENCY_MANIFEST =
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|Cargo\.(?:toml|lock)|poetry\.lock|pyproject\.toml|requirements[^/]*\.txt|Gemfile(?:\.lock)?|composer\.(?:json|lock)|go\.(?:mod|sum))$/i;

// CI pipelines and compose files are YAML, so CONFIG_FILE matches them, but they
// are not settings text either: they describe what gets executed, with what
// credentials, on every push. That is the same reason dependency manifests are
// excluded — the file decides which code runs — and it is also what `KIND_RULES`
// below already encodes by classifying a workflow as `infra` before `config`.
// Without this the relaxation would be stricter about `Dockerfile` (no config
// extension, so never relaxed) than about the pipeline that runs it.
const EXECUTABLE_CONFIG =
  /(?:^|\/)(?:\.github\/workflows|\.circleci|\.gitlab)\/|(?:^|\/)(?:\.gitlab-ci|docker-compose[^/]*|azure-pipelines[^/]*|cloudbuild)\.ya?ml$/i;

// Declarative files under `spec/` and `.anatomia/` (domain definitions,
// ontology, layers, spec indexes). Only data formats: an `.mjs` domain def or
// a script under `spec/` still runs code and stays `code`.
const SPEC_DECLARATION_FILE =
  /(?:^|\/)(?:spec|\.anatomia)\/.*\.(?:json|jsonl|jsonc|json5|ya?ml|toml)$/i;

// Evaluated in order: the first match wins. Order matters more than the
// individual patterns — a lock file is generated before it is config, a
// workflow file is infrastructure before it is config, and a test file is a
// test before its extension makes it code.
const KIND_RULES = [
  {
    kind: "generated",
    // `report/` だけはリポジトリ直下に固定する。 他の生成物ディレクトリと違って
    // `report` は普通の語なので、 深さを問わず当てると手書きのソースを巻き込む
    // (Concordia の `src/report/generator.ts` が実在する)。 解析レポートの出力先は
    // 直下の `report/` という慣習なので、 そこだけを生成物として扱う。
    pattern:
      /(?:^|\/)(?:dist|build|out|coverage|node_modules)\/|^report\/|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.min\.(?:js|css)$/i,
  },
  {
    kind: "test",
    pattern:
      /(?:^|\/)(?:test|tests|__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$/i,
  },
  { kind: "docs", pattern: DOC_FILE },
  // Declarative spec files (domain definitions, ontology, spec indexes) are
  // documentation of the product, not settings that change what runs. Before
  // this rule their `.json`/`.yaml` extension put them under `config`, which
  // counts as executable change — a domain-declaration-only PR then paid for
  // the repository's full cold build and timed out (Memoria #1221).
  { kind: "docs", pattern: SPEC_DECLARATION_FILE },
  {
    kind: "infra",
    pattern:
      /(?:^|\/)(?:\.github\/workflows|migrations?|deploy|infra|terraform|charts?)\/|(?:^|\/)(?:Dockerfile|docker-compose[^/]*\.ya?ml|Makefile)$|\.(?:tf|tfvars|sql|ps1|sh|bat|cmd)$/i,
  },
  {
    kind: "asset",
    pattern:
      /\.(?:png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|mp4|webm|ttf|otf|woff2?|glb|gltf|fbx|psd|blend|zip|tar|gz|7z)$/i,
  },
  {
    kind: "config",
    pattern:
      /(?:^|\/)\.[^/]+$|(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|jsconfig\.json)$|\.(?:json|jsonl|ya?ml|toml|ini|cfg|properties|lock)$/i,
  },
];

// Surfaces that a registered unit test cannot stand in for: a human has to run
// the product to know the change works.
const RUNTIME_SURFACE_RULES = [
  {
    surface: "migration",
    pattern: /(?:^|\/)migrations?\/|\.sql$|(?:^|\/)schema\.(?:prisma|sql|graphql)$/i,
  },
  {
    surface: "entrypoint",
    pattern:
      /(?:^|\/)(?:server|main|app|cli|index|bootstrap|worker-entry)\.[cm]?[jt]sx?$|(?:^|\/)bin\//i,
  },
  {
    surface: "ui",
    pattern:
      /(?:^|\/)ui-[^/]+\.[cm]?[jt]sx?$|(?:^|\/)(?:ui|views?|pages?|components?|screens?)\/|\.(?:html|css|scss|vue|svelte)$/i,
  },
  {
    surface: "infra",
    pattern:
      /(?:^|\/)(?:\.github\/workflows|deploy|infra|terraform|charts?)\/|(?:^|\/)(?:Dockerfile|docker-compose[^/]*\.ya?ml)$|\.(?:tf|ps1|sh)$/i,
  },
];

const SPEC_FILE = /(?:^|\/)spec\//i;

export const CHANGE_KINDS = ["code", "docs", "test", "config", "infra", "asset", "generated"];

export function classifyPath(path) {
  for (const rule of KIND_RULES) {
    if (rule.pattern.test(path)) return rule.kind;
  }
  return "code";
}

function runtimeSurfacesOf(path) {
  return RUNTIME_SURFACE_RULES
    .filter((rule) => rule.pattern.test(path))
    .map((rule) => rule.surface);
}

// Counts only body lines: `+++`/`---` are file headers, not content, and a diff
// that counted them would inflate the size factor by two per changed file. Git
// always writes the path after a space, so the space is part of the match: a
// removed `---` line — a Markdown rule or front-matter fence, of which this
// repository has many — arrives as `----` and is content, not a header.
const DIFF_FILE_HEADER = /^(?:\+\+\+|---) /;

export function diffLineStats(unifiedDiff) {
  let added = 0;
  let removed = 0;
  if (typeof unifiedDiff !== "string") return { added, removed, changedLines: 0 };
  for (const line of unifiedDiff.split(/\r?\n/)) {
    if (DIFF_FILE_HEADER.test(line)) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed, changedLines: added + removed };
}

export function isDocsOnlyChange(changedPaths) {
  return changedPaths.length > 0 && changedPaths.every((path) =>
    DOC_FILE.test(path) || classifyPath(path) === "docs");
}

// Documentation and settings files have no code target domain to point at, so a
// change made only of them can never satisfy the target-domain gate: keeping the
// gate would make configuration changes permanently unmergeable (a one-line
// `excubitor.catalog.yaml` edit was blocked exactly this way, Genius#6). A single
// executable file removes this narrow relaxation — `every` is what makes that
// hold. Application-domain applicability is decided separately from change kinds.
export function isDocsOrConfigOnlyChange(changedPaths) {
  return changedPaths.length > 0
    && changedPaths.every((path) =>
      !DEPENDENCY_MANIFEST.test(path)
      && !EXECUTABLE_CONFIG.test(path)
      && (DOC_FILE.test(path) || CONFIG_FILE.test(path)));
}

/**
 * 依存の更新だけで構成された変更。
 *
 * ソースが 1 行も動いていないので Anatomia の解析対象 (anchor / ドメイン) が
 * 変わらない。 一方で**脆弱性診断と登録テストは最も必要な場面**でもある —
 * 依存を上げてビルドが壊れる・既知の脆弱性が入る、がまさにこの形の変更で起きる。
 * 「実行コードを含む / 含まない」の二分では両方を同じ扱いにしてしまうため、
 * 独立した profile として持つ。
 */
export function isDependencyOnlyChange(changedPaths) {
  return changedPaths.length > 0 && changedPaths.every((path) => DEPENDENCY_MANIFEST.test(path));
}

export function classifyChange({ changedPaths = [], unifiedDiff = "" } = {}) {
  const files = changedPaths.map((path) => {
    const kind = classifyPath(path);
    return {
      path,
      kind,
      // Generated output can have an executable-looking filename (for example,
      // `report/*.html` or `dist/server.js`) without being a product surface a
      // human must exercise. The source that produces it owns that obligation.
      runtimeSurfaces: kind === "generated" ? [] : runtimeSurfacesOf(path),
    };
  });
  const counts = {};
  for (const file of files) counts[file.kind] = (counts[file.kind] ?? 0) + 1;
  const kinds = CHANGE_KINDS.filter((kind) => counts[kind] > 0);
  const stats = diffLineStats(unifiedDiff);
  return {
    files,
    kinds,
    counts,
    changedFiles: files.length,
    ...stats,
    docsOnly: isDocsOnlyChange(changedPaths),
    docsOrConfigOnly: isDocsOrConfigOnlyChange(changedPaths),
    dependencyOnly: isDependencyOnlyChange(changedPaths),
    // Anatomia domains describe production behaviour. Tests, operational
    // manifests, documentation and generated assets may contain parseable
    // functions, but assigning those helpers to an application domain invents
    // ownership that the product does not have.
    codeDomainRequired: (counts.code ?? 0) > 0,
    touchesSpec: changedPaths.some((path) => SPEC_FILE.test(path)),
    touchesTests: counts.test > 0,
    // A docs-only change carries no runtime surface even when a documentation
    // file happens to live under a `ui/` folder: nothing executable moved.
    runtimeSurfaces: isDocsOnlyChange(changedPaths)
      ? []
      : [...new Set(files.flatMap((file) => file.runtimeSurfaces))],
  };
}
