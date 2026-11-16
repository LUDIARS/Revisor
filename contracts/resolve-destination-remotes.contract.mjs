const SAFE_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

export default {
  post: (result) => (Array.isArray(result) && result.every(name => SAFE_REMOTE.test(name)))
    || "destination remotes must be configured remote names safe for --remotes",
};
