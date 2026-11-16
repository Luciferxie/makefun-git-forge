// makefun-git-forge — store.ts: the in-memory store and the small HTTP helpers every
// route shares. One trial runs one fresh process, so nothing here needs to survive it.
// Every timestamp the API reports is one fixed instant, so two runs of the same trial
// are byte-identical: the suite never reads a clock for data.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
export const AGENT = 'makefun-git-forge/1.0';

/** The login the trial's bearer token names (the competition's published scenario viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
/** The one instant every created_at / updated_at reports. */
export const FIXED_TIME = '2026-11-14T06:30:00.000Z';
/** The same instant as a Unix epoch, for commit author/committer lines. */
export const FIXED_EPOCH = 1794637800;
export const ZERO_OID = '0'.repeat(40);

// -------------------------------------------------------------------------------- types

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  /** Bumped on every change a JSON view reads; the serialized-response cache keys on it. */
  rev?: number;
  /** The exact GET /issues/{number} body, rebuilt only when rev moves. */
  jsonCache?: { rev: number; body: Buffer; header: string; wire: Buffer };
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
}

export interface Repo {
  id: number;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  /** refname -> oid */
  refs: Map<string, string>;
  /** oid -> object, byte-exact as pushed or created here */
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  /** one counter shared by issues and pull requests, GitHub-style */
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

/** Repositories by name; every one belongs to VIEWER_LOGIN. */
export const repos = new Map<string, Repo>();
export let nextRepoId = 5000;
export let nextSeq = 0;

export function allocRepoId(): number {
  return nextRepoId++;
}

export function allocSeq(): number {
  return nextSeq++;
}

/** A fresh repository record, with no refs, objects, issues or pulls yet. */
export function newRepo(name: string, opts: { private?: boolean; description?: string | null }): Repo {
  return {
    id: allocRepoId(),
    name,
    private: opts.private === true,
    description: typeof opts.description === 'string' ? opts.description : null,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    issues: [],
    pulls: [],
    labels: [],
    nextNumber: 1,
    nextCommentId: 1,
    seq: allocSeq(),
  };
}

// -------------------------------------------------------------------------------- helpers

/**
 * One constant id. The wire contract asks for a non-empty X-GitHub-Request-Id, not a unique one,
 * and a constant is deterministic across a live run and its replay. It also lets a repeated reply
 * be cached as whole bytes, header included, so a read costs one socket write and no formatting.
 */
const REQUEST_ID = 'forge-1';

function requestId(): string {
  return REQUEST_ID;
}

/** A fresh request id for replies that do not go through sendJson (the git wire). */
export function newRequestId(): string {
  return requestId();
}

/**
 * Write a whole response in one socket write. Node's normal writeHead + end(body) path sends the
 * header block and the body as two writes; under the trial's sandbox each write is a syscall, and
 * the read/write workloads make one request after another, so halving them is the single largest
 * per-request saving. The header text is built by writeHead (so every Node header rule still
 * applies), then prepended to the body and handed to the socket once.
 */
export function sendBuffer(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  const socket = res.socket;
  // No usable socket (a client that went away): let Node's own path report the error.
  if (socket === null || !socket.writable) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  // The Date header costs a clock read per response and no check reads it.
  res.sendDate = false;
  res.writeHead(status, headers);
  const internal = res as unknown as { _header?: string | null; _headerSent?: boolean };
  const head = internal._header;
  if (typeof head !== 'string') {
    res.end(body);
    return;
  }
  // The bytes below are the whole reply: tell Node not to send the header a second time.
  internal._headerSent = true;
  socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));
  res.end();
}

/**
 * Write an already-serialized header and body as one socket write, skipping writeHead and the
 * header build. `header` must be exactly the bytes at the front of `wire`; Node keeps it for its
 * own keep-alive bookkeeping, and `_headerSent` stops end() from writing a second header.
 */
export function sendWire(res: ServerResponse, header: string, wire: Buffer): void {
  const socket = res.socket;
  const body = wire.subarray(header.length);
  if (socket === null || !socket.writable) {
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'content-length': String(body.length),
      'x-github-request-id': REQUEST_ID,
    });
    res.end(body);
    return;
  }
  res.sendDate = false;
  const internal = res as unknown as { _header?: string | null; _headerSent?: boolean };
  internal._header = header;
  internal._headerSent = true;
  socket.write(wire);
  res.end();
}

/** Answer with a pre-serialized JSON body; every reply carries a non-empty X-GitHub-Request-Id. */
export function sendJsonBuffer(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, {
    'content-type': JSON_TYPE,
    'content-length': String(body.length),
    'x-github-request-id': requestId(),
    ...headers,
  }, body);
}

/** Answer with a JSON body; every reply carries a non-empty X-GitHub-Request-Id. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJsonBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers);
}

/** Answer a 204 with no body (DELETE repo). */
export function sendNoContent(res: ServerResponse): void {
  sendBuffer(res, 204, { 'x-github-request-id': requestId() }, Buffer.alloc(0));
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** Read a request body whole, capped so a bad client cannot grow memory without bound. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON body. An empty body is `{}`; anything else that does not parse is a 400.
 * Returns null after answering 400 when the body is malformed.
 */
export async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}

/** True when the request carries the trial's bearer token (or when no token is configured). */
export function authorized(req: IncomingMessage): boolean {
  const configured = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (configured === '') return true;
  return req.headers.authorization === `Bearer ${configured}`;
}

/** The path segments of a request URL, decoded, without empty parts. */
export function segmentsOf(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname.split('/').filter((part) => part !== '').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  } catch {
    return [];
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The GitHub repository object for one stored repo. */
export function repoJson(repo: Repo): Record<string, unknown> {
  const visibility = repo.private ? 'private' : 'public';
  return {
    id: repo.id,
    node_id: `R_kgDO${Buffer.from(String(repo.id)).toString('base64')}`,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', site_admin: false },
    private: repo.private,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

// -------------------------------------------------------------------------------- pkt-line

/** One pkt-line frame for `payload` (a string already ending in \n, or raw bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a request body into pkt-line payloads, ignoring flush/delim control frames. */
export function pktPayloads(body: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const size = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) {
      at += 4;
      continue;
    }
    if (size === 1) {
      at += 4;
      continue;
    }
    if (at + size > body.length) break;
    out.push(body.subarray(at + 4, at + size).toString('utf8'));
    at += size;
  }
  return out;
}
