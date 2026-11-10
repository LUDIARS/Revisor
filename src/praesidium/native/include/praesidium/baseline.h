/* Praesidium analysis baseline (RV-PRAESIDIUM-05).
 *
 * Revisor force-includes this header into every pass of every C/C++ unit Praesidium
 * analyzes. It is an analysis input, not a product header: product builds take their
 * hardening and warnings from AIFormat's LudiarsCxxBaseline.cmake (RULE_CODE_CPP §C2.9,
 * §C4.2).
 *
 * It declares the unbounded C APIs that Praesidium rejects (NATIVE_REJECTED_APIS in
 * src/praesidium/rules.mjs) as deprecated, so the -Werror diagnostics pass rejects every
 * use the syntactic rule cannot see: through a macro, a -D alias, std:: qualification,
 * parentheses or a function pointer. gets() is absent: C11 and C++14 removed it, so it is
 * undeclared. Bounded replacements: snprintf/vsnprintf.
 *
 * It reads nothing before its declarations. An #include here would search the unit's
 * repository -I directories first, so a repository file named like a standard header
 * would run inside the baseline and could rename or skip what follows; it would also
 * define library macros and select library features before the unit's own first line.
 * The declarations therefore use compiler-builtin types only, come before the C
 * library's, and match its exception specification, so the library's later declaration
 * is compatible and inherits the attribute. Every macro defined here is #undef'd at the
 * end and `#pragma once` replaces a guard macro, so no `#if` can tell analysis from the
 * product build by a macro of the baseline. (In C++ the six declarations themselves stay
 * visible to name lookup; RV-PRAESIDIUM-03 lists that gap.)
 *
 * Windows is left to the UCRT, which already deprecates these functions (C4996,
 * -Wdeprecated-declarations): it declares some dllimport and defines sprintf/vsprintf
 * inline, and an attribute added after a definition is ignored. A unit that defines
 * _CRT_SECURE_NO_WARNINGS turns the UCRT deprecations off; Praesidium's syntactic rule
 * still rejects direct calls there.
 */
#pragma once
#if !defined(_WIN32)
#if defined(__cplusplus)
#define PRAESIDIUM_UNSAFE(reason) [[__deprecated__("Praesidium: " reason)]]
#define PRAESIDIUM_WCHAR wchar_t
#else
#define PRAESIDIUM_UNSAFE(reason) __attribute__((__deprecated__("Praesidium: " reason)))
/* The type glibc's and Apple's <stddef.h> typedef wchar_t from. */
#define PRAESIDIUM_WCHAR __WCHAR_TYPE__
#endif
/* glibc declares these functions noexcept(true) in C++ (its __THROW), and a declaration
 * placed first must carry the same exception specification as the library's later one:
 * a mismatch is a hard error in either order. features.h, which defines __GLIBC__, has
 * not run yet, so glibc is recognized by a header only it ships, without reading it.
 * musl, Apple's libc and the BSD libcs declare no exception specification; a C library
 * that does and is not recognized here makes every unit fail to compile (fail closed). */
#define PRAESIDIUM_NOTHROW
#if defined(__cplusplus) && defined(__has_include)
#if __has_include(<gnu/libc-version.h>)
#undef PRAESIDIUM_NOTHROW
#define PRAESIDIUM_NOTHROW noexcept(true)
#endif
#endif
/* An object-like macro (for example -Dsprintf=...) must not rename the API away. */
#undef strcpy
#undef strcat
#undef sprintf
#undef vsprintf
#undef wcscpy
#undef wcscat
/* Spelled through a macro so that no declaration reads like the call Praesidium's
 * syntactic rule rejects: `strcpy(` here would be a declaration, not a use. */
#define PRAESIDIUM_DECLARE_UNSAFE(type, name, parameters, reason) \
  PRAESIDIUM_UNSAFE(reason) type name parameters PRAESIDIUM_NOTHROW;
#if defined(__cplusplus)
extern "C" {
#endif
PRAESIDIUM_DECLARE_UNSAFE(char*, strcpy, (char* __restrict, const char* __restrict),
                          "unbounded copy; use a bounded copy such as snprintf")
PRAESIDIUM_DECLARE_UNSAFE(char*, strcat, (char* __restrict, const char* __restrict),
                          "unbounded concatenation; use a bounded copy such as snprintf")
PRAESIDIUM_DECLARE_UNSAFE(int, sprintf, (char* __restrict, const char* __restrict, ...),
                          "unbounded format; use snprintf")
PRAESIDIUM_DECLARE_UNSAFE(int, vsprintf, (char* __restrict, const char* __restrict, __builtin_va_list),
                          "unbounded format; use vsnprintf")
PRAESIDIUM_DECLARE_UNSAFE(PRAESIDIUM_WCHAR*, wcscpy, (PRAESIDIUM_WCHAR* __restrict, const PRAESIDIUM_WCHAR* __restrict),
                          "unbounded copy; use a bounded copy such as snprintf")
PRAESIDIUM_DECLARE_UNSAFE(PRAESIDIUM_WCHAR*, wcscat, (PRAESIDIUM_WCHAR* __restrict, const PRAESIDIUM_WCHAR* __restrict),
                          "unbounded concatenation; use a bounded copy such as snprintf")
#if defined(__cplusplus)
}
/* clang attaches the attribute to std:: names only through these re-exports; the
 * standard library's <cstring>, <cstdio> and <cwchar> later repeat them, which is valid. */
namespace std {
using ::strcpy;
using ::strcat;
using ::sprintf;
using ::vsprintf;
using ::wcscpy;
using ::wcscat;
}
#endif
#undef PRAESIDIUM_DECLARE_UNSAFE
#undef PRAESIDIUM_NOTHROW
#undef PRAESIDIUM_WCHAR
#undef PRAESIDIUM_UNSAFE
#endif
