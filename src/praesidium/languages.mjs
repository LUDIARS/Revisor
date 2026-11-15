/** @implements RV-PRAESIDIUM-01, RV-PRAESIDIUM-03 — one definition of which files are native or script sources. */

// Each native translation unit is compiled with an explicit `-x` language: clang does
// not infer every extension (it takes `.ixx` for a linker input and would analyze
// nothing), so the extension alone must never decide whether analysis happens.
// The first matching row decides. The uppercase `.C` and `.M` are either language
// (`either` names the C one): clang and GCC compile them as C++ and Objective-C++, but
// MSVC and DOS-era code compile `.C` as C. So the policy rules read them in every lexical
// reading, like headers, and a configured one is compiled in the language of its declared
// standard (unitLanguage).
const NATIVE = [
  { pattern: /\.c$/, language: "c", unit: true },
  { pattern: /\.C$/, language: "c++", either: "c", unit: true },
  { pattern: /\.(?:cc|cpp|cxx|c\+\+)$/i, language: "c++", unit: true },
  // C++20 module units, in every toolchain's spelling. They are analyzed as plain C++:
  // `-x c++-module` makes clang precompile the unit and then analyze the resulting PCM,
  // which reports nothing. Their module declaration must open the file, so nothing can
  // be force-included ahead of it.
  { pattern: /\.(?:cppm|ixx|mpp|ccm|cxxm|c\+\+m)$/i, language: "c++", unit: true, module: true },
  // Objective-C/C++ needs the platform SDK, so its analysis is opt-in (RV-PRAESIDIUM-03).
  { pattern: /\.m$/, language: "objective-c", unit: true, platform: true },
  { pattern: /\.M$/, language: "objective-c++", either: "objective-c", unit: true, platform: true },
  { pattern: /\.mm$/i, language: "objective-c++", unit: true, platform: true },
  { pattern: /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|tcc)$/i, language: "header", unit: false },
  // Fragments spliced into a unit by #include (LLVM-style .inc/.def bodies, X-macro
  // tables): lexed like headers, but not self-contained, so never compiled as a main file;
  // a changed one is analyzed through the units that include it. `.inc` is also PHP,
  // assembler and Pascal, so a fragment is policy-scanned only where an analyzed unit's
  // compiler reads it (native-dependencies.mjs), never collected as a policy source.
  { pattern: /\.(?:inc|def)$/i, language: "header", unit: false, fragment: true },
];
const SCRIPT = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i;

export function nativeLanguage(file) {
  if (typeof file !== "string") return null;
  return NATIVE.find(({ pattern }) => pattern.test(file)) ?? null;
}

export const isNativeSource = (file) => nativeLanguage(file) !== null;
export const isTranslationUnit = (file) => nativeLanguage(file)?.unit === true;
export const isNativeHeader = (file) => nativeLanguage(file)?.unit === false && !isNativeFragment(file);
export const isNativeFragment = (file) => nativeLanguage(file)?.fragment === true;
// A unit whose analysis needs a platform SDK the inspection host may not have.
export const isPlatformUnit = (file) => nativeLanguage(file)?.platform === true;
export const isModuleUnit = (file) => nativeLanguage(file)?.module === true;
export const isScriptSource = (file) => typeof file === "string" && SCRIPT.test(file);
export const isPolicySource = (file) => (isNativeSource(file) && !isNativeFragment(file)) || isScriptSource(file);
// C or Objective-C by the extension alone; `.C` and `.M` are not (isEitherLanguageUnit).
export const isCLanguageUnit = (file) => ["c", "objective-c"].includes(nativeLanguage(file)?.language);
// A `.C` or `.M`, which a C standard makes C or Objective-C and a C++ standard C++ or
// Objective-C++. Where only its name is known, it counts as both.
export const isEitherLanguageUnit = (file) => typeof nativeLanguage(file)?.either === "string";
// The language a translation unit is compiled in; `c` says its declared standard is a C
// one, which decides only for `.C` and `.M`.
export function unitLanguage(file, c) {
  const row = nativeLanguage(file);
  return row?.either && c ? row.either : row?.language;
}
