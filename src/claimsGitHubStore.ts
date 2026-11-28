// SPDX-License-Identifier: Apache-2.0
//
// Production GitHub adapter for the claims publication store (D4 review
// finding). Implements `ClaimsReleaseStore` against the real GitHub REST
// API: bounded requests, response validation, and safe error handling.
//
// Safety properties:
//   * every response body is streamed and byte-counted BEFORE parsing —
//     an oversized body is cancelled and refused, never truncated;
//   * every operation validates the HTTP status and (for API JSON) the
//     response shape; unexpected shapes are refused, not guessed;
//   * the token is supplied by the CALLER (the workflow's GITHUB_TOKEN),
//     never logged, never echoed in errors;
//   * error messages carry the endpoint path and status — never the
//     token, never request headers.
//
// The draft-first sequencing, digest gates, and stable-ref semantics all
// live in claimsPublication.ts; this class is ONLY the API surface.

import {
  CLAIMS_ARTIFACT_ASSET_NAME,
  type ClaimsReleaseStore,
  ClaimsPublicationError,
} from "./claimsPublication.js";

export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
export const DEFAULT_GITHUB_ASSETS_BASE = "https://github.com";
export const MAX_API_JSON_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

export interface GitHubStoreOptions {
  /** GitHub repository ("owner/repo"). */
  repo: string;
  /** Token with contents read/write (workflow `GITHUB_TOKEN`). NEVER logged. */
  token: string;
  apiBase?: string;
  assetsBase?: string;
  fetchImpl?: typeof fetch;
}

export class GitHubStoreError extends Error {
  readonly path: string;
  readonly status: number | null;

