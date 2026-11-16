// makefun-git-forge — rest.ts: the phase-2 REST v3 handlers — contents, branches,
// commits, git refs, labels, issues, comments and pull requests — plus the shared
// create/merge helpers the GraphQL and MCP surfaces call into, so all three arms
// read and write the same in-memory store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  VIEWER_LOGIN,
  VIEWER_ID,
  jsonBody,
  notFound,
  sendJson,
  sendNoContent,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import {
  buildTree,
  commitList,
  commitTree,
  createCommit,
  diffTrees,
  flattenTree,
  isAncestor,
  parseCommit,
  parseTree,
  putObject,
  threeWayConflict,
} from './git-store.ts';

// -------------------------------------------------------------------------------- shared

/** Resolve a branch name, tag name, HEAD, or raw oid to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') return null;
  if (ref === 'HEAD') ref = repo.defaultBranch;
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (direct !== undefined) {
    const obj = repo.objects.get(direct);
    if (obj !== undefined && obj.type === 'commit') return direct;
    if (obj !== undefined && obj.type === 'tag') {
      const head = obj.data.toString('utf8').split('\n\n')[0] ?? '';
      const line = head.split('\n').find((entry) => entry.startsWith('object '));
      if (line !== undefined) return line.slice(7).trim();
    }
    return null;
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
    if (obj !== undefined && obj.type === 'tag') {
      const head = obj.data.toString('utf8').split('\n\n')[0] ?? '';
      const line = head.split('\n').find((entry) => entry.startsWith('object '));
      if (line !== undefined) return line.slice(7).trim();
    }
  }
  return null;
}

/** The tree entry at `path` inside a tree object, or null (walks subdirectories). */
function treeEntryAt(
  repo: Repo,
  treeOid: string,
  path: string,
): { mode: string; oid: string } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(list: T[], query: URLSearchParams): T[] {
  const { perPage, page } = pageParams(query);
  return list.slice((page - 1) * perPage, page * perPage);
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_kgDO${Buffer.from(`issue:${repo.id}:${issue.number}`).toString('base64')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_kgDO${Buffer.from(`pr:${repo.id}:${pull.number}`).toString('base64')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: `https://github.com/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Create an issue; unknown labels are a 422. Shared by REST, GraphQL and MCP. */
export function createIssue(
  repo: Repo,
  input: { title?: unknown; body?: unknown; labels?: unknown },
): { issue: Issue } | { error: string; status: number } {
  const title = input.title;
  if (typeof title !== 'string' || title === '') return { error: 'Validation Failed: title is required', status: 422 };
  const labelNames: string[] = Array.isArray(input.labels) ? input.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  const labels: Label[] = [];
  for (const name of labelNames) {
    const found = repo.labels.find((label) => label.name === name);
    if (found === undefined) return { error: `Validation Failed: label "${name}" does not exist`, status: 422 };
    labels.push(found);
  }
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: repo.id * 1000000 + number,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    comments: [],
  };
  repo.issues.push(issue);
  return { issue };
}

/** Open a pull request; unknown head/base branches are a 422. Shared by REST, GraphQL, MCP. */
export function createPull(
  repo: Repo,
  input: { title?: unknown; body?: unknown; head?: unknown; base?: unknown },
): { pull: Pull } | { error: string; status: number } {
  const title = input.title;
  if (typeof title !== 'string' || title === '') return { error: 'Validation Failed: title is required', status: 422 };
  const head = typeof input.head === 'string' ? input.head : '';
  const base = typeof input.base === 'string' ? input.base : '';
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return { error: `Validation Failed: head branch "${head}" does not exist`, status: 422 };
  if (baseSha === undefined) return { error: `Validation Failed: base branch "${base}" does not exist`, status: 422 };
  const number = repo.nextNumber++;
  const pull: Pull = {
    id: repo.id * 1000000 + 500000 + number,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
  };
  repo.pulls.push(pull);
  return { pull };
}

/**
 * Squash-merge a pull request onto its base branch: one commit carrying the head tip's
 * tree, parented on the base tip. A three-way conflict is a 405; an already-merged
 * pull request answers with its merge commit.
 */
export function mergePullRequest(
  repo: Repo,
  pull: Pull,
): { sha: string; message: string } | { error: string; status: number } {
  if (pull.merged && pull.mergeCommitSha !== null) {
    return { sha: pull.mergeCommitSha, message: `${pull.title} (#${pull.number})` };
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { error: 'Not Found', status: 404 };
  if (threeWayConflict(repo, baseTip, headTip)) return { error: 'Merge conflict', status: 405 };
  const message = `${pull.title} (#${pull.number})`;
  const sha = createCommit(repo, commitTree(repo, headTip), [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return { sha, message };
}

// -------------------------------------------------------------------------------- contents

/** Commit a new tree on `branch` (creating the branch when needed) and return the commit oid. */
function commitTreeOnBranch(
  repo: Repo,
  branch: string,
  flat: Map<string, { mode: string; oid: string }>,
  message: string,
  parent: string | undefined,
): string {
  const treeOid = buildTree(repo, flat);
  const parents = parent === undefined ? [] : [parent];
  const commitOid = createCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

export async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pathParts: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathParts.join('/');

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === null) {
      notFound(res);
      return;
    }
    const treeOid = commitTree(repo, tip);
    if (path === '') {
      const obj = repo.objects.get(treeOid);
      const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
      sendJson(
        res,
        200,
        entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
        })),
      );
      return;
    }
    const entry = treeEntryAt(repo, treeOid, path);
    if (entry === null) {
      notFound(res);
      return;
    }
    if (entry.mode === '40000') {
      const obj = repo.objects.get(entry.oid);
      const children = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
      sendJson(
        res,
        200,
        children.map((child) => ({
          type: child.mode === '40000' ? 'dir' : 'file',
          name: child.name,
          path: `${path}/${child.name}`,
          sha: child.oid,
        })),
      );
      return;
    }
    const blob = repo.objects.get(entry.oid);
    const bytes = blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: path.split('/').pop() ?? path,
      path,
      content: bytes.toString('base64'),
      sha: entry.oid,
    });
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = await jsonBody(req, res);
    if (body === null) return;
    const message = body['message'];
    if (typeof message !== 'string' || message === '') {
      sendJson(res, 422, { message: 'Validation Failed: message is required' });
      return;
    }
    const branch = typeof body['branch'] === 'string' && body['branch'] !== '' ? body['branch'] : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    // A branch that does not exist yet starts from the default branch tip (or nothing,
    // when the repository is still unborn).
    const baseTip = tip ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const flat = baseTip === undefined ? new Map() : flattenTree(repo, commitTree(repo, baseTip));
    const existing = flat.get(path);
    if (method === 'PUT') {
      const content = body['content'];
      if (typeof content !== 'string') {
        sendJson(res, 422, { message: 'Validation Failed: content is required' });
        return;
      }
      if (existing !== undefined && typeof body['sha'] === 'string' && body['sha'] !== existing.oid) {
        sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
        return;
      }
      const bytes = Buffer.from(content, 'base64');
      const blobOid = putObject(repo, 'blob', bytes);
      flat.set(path, { mode: '100644', oid: blobOid });
      const commitOid = commitTreeOnBranch(repo, branch, flat, message, baseTip);
      sendJson(res, existing === undefined ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
        },
        commit: { sha: commitOid },
      });
      return;
    }
    // DELETE
    if (existing === undefined) {
      notFound(res);
      return;
    }
    if (typeof body['sha'] === 'string' && body['sha'] !== existing.oid) {
      sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
      return;
    }
    flat.delete(path);
    const commitOid = commitTreeOnBranch(repo, branch, flat, message, baseTip);
    sendJson(res, 200, { commit: { sha: commitOid } });
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------- branches

