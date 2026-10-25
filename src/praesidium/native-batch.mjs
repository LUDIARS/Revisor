/** Two compiler workers share the original wall-clock scheduling budget; no unit is silently dropped. */
export async function analyzeNativeBatch(invocations, execute, now = Date.now) {
  const startedAt = now();
  const outcomes = new Array(invocations.length);
  let next = 0;
  async function worker() {
    while (next < invocations.length) {
      const index = next++;
      const invocation = invocations[index];
      if (now() - startedAt > 120_000) {
        outcomes[index] = { rule: "native.analysis-budget", file: invocation.file, status: "error" };
        continue;
      }
      let result;
      try { result = await execute(invocation.command, invocation.args, invocation.cwd); }
      catch { result = { ok: false, exitCode: null }; /* Execution failure is an explicit incomplete check. */ }
      outcomes[index] = { rule: "native.clang-analysis", file: invocation.file,
        status: result?.ok && !result.diagnostics ? "passed" : result?.exitCode == null ? "error" : "failed" };
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, invocations.length) }, () => worker()));
  return outcomes;
}