  constructor(path: string, status: number | null, message: string) {
    super(`github store (${path}${status === null ? "" : ` → HTTP ${status}`}): ${message}`);
    this.name = "GitHubStoreError";
    this.path = path;
    this.status = status;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Streamed, byte-capped body read — oversized bodies are cancelled, never truncated. */
async function readCapped(res: Response, cap: number, path: string): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) throw new GitHubStoreError(path, res.status, "response body is empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        void reader.cancel().catch(() => undefined);
        throw new GitHubStoreError(path, res.status, `response exceeded the ${cap}-byte cap`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return merged;
}

interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  assets: Array<{ id: number; name: string; size: number; url: string; browser_download_url: string }>;
}

export class GitHubClaimsReleaseStore implements ClaimsReleaseStore {
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly assetsBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubStoreOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
      throw new GitHubStoreError("<init>", null, "repo must be owner/repo");
    }
    if (typeof opts.token !== "string" || opts.token.trim().length === 0) {
      throw new GitHubStoreError("<init>", null, "a GitHub token is required (workflow GITHUB_TOKEN)");
    }
    this.repo = opts.repo;
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? DEFAULT_GITHUB_API_BASE).replace(/\/$/, "");
    this.assetsBase = (opts.assetsBase ?? DEFAULT_GITHUB_ASSETS_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async api(
    path: string,
    init: RequestInit = {},
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`, // never logged
          accept,
          "x-github-api-version": "2022-11-28",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new GitHubStoreError(path, null, `request failed: ${errText(e)}`);
    }
    return res;
  }

  private async apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.api(path, init);
    if (!res.ok) {
      throw new GitHubStoreError(path, res.status, `expected 2xx, got ${res.status}`);
    }
    const bytes = await readCapped(res, MAX_API_JSON_BYTES, path);
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
    } catch (e) {
      throw new GitHubStoreError(path, res.status, `response is not valid JSON: ${errText(e)}`);
    }
  }

  private async expectStatus(path: string, init: RequestInit, expected: number[]): Promise<void> {
    const res = await this.api(path, init);
    if (!expected.includes(res.status)) {
      throw new GitHubStoreError(path, res.status, `expected ${expected.join(" or ")}, got ${res.status}`);
    }
  }

  /** GET /repos/{repo}/tags — enough pages to see all tag names. */
  async listTags(): Promise<string[]> {
    const tags: string[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.apiJson<Array<{ name: string }>>(
        `/repos/${this.repo}/tags?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) throw new GitHubStoreError("/repos/…/tags", null, "unexpected response shape");
      tags.push(...batch.map((t) => t.name).filter((n): n is string => typeof n === "string"));
      if (batch.length < 100) break;
    }
    return tags;
  }

  /** POST /repos/{repo}/releases — draft, never latest. */
  async createDraftRelease(tag: string): Promise<void> {
    await this.expectStatus(`/repos/${this.repo}/releases`, {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, name: tag, draft: true, make_latest: "false" }),
    }, [201]);
  }

  private async releaseByTag(tag: string): Promise<Release> {
    const rel = await this.apiJson<Release>(`/repos/${this.repo}/releases/tags/${tag}`);
    if (typeof rel?.id !== "number" || !Array.isArray(rel.assets)) {
      throw new GitHubStoreError(`/repos/…/releases/tags/${tag}`, null, "unexpected release response shape");
    }
    return rel;
  }

  /** POST the upload URL of the draft release (per-asset). */
  async uploadDraftAsset(tag: string, name: string, bytes: Uint8Array): Promise<void> {
    const rel = await this.releaseByTag(tag);
    if (!rel.draft) {
      throw new GitHubStoreError(`/repos/…/releases/tags/${tag}`, null, "release is NOT a draft — refusing to upload into a published identity");
    }
    const uploadBase = `${this.apiBase.replace("/api.", "/uploads.")}`;
    const res = await this.fetchImpl(`${uploadBase}/repos/${this.repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`, // never logged
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
    }).catch((e: unknown) => {
      throw new GitHubStoreError(`<upload ${name}>`, null, `request failed: ${errText(e)}`);
    });
    if (res.status !== 201) {
      throw new GitHubStoreError(`<upload ${name}>`, res.status, `expected 201, got ${res.status}`);
    }
  }

  /** GET the draft's asset bytes via its (url) API asset endpoint. */
  async fetchDraftAsset(tag: string, name: string): Promise<Uint8Array> {
    const rel = await this.releaseByTag(tag);
    const asset = rel.assets.find((a) => a.name === name);
    if (!asset) throw new GitHubStoreError(`/repos/…/releases/tags/${tag}`, 404, `asset ${name} not present on draft`);
    const res = await this.fetchImpl(asset.url, {
      headers: {
        authorization: `Bearer ${this.token}`, // never logged
        accept: "application/octet-stream",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
    }).catch((e: unknown) => {
      throw new GitHubStoreError(`<draft asset ${name}>`, null, `request failed: ${errText(e)}`);
    });
    if (!res.ok) throw new GitHubStoreError(`<draft asset ${name}>`, res.status, `expected 2xx, got ${res.status}`);
    return readCapped(res, MAX_ASSET_BYTES, `<draft asset ${name}>`);
  }

  /** PATCH /releases/{id} — draft → published, never latest. */
  async publishDraftRelease(tag: string): Promise<void> {
    const rel = await this.releaseByTag(tag);
    if (!rel.draft) throw new GitHubStoreError(`/repos/…/releases/tags/${tag}`, null, "release is not a draft (publish refused)");
    await this.expectStatus(`/repos/${this.repo}/releases/${rel.id}`, {
      method: "PATCH",
      body: JSON.stringify({ draft: false, make_latest: "false" }),
    }, [200]);
  }

  /** DELETE /releases/{id} — ONLY ever called on this run's draft. */
  async deleteDraftRelease(tag: string): Promise<void> {
    const rel = await this.releaseByTag(tag);
    if (!rel.draft) throw new GitHubStoreError(`/repos/…/releases/tags/${tag}`, null, "refusing to delete a PUBLISHED release");
    await this.expectStatus(`/repos/${this.repo}/releases/${rel.id}`, { method: "DELETE" }, [204]);
  }

  /** GET /repos/{repo}/git/ref/tags/claims-artifact-prod — null when 404. */
  async stableRefSha(): Promise<string | null> {
    const res = await this.api(`/repos/${this.repo}/git/ref/tags/claims-artifact-prod`);
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", res.status, `expected 200 or 404, got ${res.status}`);
    const ref = JSON.parse(Buffer.from(await readCapped(res, MAX_API_JSON_BYTES, "/git/ref/…")).toString("utf8")) as { object?: { sha?: unknown; type?: unknown } };
    if (ref.object?.type !== "tag" || typeof ref.object.sha !== "string") {
      throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", res.status, "stable ref does not name an annotated tag object");
    }
    return ref.object.sha;
  }

  /** POST /repos/{repo}/git/tags — immutable annotated tag object. */
  async createTagObject(args: { message: string; commitSha: string }): Promise<string> {
    const created = await this.apiJson<{ sha?: unknown; object?: { sha?: unknown } }>(`/repos/${this.repo}/git/tags`, {
      method: "POST",
      body: JSON.stringify({ tag: "claims-artifact-prod", message: args.message, object: args.commitSha, type: "commit" }),
    });
    const sha = typeof created.sha === "string" ? created.sha : typeof created.object?.sha === "string" ? created.object.sha : null;
    if (sha === null || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GitHubStoreError("/git/tags", null, "unexpected tag-object response shape");
    }
    return sha;
  }

  /**
   * PATCH (or POST when absent) /git/refs/tags/claims-artifact-prod — the
   * ONE pointer move. Review finding 2 / I-05: the move is
   * OWNERSHIP-CHECKED and POST-WRITE-VERIFIED.
   *
   * `expectCurrentSha` (the sha the caller saw — previous pointer, or null
   * for first publication) is verified against the live ref before the
   * write; a mismatch refuses the move instead of clobbering a concurrent
   * publisher's update. An absent ref is created with POST /git/refs,
   * which the real API refuses with HTTP 422 when the ref came into
   * existence concurrently — a natural insert-if-absent guard.
   *
   * RESIDUAL RACE, stated honestly (I-05): the GitHub REST API has NO
   * conditional write for refs, so between the pre-write probe and the
   * PATCH an external writer can still replace the ref — the forced PATCH
   * would overwrite that write, and NO REST call can prevent it. This is
   * verify-then-write, NOT an atomic compare-and-swap. What this adapter
   * adds on top of the check is a POST-WRITE READ-BACK: the ref is re-read
   * immediately after the write and must name the sha we wrote, so a
   * foreign write that lands AFTER our PATCH (in the PATCH→read-back
   * window) is detected and reported instead of being silently accepted.
   * A foreign write landing in the probe→PATCH window is clobbered —
   * detected only if the writer re-writes or via out-of-band auditing.
   * Documented mitigations: the workflow `concurrency` group serializes
   * THIS repo's publication runs; GitHub TAG PROTECTION RULES on
   * `claims-artifact-prod` are the operational defense against external
   * writers; a writer that wins either race is reported as TERMINAL
   * UNVERIFIED, never silently accepted.
   */
  async updateStableRef(tagObjectSha: string, opts?: { expectCurrentSha?: string | null }): Promise<void> {
    const expect = opts?.expectCurrentSha;
    const probe = await this.api(`/repos/${this.repo}/git/ref/tags/claims-artifact-prod`);
    if (probe.status === 404) {
      if (expect != null) {
        throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", 404, `stable ref moved concurrently — expected ${expect}, found nothing; refusing non-atomic overwrite`);
      }
      // POST /git/refs is the real API's insert-if-absent: a concurrent
      // creator wins the race and this call answers 422 — refused, no
      // overwrite is attempted.
      await this.expectStatus(`/repos/${this.repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: "refs/tags/claims-artifact-prod", sha: tagObjectSha }),
      }, [201]);
      await this.verifyRefPostWrite(tagObjectSha, "create");
      return;
    }
    if (!probe.ok) throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", probe.status, `probe failed: ${probe.status}`);
    const live = JSON.parse(Buffer.from(await readCapped(probe, MAX_API_JSON_BYTES, "/git/ref/…")).toString("utf8")) as { object?: { sha?: unknown; type?: unknown } };
    const liveSha = typeof live.object?.sha === "string" ? live.object.sha : null;
    if (liveSha === null || (expect !== undefined && liveSha !== expect)) {
      throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", probe.status, `stable ref moved concurrently — expected ${expect ?? "<caller provided none>"}, found ${liveSha ?? "unknown"}; refusing non-atomic overwrite`);
    }
    await this.expectStatus(`/repos/${this.repo}/git/refs/tags/claims-artifact-prod`, {
      method: "PATCH",
      body: JSON.stringify({ sha: tagObjectSha, force: true }),
    }, [200]);
    await this.verifyRefPostWrite(tagObjectSha, "move");
  }

  /**
   * POST-WRITE READ-BACK (I-05): re-read the ref and require it to name
   * the sha we just wrote. A ref that names anything else after a 2xx
   * write means a foreign writer acted between the write and this read —
   * the caller MUST treat the outcome as unverified, never as success.
   */
  private async verifyRefPostWrite(writtenSha: string, what: string): Promise<void> {
    const path = "/repos/{repo}/git/ref/tags/claims-artifact-prod";
    const res = await this.api(`/repos/${this.repo}/git/ref/tags/claims-artifact-prod`);
    if (res.status === 404) {
      throw new GitHubStoreError(path, 404, `post-${what} read-back: the ref is GONE immediately after a ${what} that answered 2xx — concurrent modification detected, outcome UNVERIFIED`);
    }
    if (!res.ok) {
      throw new GitHubStoreError(path, res.status, `post-${what} read-back failed: expected 200 or 404, got ${res.status} — outcome UNVERIFIED`);
    }
    const live = JSON.parse(Buffer.from(await readCapped(res, MAX_API_JSON_BYTES, path)).toString("utf8")) as { object?: { sha?: unknown } };
    const liveSha = typeof live.object?.sha === "string" ? live.object.sha : null;
    if (liveSha !== writtenSha) {
      throw new GitHubStoreError(path, res.status, `post-${what} read-back: the ref names ${liveSha ?? "unknown"}, not the sha this run wrote (${writtenSha}) — a concurrent writer acted between the write and the read-back, outcome UNVERIFIED`);
    }
  }

  /**
   * DELETE /git/refs/tags/claims-artifact-prod — ownership-conditional
   * (I-05). GitHub answers HTTP 404 for an ALREADY-ABSENT ref; that is a
   * verified absence, treated as a no-op success (identical to the
   * in-memory store — no DELETE request is issued for an absent ref).
   * A live ref whose sha differs from `expectCurrentSha` (the sha the
   * caller observed) is REFUSED — a concurrent publisher's pointer is
   * never deleted.
   *
   * RESIDUAL RACE, stated honestly (I-05): the GitHub REST API has no
   * conditional DELETE for refs, so this is verify-then-write, NOT an
   * atomic compare-and-swap — an external writer that replaces the ref
   * in the probe→DELETE window loses its write to the DELETE. What this
   * adapter adds is a POST-WRITE READ-BACK: after a 204 the ref is
   * re-read, and a ref that EXISTS again means a foreign writer acted in
   * the DELETE→read-back window — reported UNVERIFIED, never treated as
   * success. Mitigations: the workflow `concurrency` group serializes
   * this repo's publication runs; GitHub TAG PROTECTION RULES are the
   * operational defense against external writers.
   */
  async deleteStableRef(opts?: { expectCurrentSha?: string | null }): Promise<void> {
    const expect = opts?.expectCurrentSha;
    const probe = await this.api(`/repos/${this.repo}/git/ref/tags/claims-artifact-prod`);
    if (probe.status === 404) return; // already absent — verified, nothing to delete
    if (!probe.ok) throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", probe.status, `probe failed: ${probe.status}`);
    const live = JSON.parse(Buffer.from(await readCapped(probe, MAX_API_JSON_BYTES, "/git/ref/…")).toString("utf8")) as { object?: { sha?: unknown } };
    const liveSha = typeof live.object?.sha === "string" ? live.object.sha : null;
    if (expect !== undefined && (liveSha === null || liveSha !== expect)) {
      throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", probe.status, `stable ref moved concurrently (expected ${expect ?? "<none>"}, found ${liveSha ?? "unknown"}) — deletion refused: this run does not own the reference`);
    }
    await this.expectStatus(`/repos/${this.repo}/git/refs/tags/claims-artifact-prod`, { method: "DELETE" }, [204]);
    // POST-WRITE READ-BACK for a DELETE: 404 is the EXPECTED, verified
    // outcome (the ref is gone); a live ref after a 204 means a foreign
    // writer acted in the DELETE→read-back window — UNVERIFIED, never
    // treated as success.
    const post = await this.api(`/repos/${this.repo}/git/ref/tags/claims-artifact-prod`);
    if (post.status === 404) return; // verified absence
    if (!post.ok) {
      throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", post.status, `post-delete read-back failed: expected 200 or 404, got ${post.status} — outcome UNVERIFIED`);
    }
    const postLive = JSON.parse(Buffer.from(await readCapped(post, MAX_API_JSON_BYTES, "/git/ref/…")).toString("utf8")) as { object?: { sha?: unknown } };
    throw new GitHubStoreError("/git/ref/tags/claims-artifact-prod", post.status, `post-delete read-back: the ref EXISTS again (naming ${typeof postLive.object?.sha === "string" ? postLive.object.sha : "unknown"}) — a concurrent writer acted between the delete and the read-back, outcome UNVERIFIED`);
  }

  /** GET /git/tags/{sha}. */
  async fetchTagObject(tagObjectSha: string): Promise<{ message: string; commitSha: string }> {
    const tag = await this.apiJson<{ message?: unknown; object?: { sha?: unknown; type?: unknown } }>(
      `/repos/${this.repo}/git/tags/${tagObjectSha}`,
    );
    if (typeof tag.message !== "string" || tag.object?.type !== "commit" || typeof tag.object.sha !== "string") {
      throw new GitHubStoreError(`/git/tags/${tagObjectSha}`, null, "unexpected tag-object response shape");
    }
    return { message: tag.message, commitSha: tag.object.sha };
  }

  /** GET the browser download URL of the versioned release asset. */
  async fetchAssetByTag(tag: string, name: string): Promise<Uint8Array> {
    const url = `${this.assetsBase}/${this.repo}/releases/download/${tag}/${name}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.token}`, accept: "application/octet-stream" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
    }).catch((e: unknown) => {
      throw new GitHubStoreError(`<asset ${tag}/${name}>`, null, `request failed: ${errText(e)}`);
    });
    if (!res.ok) throw new GitHubStoreError(`<asset ${tag}/${name}>`, res.status, `expected 2xx, got ${res.status}`);
    return readCapped(res, MAX_ASSET_BYTES, `<asset ${tag}/${name}>`);
  }

  /** Convenience for the publish CLI: the artifact asset name. */
  static get artifactAssetName(): string {
    return CLAIMS_ARTIFACT_ASSET_NAME;
  }
}

export { ClaimsPublicationError };
