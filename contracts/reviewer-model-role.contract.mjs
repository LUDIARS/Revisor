const expected = {
  review: { "claude-opus": "opus", "codex-sol": "sol" },
  auxiliary: { "claude-opus": "sonnet", "codex-sol": "luna" },
};

export default {
  post: (role, reviewer, purpose = "review") => role === expected[purpose]?.[reviewer]
    || "reviewer and purpose must select their designated role",
};
