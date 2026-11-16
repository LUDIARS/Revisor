import { git } from "./workspace.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:d115dba7 */
import augurContract_7b291ec7 from '../contracts/resolve-destination-remotes.contract.mjs'; /* augur-inject:contract-predicate:85641dbe */

// Names are later expanded as `--remotes=<name>` globs, so glob metacharacters
// and option-looking names are never accepted.
const SAFE_REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

// Reduces https, ssh:// and scp-style URLs to "host/path" without credentials,
// a trailing slash or ".git", so equivalent spellings of one remote compare equal.
export function normalizeRemoteUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  let location = null;
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    location = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const url = new URL(text);
      if (!url.host) return null;
      location = `${url.host}${url.pathname}`;
    } catch {
      return null;
    }
  }
  return location.toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

async function remoteUrls(repoPath, name) {
  const urls = new Set();
  for (const args of [["remote", "get-url", "--all", name], ["remote", "get-url", "--push", "--all", name]]) {
    try {
      for (const line of (await git(repoPath, args)).split(/\r?\n/)) {
        const normalized = normalizeRemoteUrl(line);
        if (normalized) urls.add(normalized);
      }
    } catch {
      // A remote without a readable URL simply cannot match a URL destination.
    }
  }
  return urls;
}

const GUARD_PUSH_VALUE_OPTIONS = new Set(["--repo", "--state"]);

// The managed hook runs `guard-push --repo R --state S "$@"`; the remaining
// positionals are git's pre-push arguments (remote name, then URL).
export function guardPushDestinations(args) {
  const positionals = [];
  for (let index = 1; index < args.length; index += 1) {
    if (GUARD_PUSH_VALUE_OPTIONS.has(args[index])) {
      index += 1;
      continue;
    }
    if (!String(args[index]).startsWith("--")) positionals.push(String(args[index]));
  }
  return positionals.slice(0, 2);
}

// pre-push receives the destination as a remote name and/or URL. Only remotes
// that are exactly that destination are returned; any failure yields [] so the
// caller falls back to scanning the full reachable history.
export async function resolveDestinationRemotes(repoPath, destinations = []) {
  const wanted = destinations.map(value => String(value ?? "").trim()).filter(Boolean);
  if (wanted.length === 0) return [];
  let names;
  try {
    names = (await git(repoPath, ["remote"])).split(/\r?\n/).map(name => name.trim())
      .filter(name => SAFE_REMOTE.test(name));
  } catch {
    return [];
  }
  const wantedUrls = new Set(wanted.map(normalizeRemoteUrl).filter(Boolean));
  const matches = [];
  for (const name of names) {
    if (wanted.includes(name)) {
      matches.push(name);
      continue;
    }
    if (wantedUrls.size === 0) continue;
    const urls = await remoteUrls(repoPath, name);
    if ([...urls].some(url => wantedUrls.has(url))) matches.push(name);
  }
  return matches;
}
// @ts-expect-error augur-inject
resolveDestinationRemotes = contract(resolveDestinationRemotes, { ...augurContract_7b291ec7, contractId: 'C-24', mode: 'observe', sample: 1, where: 'src/push-destination.mjs:62', rule: 'contract-wrap', id: '7b291ec7' }); /* augur-inject:contract-wrap:7b291ec7 */
