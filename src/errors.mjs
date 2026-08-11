export class RevisorError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RevisorError";
  }
}

// 現在の base の上へ載せ替えたら競合した。 Revisor は自動解決しないので、 提出元が
// 解消する必要がある。 返せるのは衝突したファイルの一覧まで
// (`spec/feature/review-diff-scope.md` 規則 3)。
export class MergeConflictError extends RevisorError {
  constructor(message, { conflictedPaths = [], ...options } = {}) {
    super(message, options);
    this.name = "MergeConflictError";
    this.conflictedPaths = conflictedPaths;
  }
}

// 審査後にヘッドの差分内容が変わった。新しい内容での再審査で解消できる。
// 自動再審査を対象ヘッド単位で数えて頭打ちにするため、判定に使ったヘッドを持つ。
/** @implements SPEC-STALE-REVIEW-REQUEUE */
export class StaleReviewError extends RevisorError {
  constructor(message, { headSha = null, ...options } = {}) {
    super(message, options);
    this.name = "StaleReviewError";
    this.headSha = headSha;
  }
}

// GitHub 側の base branch がローカル正本と独立に進んだ。ローカル base への
// 取り込み (reconcile) と再 squash で解消できる。
export class BaseMovedError extends RevisorError {
  constructor(message, options) {
    super(message, options);
    this.name = "BaseMovedError";
  }
}
