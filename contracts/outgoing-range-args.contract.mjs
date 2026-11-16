const ZERO_SHA = /^0+$/;

export default {
  post: (result, record, remotes = []) => {
    if (!Array.isArray(result) || result.length === 0) return "range must be a non-empty argument list";
    if (!ZERO_SHA.test(record.remoteSha)) {
      return (result.length === 1 && result[0] === `${record.remoteSha}..${record.localSha}`)
        || "existing ref updates must keep the remoteSha..localSha range";
    }
    if (result[0] !== record.localSha) return "new refs must start from the pushed commit";
    const expected = remotes.length > 0 ? ["--not", ...remotes.map(name => `--remotes=${name}`)] : [];
    return JSON.stringify(result.slice(1)) === JSON.stringify(expected)
      || "new refs exclude only the destination remote-tracking history, else scan everything";
  },
};
