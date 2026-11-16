// makefun-git-forge — mcp.ts: the /mcp endpoint, Streamable HTTP JSON-RPC 2.0.
// Modern era (2026-07-28): server/discover answers the identity, capabilities and
// supported versions, no handshake, no session. Legacy era: initialize negotiates
// down to the newest 2025 revision and notifications/initialized is answered.
// tools/list is one fixed array, so two calls answer byte for byte alike; every
// tool acts on the same store as REST, through the shared create/merge helpers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  authorized,
  newRepo,
  readBody,
  repoJson,
  repos,
  sendJson,
  unauthorized,
  type Repo,
} from './store.ts';
import { createIssue, createPull, mergePullRequest } from './rest.ts';

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The one fixed tool list: deterministic order, no timestamps, identical every call. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'The pull request number (alias).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// -------------------------------------------------------------------------------- tools

/** Split tool arguments into an owner and a repo name (full_name is accepted too). */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args['owner'] === 'string' ? args['owner'] : '';
  let repo = typeof args['repo'] === 'string' ? args['repo'] : '';
  const fullName = typeof args['full_name'] === 'string' ? args['full_name'] : '';
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    if (owner === '') owner = namedOwner ?? '';
    if (repo === '') repo = namedRepo ?? '';
  }
  if (owner === '') owner = VIEWER_LOGIN;
  return { owner, repo };
}

function findRepo(args: Record<string, unknown>): Repo | null {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner !== VIEWER_LOGIN || repo === '') return null;
  return repos.get(repo) ?? null;
}

type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function toolResult(outcome: ToolOutcome): Record<string, unknown> {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: outcome.message }) }],
    isError: true,
  };
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args['name'] === 'string' ? args['name'] : '';
      if (repoName === '') return { ok: false, message: 'missing required argument: name' };
      const owner = typeof args['owner'] === 'string' && args['owner'] !== '' ? args['owner'] : VIEWER_LOGIN;
      if (owner !== VIEWER_LOGIN) return { ok: false, message: `repository owner ${owner} not found` };
      if (repos.has(repoName)) return { ok: false, message: 'Repository already exists' };
      const repo = newRepo(repoName, {
        private: args['private'] === true,
        description: typeof args['description'] === 'string' ? args['description'] : null,
      });
      repos.set(repoName, repo);
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = findRepo(args);
      if (repo === null) return { ok: false, message: 'Not Found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = findRepo(args);
      if (repo === null) return { ok: false, message: 'missing required argument: owner/repo' };
      const title = typeof args['title'] === 'string' ? args['title'] : '';
      if (title === '') return { ok: false, message: 'missing required argument: title' };
      const created = createIssue(repo, { title, body: args['body'] });
      if ('error' in created) return { ok: false, message: created.error };
      const issue = created.issue;
      return {
        ok: true,
        value: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
        },
      };
    }
    case 'list_issues': {
      const repo = findRepo(args);
      if (repo === null) return { ok: false, message: 'missing required argument: owner/repo' };
      const state = typeof args['state'] === 'string' ? args['state'] : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return {
        ok: true,
        value: list.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
        })),
      };
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      if (repo === null) return { ok: false, message: 'missing required argument: owner/repo' };
      const title = typeof args['title'] === 'string' ? args['title'] : '';
      const head = typeof args['head'] === 'string' ? args['head'] : '';
      const base = typeof args['base'] === 'string' ? args['base'] : '';
      if (title === '' || head === '' || base === '') {
        return { ok: false, message: 'missing required argument: title/head/base' };
      }
      const created = createPull(repo, { title, body: args['body'], head, base });
      if ('error' in created) return { ok: false, message: created.error };
      const pull = created.pull;
      return {
        ok: true,
        value: {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body ?? '',
          state: pull.state,
          merged: pull.merged,
          head: { ref: pull.headRef, sha: pull.headSha },
          base: { ref: pull.baseRef, sha: pull.baseSha },
        },
      };
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      if (repo === null) return { ok: false, message: 'missing required argument: owner/repo' };
      const number = typeof args['pull_number'] === 'number' ? args['pull_number'] : typeof args['number'] === 'number' ? args['number'] : null;
      if (number === null) return { ok: false, message: 'missing required argument: pull_number' };
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { ok: false, message: `pull request #${number} not found` };
      const merged = mergePullRequest(repo, pull);
      if ('error' in merged) return { ok: false, message: merged.error };
      return {
        ok: true,
        value: {
          number: pull.number,
          merged: true,
          state: pull.state,
          sha: merged.sha,
          message: merged.message,
        },
      };
    }
    default:
      return { ok: false, message: `unknown tool: ${name}` };
  }
}

// -------------------------------------------------------------------------------- endpoint

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** POST /mcp: one JSON-RPC 2.0 request per call; a body that is not JSON is a 400/-32700. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Best effort: echo the id when the truncated body still carries one.
    let id: unknown = null;
    const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(text);
    if (match !== null) {
      const rawId = match[1] as string;
      id = rawId.startsWith('"') ? rawId.slice(1, -1) : Number.parseInt(rawId, 10);
    }
    sendJson(res, 400, rpcError(id, -32700, 'Parse error'));
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const record = parsed as Record<string, unknown>;
  const id = record['id'] ?? null;
  const method = typeof record['method'] === 'string' ? record['method'] : '';
  const params = record['params'] !== null && typeof record['params'] === 'object' && !Array.isArray(record['params'])
    ? (record['params'] as Record<string, unknown>)
    : {};

  // A notification (no id) gets no JSON-RPC answer.
  if (record['id'] === undefined) {
    res.writeHead(202, { 'x-github-request-id': 'forge-mcp' });
    res.end();
    return;
  }

  switch (method) {
    case 'server/discover': {
      sendJson(
        res,
        200,
        rpcResult(id, {
          protocolVersion: MODERN_REVISION,
          supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      return;
    }
    case 'initialize': {
      const offered = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : '2025-11-25';
      sendJson(
        res,
        200,
        rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      return;
    }
    case 'notifications/initialized':
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const toolName = typeof params['name'] === 'string' ? params['name'] : '';
      const args =
        params['arguments'] !== null && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
          ? (params['arguments'] as Record<string, unknown>)
          : {};
      if (toolName === '') {
        sendJson(res, 200, rpcError(id, -32602, 'Invalid params: tools/call needs a tool name'));
        return;
      }
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
        return;
      }
      sendJson(res, 200, rpcResult(id, toolResult(callTool(toolName, args))));
      return;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return;
    }
  }
}
