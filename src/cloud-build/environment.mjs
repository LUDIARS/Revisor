// The execution environment is part of what a result proves: a Linux build
// says nothing about Windows/MSVC, so every field the request names must match.
const OS_VALUES = new Set(["windows", "linux", "macos"]);

export function parseEnvironment(value, label = "environment") {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object.`);
  if (!OS_VALUES.has(value.os)) throw new Error(`${label}.os must be one of windows, linux, macos.`);
  if (typeof value.arch !== "string" || !/^[a-z0-9_]{2,16}$/.test(value.arch)) {
    throw new Error(`${label}.arch is invalid.`);
  }
  const toolchain = value.toolchain;
  if (!toolchain || typeof toolchain.name !== "string" || !toolchain.name.trim()
    || typeof toolchain.version !== "string" || !toolchain.version.trim()) {
    throw new Error(`${label}.toolchain needs name and version.`);
  }
  if (value.cmake !== undefined && (typeof value.cmake !== "string" || !value.cmake.trim())) {
    throw new Error(`${label}.cmake must be a non-empty string.`);
  }
  return {
    os: value.os,
    arch: value.arch,
    toolchain: { name: toolchain.name.trim(), version: toolchain.version.trim() },
    ...(value.cmake === undefined ? {} : { cmake: value.cmake.trim() }),
  };
}

export function environmentMismatches(required, actual) {
  const mismatches = [];
  if (required.os !== actual.os) mismatches.push("os");
  if (required.arch !== actual.arch) mismatches.push("arch");
  if (required.toolchain.name.toLowerCase() !== actual.toolchain.name.toLowerCase()) mismatches.push("toolchain.name");
  if (required.toolchain.version !== actual.toolchain.version) mismatches.push("toolchain.version");
  if (required.cmake !== undefined && required.cmake !== actual.cmake) mismatches.push("cmake");
  return mismatches;
}
