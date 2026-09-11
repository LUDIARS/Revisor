export default {
  pre: (input) => Array.isArray(input?.targets) || "targets is an array",
  post: (result) => Array.isArray(result) || "delivery result is an array",
};
