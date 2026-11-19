export default {
  post: (result) => {
    const index = result.findIndex((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));
    if (index === -1) return "a model argument is required before launch";
    const arg = result[index];
    const model = arg.startsWith("--model=") ? arg.slice(8) : result[index + 1];
    return (typeof model === "string" && !/^(?:astra|sol|luna)(?:\[\d+[km]\])?$/.test(model))
      || "the model argument must contain a resolved identifier";
  },
};
