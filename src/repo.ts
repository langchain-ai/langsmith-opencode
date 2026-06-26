import { execFileSync } from "node:child_process";

export type RepoInfo = {
  repository_url?: string;
  repository_provider?: string;
  repository_name?: string;
  git_branch?: string;
  git_commit_sha?: string;
};

const cache = new Map<string, RepoInfo>();

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const parseRemote = (url: string): { provider?: string; name?: string } => {
  // Normalize the host + "org/repo" slug out of either ssh
  // (git@github.com:org/repo.git) or https (https://github.com/org/repo.git).
  let host: string | undefined;
  let path: string | undefined;

  const sshMatch = url.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    host = sshMatch[1];
    path = sshMatch[2];
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      // not a parseable URL
    }
  }

  const name = path?.replace(/\.git$/, "").replace(/\/+$/, "") || undefined;

  const provider = (() => {
    if (!host) return undefined;
    if (host.includes("github")) return "github";
    if (host.includes("gitlab")) return "gitlab";
    if (host.includes("bitbucket")) return "bitbucket";
    return "other";
  })();

  return { provider, name };
};

/** Read git repo/branch/commit info for a working directory. Cached per cwd. */
export const getRepoInfo = (cwd: string): RepoInfo => {
  const cached = cache.get(cwd);
  if (cached) return cached;

  const info: RepoInfo = {};

  const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
  if (remote) {
    info.repository_url = remote; // retain the url as-is
    const { provider, name } = parseRemote(remote);
    if (provider) info.repository_provider = provider;
    if (name) info.repository_name = name;
  }

  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") info.git_branch = branch;

  const sha = git(cwd, ["rev-parse", "HEAD"]);
  if (sha) info.git_commit_sha = sha;

  cache.set(cwd, info);
  return info;
};
