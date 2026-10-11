// Image references and the agent's own image cache (§4.5). A job should pin
// `repo@sha256:…`; a tag is resolved by pulling and the digest that ran is
// recorded. The agent keeps the 3 most recently used digests of each
// repository it pulled and removes older ones when idle. It only ever
// removes images it pulled itself: a Docker host may hold the owner's own.

const DOCKER_HUB = /^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//;

/** `ghcr.io/a/b:tag@sha256:x` → `{repo: "ghcr.io/a/b", tag: "tag", digest: "sha256:x"}`. */
export function parseImageRef(reference) {
  const text = String(reference ?? "");
  const at = text.indexOf("@");
  const name = at >= 0 ? text.slice(0, at) : text;
  const digest = at >= 0 ? text.slice(at + 1) : null;
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const tagged = colon > slash;
  return { repo: tagged ? name.slice(0, colon) : name, tag: tagged ? name.slice(colon + 1) : null, digest };
}

/** A repository as Docker shows it: `docker.io/library/busybox` → `busybox`, `docker.io/me/app` → `me/app`. */
export function familiarRepo(repo) {
  return String(repo ?? "").replace(DOCKER_HUB, "").replace(/^library\//, "");
}

/**
 * The digest that identifies what `reference` ran, from the image's
 * inspection: the reference's own digest, else the repository digest Docker
 * recorded for its repository (a pulled tag), else the image id (a local
 * build, which has no repository digest).
 */
export function digestFor(reference, image) {
  const { repo, digest } = parseImageRef(reference);
  if (digest) return digest;
  const wanted = familiarRepo(repo);
  for (const entry of image?.RepoDigests ?? []) {
    const parsed = parseImageRef(entry);
    if (parsed.digest && familiarRepo(parsed.repo) === wanted) return parsed.digest;
  }
  return image?.Id ?? null;
}

/**
 * What to remove from `record` (`{repo: [{digest, usedAt}]}`): every digest
 * of a repository older than its `keep` most recently used, except those in
 * `inUse` (digests a run holds).
 */
export function pruneCandidates(record, { keep = 3, inUse = new Set() } = {}) {
  const remove = [];
  for (const [repo, entries] of Object.entries(record ?? {})) {
    const sorted = [...entries].sort((a, b) => b.usedAt - a.usedAt);
    for (const entry of sorted.slice(keep)) if (!inUse.has(entry.digest)) remove.push({ repo, digest: entry.digest, reference: `${repo}@${entry.digest}` });
  }
  return remove;
}

/** The agent's record of the images it pulled, in `<state>/images.json`. */
export class ImageRecord {
  /** `state`: a StateDir (or anything with `dir`, `readJson` and `writeSecure`); null keeps it in memory. */
  constructor(state = null) {
    this.state = state;
    this.file = state ? `${state.dir}/images.json` : null;
    this.memory = {};
  }

  async read() {
    if (!this.file) return this.memory;
    try {
      return (await this.state.readJson(this.file))?.repos ?? {};
    } catch {
      return {};
    }
  }

  async write(repos) {
    if (!this.file) {
      this.memory = repos;
      return;
    }
    await this.state.writeSecure(this.file, `${JSON.stringify({ repos })}\n`);
  }

  /**
   * Notes that a registry image (by digest) was used now. Only a digest the
   * agent pulled (`pulled`) starts a record; one that was already on the
   * machine is the owner's and is never recorded, so never removed. Local
   * images have no digest of their own and are never recorded either.
   */
  async used(reference, digest, { pulled = false, now = Date.now() } = {}) {
    if (!digest?.startsWith("sha256:")) return;
    const repo = parseImageRef(reference).repo;
    const repos = await this.read();
    const known = (repos[repo] ?? []).some((entry) => entry.digest === digest);
    if (!known && !pulled) return;
    const entries = (repos[repo] ?? []).filter((entry) => entry.digest !== digest);
    repos[repo] = [...entries, { digest, usedAt: now }];
    await this.write(repos);
  }

  /** Removes digests beyond the newest `keep` per repository with `remove(reference)`; returns what went. */
  async prune(remove, { keep = 3, inUse = new Set() } = {}) {
    const repos = await this.read();
    const removed = [];
    for (const candidate of pruneCandidates(repos, { keep, inUse })) {
      let gone = false;
      try {
        gone = await remove(candidate.reference);
      } catch {
        gone = false;
      }
      if (gone) {
        repos[candidate.repo] = repos[candidate.repo].filter((entry) => entry.digest !== candidate.digest);
        removed.push(candidate.reference);
      }
    }
    if (removed.length) await this.write(repos);
    return removed;
  }
}