export function handleBranches(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    notFound(res);
    return;
  }
  const names = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
  if (tail.length === 0) {
    const ordered = [repo.defaultBranch, ...names.filter((name) => name !== repo.defaultBranch).sort()];
    const seen = new Set<string>();
    const list = ordered.filter((name) => {
      if (seen.has(name) || !names.includes(name)) return false;
      seen.add(name);
      return true;
    });
    sendJson(
      res,
      200,
      paginate(
        list.map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) as string },
          protected: false,
        })),
        query,
      ),
    );
    return;
  }
  const name = tail.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) {
    notFound(res);
    return;
  }
  sendJson(res, 200, { name, commit: { sha }, protected: false });
}

// -------------------------------------------------------------------------------- commits

export function handleCommits(req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  if ((req.method ?? 'GET') !== 'GET') {
    notFound(res);
    return;
  }
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    notFound(res);
    return;
  }
  const list = commitList(repo, tip).map((entry) => {
    const obj = repo.objects.get(entry.sha);
    const parents = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
    return {
      sha: entry.sha,
      commit: {
        message: entry.message,
        author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, date: FIXED_TIME },
        committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@users.noreply.github.com`, date: FIXED_TIME },
      },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID },
      parents: parents.map((sha) => ({ sha })),
    };
  });
  sendJson(res, 200, paginate(list, query));
}

// -------------------------------------------------------------------------------- git refs

export async function handleRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    if (tail.length === 0) {
      sendJson(
        res,
        200,
        [...repo.refs.keys()].sort().map((ref) => {
          const oid = repo.refs.get(ref) as string;
          const obj = repo.objects.get(oid);
          return { ref, object: { sha: oid, type: obj?.type ?? 'commit' } };
        }),
      );
      return;
    }
    const refname = `refs/${tail.join('/')}`;
    const exact = repo.refs.get(refname);
    if (exact !== undefined) {
      sendJson(res, 200, { ref: refname, object: { sha: exact } });
      return;
    }
    const prefixed = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith(`${refname}/`))
      .sort()
      .map((ref) => ({ ref, object: { sha: repo.refs.get(ref) as string } }));
    if (prefixed.length === 0) {
      notFound(res);
      return;
    }
    sendJson(res, 200, prefixed);
    return;
  }
  if (method === 'POST' && tail.length === 0) {
    const body = await jsonBody(req, res);
    if (body === null) return;
    const ref = body['ref'];
    const sha = body['sha'];
    if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' });
      return;
    }
    if (repo.refs.has(ref)) {
      sendJson(res, 422, { message: 'Validation Failed: ref already exists' });
      return;
    }
    if (!repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'Validation Failed: sha does not exist' });
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha } });
    return;
  }
  if (method === 'PATCH' && tail.length > 0) {
    const body = await jsonBody(req, res);
    if (body === null) return;
    const refname = `refs/${tail.join('/')}`;
    const current = repo.refs.get(refname);
    if (current === undefined) {
      notFound(res);
      return;
    }
    const sha = body['sha'];
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
      sendJson(res, 422, { message: 'Validation Failed: sha does not exist' });
      return;
    }
    if (body['force'] !== true) {
      const currentObj = repo.objects.get(current);
      const nextObj = repo.objects.get(sha);
      if (currentObj?.type === 'commit' && nextObj?.type === 'commit' && !isAncestor(repo, current, sha)) {
        sendJson(res, 422, { message: 'Validation Failed: update is not a fast-forward' });
        return;
      }
    }
    repo.refs.set(refname, sha);
    sendJson(res, 200, { ref: refname, object: { sha } });
    return;
  }
  if (method === 'DELETE' && tail.length > 0) {
    const refname = `refs/${tail.join('/')}`;
    if (!repo.refs.has(refname)) {
      notFound(res);
      return;
    }
    repo.refs.delete(refname);
    sendNoContent(res);
    return;
  }
  notFound(res);
}

// -------------------------------------------------------------------------------- labels

export async function handleLabels(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    sendJson(
      res,
      200,
      repo.labels.map((label) => ({ name: label.name, color: label.color })),
    );
    return;
  }
  if (method === 'POST') {
    const body = await jsonBody(req, res);
    if (body === null) return;
    const name = body['name'];
    if (typeof name !== 'string' || name === '') {
      sendJson(res, 422, { message: 'Validation Failed: name is required' });
      return;
    }
    const color = typeof body['color'] === 'string' && body['color'] !== '' ? body['color'] : 'ededed';
    const existing = repo.labels.find((label) => label.name === name);
    if (existing !== undefined) {
      sendJson(res, 200, { name: existing.name, color: existing.color });
      return;
    }
    const label: Label = { name, color };
    repo.labels.push(label);
    sendJson(res, 201, { name: label.name, color: label.color });
    return;
  }
  notFound(res);
}

// -------------------------------------------------------------------------------- issues

export async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, paginate(list, query).map((issue) => issueJson(repo, issue)));
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const created = createIssue(repo, { title: body['title'], body: body['body'], labels: body['labels'] });
      if ('error' in created) {
        sendJson(res, created.status, { message: created.error });
        return;
      }
      sendJson(res, 201, issueJson(repo, created.issue));
      return;
    }
    notFound(res);
    return;
  }
  const number = Number.parseInt(tail[0] as string, 10);
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) {
    notFound(res);
    return;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      if (typeof body['title'] === 'string') issue.title = body['title'];
      if (typeof body['body'] === 'string') issue.body = body['body'];
      if (body['state'] === 'open' || body['state'] === 'closed') issue.state = body['state'];
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: FIXED_TIME,
          updated_at: FIXED_TIME,
        })),
      );
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      if (typeof body['body'] !== 'string' || body['body'] === '') {
        sendJson(res, 422, { message: 'Validation Failed: body is required' });
        return;
      }
      const comment = { id: repo.id * 1000000 + 800000 + repo.nextCommentId++, body: body['body'] as string };
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        created_at: FIXED_TIME,
        updated_at: FIXED_TIME,
      });
      return;
    }
  }
  notFound(res);
}

// -------------------------------------------------------------------------------- pulls

export async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      sendJson(res, 200, paginate(list, query).map((pull) => pullJson(repo, pull)));
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const created = createPull(repo, { title: body['title'], body: body['body'], head: body['head'], base: body['base'] });
      if ('error' in created) {
        sendJson(res, created.status, { message: created.error });
        return;
      }
      sendJson(res, 201, pullJson(repo, created.pull));
      return;
    }
    notFound(res);
    return;
  }
  const number = Number.parseInt(tail[0] as string, 10);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) {
    notFound(res);
    return;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    notFound(res);
    return;
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = diffTrees(repo, commitTree(repo, pull.baseSha), commitTree(repo, pull.headSha)).map((diff) => ({
      filename: diff.path,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
    }));
    sendJson(res, 200, files);
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const body = await jsonBody(req, res);
    if (body === null) return;
    const merged = mergePullRequest(repo, pull);
    if ('error' in merged) {
      sendJson(res, merged.status, { message: merged.error });
      return;
    }
    sendJson(res, 200, { merged: true, sha: merged.sha, message: merged.message });
    return;
  }
  notFound(res);
}
