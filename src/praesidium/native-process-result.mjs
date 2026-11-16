/** Preserve actionable compiler failure evidence without retaining raw secret-bearing output. */
import { captureFailedTestOutput } from "../test-output.mjs";

export function nativeProcessResult(error, stdout = "", stderr = "") {
  const diagnostics = /\b(?:warning|error):/.test(`${stdout}\n${stderr}`);
  const result = { ok: !error,
    exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
    diagnostics };
  if (!error && !diagnostics) return result;
  // execFile reports both timeout and an external kill as killed+signal. Do not
  // claim a timeout conclusively when the process API cannot distinguish them.
  result.reason = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit"
    : error?.killed ? "terminated"
    : error?.code === "ENOENT" ? "compiler-unavailable"
    : error ? "compiler-failed" : "compiler-diagnostics";
  const output = captureFailedTestOutput({ stdout, stderr });
  if (output) result.output = output;
  return result;
}
