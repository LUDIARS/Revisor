export default {
  post: (delay, [invocation, result, attempt, platform]) => {
    const git = /(?:^|[/\\])git(?:\.exe)?$/i.test(invocation.command);
    const submoduleUpdate = invocation.args.slice(0, 2).join(" ") === "submodule update";
    const resolverFailure = result.ok === false && Number.isInteger(result.exitCode)
      && result.exitCode > 0 && result.stderr?.includes("getaddrinfo() thread failed to start");
    const expected = platform === "win32" && git && submoduleUpdate && resolverFailure
      ? ({ 1: 2_000, 2: 8_000 })[attempt] ?? null
      : null;
    return delay === expected || "only the first two Windows submodule resolver startup failures may be retried";
  },
};
