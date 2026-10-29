const COMPILED = new Set(["native.clang-analysis", "native.analysis-budget"]);

export default {
  pre: (_root, sources, units, _execute, options) => (Array.isArray(sources) && Array.isArray(units)
    && (options?.changed == null || options.changed instanceof Set))
    || "sources and units are arrays; the changed set is absent or a Set",
  post: (result, _root, _sources, _units, _execute, options) => (Array.isArray(result)
    && result.filter(check => COMPILED.has(check.rule)).length <= 256
    && (options?.changed == null
      || result.every(check => !COMPILED.has(check.rule) || options.changed.has(check.file))))
    || "at most 256 units are analyzed and a changed set restricts compilation to changed units",
};
