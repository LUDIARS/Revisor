// One place that decides "what kind of change is this", so the review plan, the
// merge-risk score, and the runtime-verification judgement all reason about the
// same profile instead of each re-deriving it from raw paths.

const DOC_FILE = /\.(md|markdown|mdx|txt|adoc|rst)$/i;

// Settings text that carries no domain of its own. Deliberately narrower than the
// `config` change kind below: this list decides a gate relaxation, so it names the
// declarative formats and the well-known dotfiles only and contains no code
// extension — a `.js`/`.mjs`/`.ts`/`.py` file that happens to configure something
// is still code and still owes a target domain.
const CONFIG_FILE =
  /(?:^|\/)(?:\.env\.(?:example|sample|template)|\.editorconfig|\.gitignore|\.gitattributes|\.gitmodules|\.npmrc|\.nvmrc|\.dockerignore|\.eslintignore|\.prettierignore)$|\.(?:ya?ml|json|jsonc|json5|toml|ini|cfg|conf|properties)$/i;

// Dependency manifests match CONFIG_FILE by extension but are not settings text:
// editing them pulls third-party code into the build, which is the change class
// that should keep every gate it has. Excluded from the relaxation so a dependency
// bump still owes a target domain (neco 2026-07-30).
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

// Evaluated in order: the first match wins. Order matters more than the
// individual patterns — a lock file is generated before it is config, a
// workflow file is infrastructure before it is config, and a test file is a
// test before its extension makes it code.
const KIND_RULES = [
  {
    kind: "generated",
    pattern:
      /(?:^|\/)(?:dist|build|out|coverage|node_modules)\/|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.min\.(?:js|css)$/i,
  },
  {
    kind: "test",
    pattern:
      /(?:^|\/)(?:test|tests|__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$/i,
  },
  { kind: "docs", pattern: DOC_FILE },
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
      /(?:^|\/)\.[^/]+$|(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|jsconfig\.json)$|\.(?:json|ya?ml|toml|ini|cfg|properties|lock)$/i,
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
  return changedPaths.length > 0 && changedPaths.every((path) => DOC_FILE.test(path));
}

// Documentation and settings files have no code target domain to point at, so a
// change made only of them can never satisfy the target-domain gate: keeping the
// gate would make configuration changes permanently unmergeable (a one-line
// `excubitor.catalog.yaml` edit was blocked exactly this way, Genius#6). A single
// code file brings the requirement back — `every` is what makes that hold.
export function isDocsOrConfigOnlyChange(changedPaths) {
  return changedPaths.length > 0
    && changedPaths.every((path) =>
      !DEPENDENCY_MANIFEST.test(path)
      && !EXECUTABLE_CONFIG.test(path)
      && (DOC_FILE.test(path) || CONFIG_FILE.test(path)));
}

export function classifyChange({ changedPaths = [], unifiedDiff = "" } = {}) {
  const files = changedPaths.map((path) => ({
    path,
    kind: classifyPath(path),
    runtimeSurfaces: runtimeSurfacesOf(path),
  }));
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
    touchesSpec: changedPaths.some((path) => SPEC_FILE.test(path)),
    touchesTests: counts.test > 0,
    // A docs-only change carries no runtime surface even when a documentation
    // file happens to live under a `ui/` folder: nothing executable moved.
    runtimeSurfaces: isDocsOnlyChange(changedPaths)
      ? []
      : [...new Set(files.flatMap((file) => file.runtimeSurfaces))],
  };
}
