const tailsByRepository = new Map();

/**
 * Serialize Git worktree add/remove/prune operations for one source repository.
 *
 * Review stages run in detached disposable worktrees and may run concurrently.
 * Their setup and cleanup, however, change the source repository's shared
 * worktree metadata.  This small keyed mutex keeps those Git mutations ordered
 * while allowing different registered repositories to prepare in parallel.
 */
export async function withWorktreeMutationLock(repositoryPath, operation) {
  if (typeof repositoryPath !== "string" || !repositoryPath) {
    throw new TypeError("Worktree mutation lock requires a repository path.");
  }
  if (typeof operation !== "function") {
    throw new TypeError("Worktree mutation lock requires an operation.");
  }
  const previous = tailsByRepository.get(repositoryPath) ?? Promise.resolve();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => held);
  tailsByRepository.set(repositoryPath, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (tailsByRepository.get(repositoryPath) === tail) {
      tailsByRepository.delete(repositoryPath);
    }
  }
}
