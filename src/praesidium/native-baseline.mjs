/** @implements RV-PRAESIDIUM-05 — the Revisor-owned baseline every analyzed C/C++ unit is compiled against. */
import { fileURLToPath } from "node:url";

// Shipped with Revisor, never read from the reviewed repository: the running Revisor's
// copy is the one force-included, so a PR cannot weaken the baseline it is checked with.
// It is an analysis input only; product builds follow AIFormat's LudiarsCxxBaseline.
export const NATIVE_BASELINE_HEADER = fileURLToPath(new URL("./native/include/praesidium/baseline.h", import.meta.url));

// The diagnostics pass. `--analyze` cannot carry these (the driver adds `-w`).
// -Wformat=2 adds non-literal and insecure format strings, -Wvla stack arrays sized at run
// time, -Wnull-dereference provable null dereferences; none fired on Odeum's 70 units that
// build without host packages. -Wextra's missing-field-initializers is off: a partially
// braced aggregate zero-initializes the rest, so it is style, not a defect, and it was the
// only warning those units raised.
export const NATIVE_WARNINGS = Object.freeze(["-Wall", "-Wextra", "-Wno-missing-field-initializers",
  "-Wformat=2", "-Wvla", "-Wnull-dereference", "-Werror"]);

// `-include` applies the baseline before the unit's first line. A C++20 module unit must
// open with its module declaration, so nothing can be force-included ahead of it; its
// policy rules still apply.
export function nativeBaselineArguments({ module = false } = {}) {
  return module ? [] : ["-include", NATIVE_BASELINE_HEADER];
}
