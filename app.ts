// makefun-git-forge: a standalone GitHub-compatible git forge in one Node 22 process.
// Standard library only: node:http, node:crypto, node:zlib. No git binary, no network,
// no dependencies.
//
// The store is in-memory: a trial runs one fresh process, so nothing needs to survive it.
// Every timestamp the API reports is one fixed instant: the suite never reads a clock for data,
// and a fixed instant keeps two runs of the same trial byte-identical.
//
// Ownership: the trial's bearer token names one login, and every repository belongs to it. The
// competition's scenario is one published constant (the same in every trial, practice and final),
// and its viewer login is `adaiversen`; any other owner in a URL is a 404, never a 403.
//
// Layout: store.ts holds the store and the HTTP helpers; git-store.ts the object model and
// packfiles; git-protocol.ts the smart-HTTP git wire; rest.ts the REST v3 handlers;
// graphql.ts the /api/graphql endpoint; mcp.ts the /mcp endpoint. This file is only the router.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  authorized,
  jsonBody,
  newRepo,
  newRequestId,
  notFound,
  queryOf,
  readBody,
  repoJson,
  repos,
  segmentsOf,
  sendJson,
  sendNoContent,
  unauthorized,
} from './store.ts';
import { handleReceivePack, handleUploadPack, v0Advertisement, v2Advertisement } from './git-protocol.ts';
import {
  handleBranches,
  handleCommits,
  handleContents,
  handleIssues,
  handleLabels,
  handlePulls,
  handleRefs,
} from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

// -------------------------------------------------------------------------------- router

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing left to answer.
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = segmentsOf(req);

  // The env's boot probe: 200 {"ok":true}, no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- MCP: /mcp (Streamable HTTP JSON-RPC 2.0; auth inside, 401 without a token) ----
  if (segments.length === 1 && segments[0] === 'mcp') {
    await handleMcp(req, res);
    return;
  }

  // ---- GraphQL: /api/graphql (auth first, then the raw body: batches are arrays) ----
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const raw = await readBody(req);
    await handleGraphQL(req, res, raw);
    return;
  }

  // ---- git smart HTTP: /{owner}/{repo}.git/... -------------------------------------------
  if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const repo = owner === VIEWER_LOGIN ? repos.get(repoName) : undefined;
    if (repo === undefined) {
      notFound(res);
      return;
    }
    const rest = segments.slice(2);
    if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
      const service = queryOf(req).get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const body = v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'content-length': body.length,
          'x-github-request-id': newRequestId(),
        });
        res.end(body);
        return;
      }
      if (service === 'git-receive-pack') {
        const body = v0Advertisement(repo, 'git-receive-pack');
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-advertisement',
          'content-length': body.length,
          'x-github-request-id': newRequestId(),
        });
        res.end(body);
        return;
      }
      notFound(res);
      return;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
      const body = await readBody(req);
      const out = handleUploadPack(repo, body);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': out.length,
        'x-github-request-id': newRequestId(),
      });
      res.end(out);
      return;
    }
    if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
      const body = await readBody(req);
      const out = handleReceivePack(repo, body);
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-result',
        'content-length': out.length,
        'x-github-request-id': newRequestId(),
      });
      res.end(out);
      return;
    }
    notFound(res);
    return;
  }

  // ---- REST v3: /api/v3/... ---------------------------------------------------------------
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const rest = segments.slice(2);

    // GET /api/v3/ — the API root, 200 with the token's scopes.
    if (method === 'GET' && rest.length === 0) {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    // GET /api/v3/meta — the installed version string.
    if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // GET /api/v3/user — the token's own login.
    if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        type: 'User',
        site_admin: false,
        html_url: `https://github.com/${VIEWER_LOGIN}`,
        url: '/api/v3/user',
        created_at: '2026-11-14T06:30:00.000Z',
        updated_at: '2026-11-14T06:30:00.000Z',
      });
      return;
    }

    // POST /api/v3/user/repos — create a repository for the token's owner.
    if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const name = body['name'];
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
        return;
      }
      if (repos.has(name)) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      const repo = newRepo(name, {
        private: body['private'] === true,
        description: typeof body['description'] === 'string' ? body['description'] : null,
      });
      repos.set(name, repo);
      sendJson(res, 201, repoJson(repo));
      return;
    }

    // GET /api/v3/user/repos — list the owner's repositories, paged.
    if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
      const query = queryOf(req);
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const all = [...repos.values()].sort((a, b) => a.seq - b.seq);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers['link'] = `<${next}>; rel="next"`;
      }
      sendJson(res, 200, slice.map((repo) => repoJson(repo)), headers);
      return;
    }

    // /api/v3/repos/{owner}/{repo}[/...] — one repository and everything under it.
    if (rest.length >= 3 && rest[0] === 'repos') {
      const owner = rest[1] as string;
      const repoName = rest[2] as string;
      const repo = owner === VIEWER_LOGIN ? repos.get(repoName) : undefined;
      if (repo === undefined) {
        notFound(res);
        return;
      }
      const query = queryOf(req);
      const tail = rest.slice(3);
      if (tail.length === 0 && method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (tail.length === 0 && method === 'PATCH') {
        const body = await jsonBody(req, res);
        if (body === null) return;
        if (typeof body['description'] === 'string' || body['description'] === null) {
          repo.description = body['description'] as string | null;
        }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (tail.length === 0 && method === 'DELETE') {
        repos.delete(repoName);
        sendNoContent(res);
        return;
      }
      if (tail[0] === 'contents') {
        await handleContents(req, res, repo, tail.slice(1), query);
        return;
      }
      if (tail[0] === 'branches') {
        handleBranches(req, res, repo, tail.slice(1), query);
        return;
      }
      if (tail[0] === 'commits' && tail.length === 1) {
        handleCommits(req, res, repo, query);
        return;
      }
      if (tail[0] === 'git' && tail[1] === 'refs') {
        await handleRefs(req, res, repo, tail.slice(2));
        return;
      }
      if (tail[0] === 'labels') {
        await handleLabels(req, res, repo);
        return;
      }
      if (tail[0] === 'issues') {
        await handleIssues(req, res, repo, tail.slice(1), query);
        return;
      }
      if (tail[0] === 'pulls') {
        await handlePulls(req, res, repo, tail.slice(1), query);
        return;
      }
    }

    // Anything else under /api/v3: a JSON 404, never HTML.
    notFound(res);
    return;
  }

  // Anything else, every method: GitHub's 404 body.
  notFound(res);
}
