export default {
  post: (role, value) => {
    if (value === "" || value === "opus" || value === "sol") return role === value;
    if (typeof value === "string" && /^gpt-\d+(?:\.\d+)*-sol$/.test(value)) return role === "sol";
    return role === null;
  },
};
