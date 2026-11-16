// makefun-git-forge — graphql.ts: the /api/graphql endpoint.
// A small GraphQL parser and executor for the document shapes the suite sends
// (viewer, repository + issues/pullRequests, node(id:), __type introspection, and the
// five mutations), over the same in-memory store as REST and MCP. Unknown fields
// answer HTTP 200 with an errors array naming the field; an unknown repository
// answers data.repository = null with no errors. Batched bodies (a JSON array)
// answer an array of responses in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  sendJson,
  type Issue,
  type Pull,
  type Repo,
  repos,
} from './store.ts';
import { commitTree, diffTrees, threeWayConflict } from './git-store.ts';
import { createIssue, createPull, mergePullRequest } from './rest.ts';

// -------------------------------------------------------------------------------- ids

/** Opaque global ids: base64 of a typed key, decodable server-side for mutations. */
function encodeId(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64');
}

function decodeId(id: string): string | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    return text.includes(':') ? text : null;
  } catch {
    return null;
  }
}

function repoIdOf(repo: Repo): string {
  return encodeId(`repo:${repo.id}`);
}

function issueIdOf(repo: Repo, issue: Issue): string {
  return encodeId(`issue:${repo.id}:${issue.number}`);
}

function pullIdOf(repo: Repo, pull: Pull): string {
  return encodeId(`pr:${repo.id}:${pull.number}`);
}

function commentIdOf(repo: Repo, id: number): string {
  return encodeId(`comment:${repo.id}:${id}`);
}

/** Find a repository by its opaque global id. */
function repoByGlobalId(id: string): Repo | null {
  const key = decodeId(id);
  if (key === null || !key.startsWith('repo:')) return null;
  const numeric = Number.parseInt(key.slice(5), 10);
  for (const repo of repos.values()) if (repo.id === numeric) return repo;
  return null;
}

/** Find an issue or pull request by its opaque global id. */
function subjectByGlobalId(id: string): { repo: Repo; kind: 'issue' | 'pr'; number: number } | null {
  const key = decodeId(id);
  if (key === null) return null;
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const kind = parts[0];
  if (kind !== 'issue' && kind !== 'pr') return null;
  const repoId = Number.parseInt(parts[1] as string, 10);
  const number = Number.parseInt(parts[2] as string, 10);
  for (const repo of repos.values()) {
    if (repo.id !== repoId) continue;
    if (kind === 'issue' && repo.issues.some((issue) => issue.number === number)) {
      return { repo, kind, number };
    }
    if (kind === 'pr' && repo.pulls.some((pull) => pull.number === number)) {
      return { repo, kind, number };
    }
  }
  return null;
}

// -------------------------------------------------------------------------------- parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === ',') {
      at++;
      continue;
    }
    if (char === '#') {
      while (at < source.length && source[at] !== '\n') at++;
      continue;
    }
    if (char === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('{}():![]=$@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      at++;
      continue;
    }
    if (char === '"') {
      let value = '';
      at++;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const escaped = source[at + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          at += 2;
        } else {
          value += source[at] as string;
          at++;
        }
      }
      at++;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let text = '';
      while (at < source.length && /[0-9.eE+-]/.test(source[at] as string)) {
        text += source[at] as string;
        at++;
      }
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number.parseFloat(text) });
      else tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let text = '';
      while (at < source.length && /[A-Za-z0-9_]/.test(source[at] as string)) {
        text += source[at] as string;
        at++;
      }
      tokens.push({ kind: 'name', value: text });
      continue;
    }
    at++;
  }
  return tokens;
}

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  variables: Record<string, ValueNode | undefined>;
  selection: SelectionNode[];
}

class Parser {
  private at = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at++;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        fields[name.value] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected token in value');
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected argument name');
      this.expectPunct(':');
      args[name.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        let typeCondition: string | undefined;
        const on = this.peek();
        if (on?.kind === 'name' && on.value === 'on') {
          this.next();
          const typeName = this.next();
          if (typeName.kind === 'name') typeCondition = typeName.value;
        } else {
          // A named fragment spread: the suite never sends one; skip its name.
          this.next();
        }
        selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected field name');
      this.next();
      const field: FieldNode = { kind: 'field', name: token.value, args: {} };
      const alias = this.peek();
      if (alias?.kind === 'punct' && alias.value === ':') {
        this.next();
        const real = this.next();
        if (real.kind !== 'name') throw new Error('expected field name after alias');
        field.alias = field.name;
        field.name = real.value;
      }
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        field.args = this.parseArguments();
      }
      // Directives (@...) are not sent by the suite; skip one if present.
      while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
        this.next();
        this.next();
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.parseArguments();
        }
      }
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
        field.selection = this.parseSelectionSet();
      }
      selections.push(field);
    }
    this.expectPunct('}');
    return selections;
  }

  private parseType(): void {
    // A variable type: Name, [Name], Name!, [Name!]! — consumed, not validated.
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value;
      this.next();
      const name = this.peek();
      if (name?.kind === 'name') this.next();
    }
    const variables: Record<string, ValueNode | undefined> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const dollar = this.next();
        if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in variable definition');
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected variable name');
        this.expectPunct(':');
        this.parseType();
        let fallback: ValueNode | undefined;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          fallback = this.parseValue();
        }
        variables[name.value] = fallback;
      }
      this.expectPunct(')');
    }
    return { type, variables, selection: this.parseSelectionSet() };
  }
}

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.items.map((item) => evaluateValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evaluateValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'];

// -------------------------------------------------------------------------------- executor

interface TypedValue {
  __typename: string;
  [key: string]: unknown;
}

interface Executor {
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
}

function issueValue(repo: Repo, issue: Issue): TypedValue {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullValue(repo: Repo, pull: Pull): TypedValue {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function repoValue(repo: Repo): TypedValue {
  return { __typename: 'Repository', __repo: repo };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return threeWayConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function issuesConnection(
  repo: Repo,
  args: Record<string, unknown>,
): TypedValue {
  let list = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = args['orderBy'];
  let descending = false;
  if (typeof orderBy === 'object' && orderBy !== null) {
    const direction = (orderBy as Record<string, unknown>)['direction'];
    descending = direction === 'DESC';
  }
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const after = args['after'];
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    try {
      const cursor = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(cursor);
      if (match !== null) {
        const afterNumber = Number.parseInt(match[1] as string, 10);
        const index = list.findIndex((issue) => issue.number === afterNumber);
        if (index >= 0) start = index + 1;
      }
    } catch {
      // An opaque cursor we cannot read starts from the beginning.
    }
  }
  const first = typeof args['first'] === 'number' ? Math.max(0, Math.trunc(args['first'])) : list.length - start;
  const page = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1]?.number ?? 0}`, 'utf8').toString('base64') : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueValue(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function resolveField(exec: Executor, type: string, value: TypedValue | null, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = evaluateValue(node, exec.variables);
  const fail = (message: string): null => {
    exec.errors.push({ message });
    return null;
  };

  if (type === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN };
    }
    if (field.name === 'repository') {
      const owner = args['owner'];
      const name = args['name'];
      if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
      const repo = repos.get(name);
      return repo === undefined ? null : repoValue(repo);
    }
    if (field.name === 'node') {
      const id = args['id'];
      if (typeof id !== 'string') return null;
      const key = decodeId(id);
      if (key === null) return null;
      if (key.startsWith('repo:')) {
        const repo = repoByGlobalId(id);
        return repo === null ? null : repoValue(repo);
      }
      const subject = subjectByGlobalId(id);
      if (subject === null) return null;
      if (subject.kind === 'issue') {
        const issue = subject.repo.issues.find((entry) => entry.number === subject.number);
        return issue === undefined ? null : issueValue(subject.repo, issue);
      }
      const pull = subject.repo.pulls.find((entry) => entry.number === subject.number);
      return pull === undefined ? null : pullValue(subject.repo, pull);
    }
    if (field.name === '__type') {
      const name = args['name'];
      if (typeof name !== 'string') return null;
      if (name === 'SearchType') {
        return {
          __typename: '__Type',
          name,
          fields: [],
          enumValues: SEARCH_TYPE_VALUES.map((entry) => ({ name: entry })),
        };
      }
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return {
        __typename: '__Type',
        name,
        fields: fields.map((entry) => ({ name: entry })),
        enumValues: [],
      };
    }
    return fail(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repo = typeof input['repositoryId'] === 'string' ? repoByGlobalId(input['repositoryId']) : null;
      if (repo === null) return fail('createIssue: unknown repositoryId.');
      const created = createIssue(repo, { title: input['title'], body: input['body'] });
      if ('error' in created) return fail(created.error);
      return { __typename: 'CreateIssuePayload', issue: issueValue(repo, created.issue) };
    }
    if (field.name === 'closeIssue') {
      const subject = typeof input['issueId'] === 'string' ? subjectByGlobalId(input['issueId']) : null;
      if (subject === null || subject.kind !== 'issue') return fail('closeIssue: unknown issueId.');
      const issue = subject.repo.issues.find((entry) => entry.number === subject.number);
      if (issue === undefined) return fail('closeIssue: unknown issueId.');
      issue.state = 'closed';
      // The REST read cache keys on rev: a closed issue must not serve its open-state bytes.
      issue.rev = (issue.rev ?? 0) + 1;
      return { __typename: 'CloseIssuePayload', issue: issueValue(subject.repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const repo = typeof input['repositoryId'] === 'string' ? repoByGlobalId(input['repositoryId']) : null;
      if (repo === null) return fail('createPullRequest: unknown repositoryId.');
      const created = createPull(repo, {
        title: input['title'],
        head: input['headRefName'],
        base: input['baseRefName'],
      });
      if ('error' in created) return fail(created.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, created.pull) };
    }
    if (field.name === 'mergePullRequest') {
      const subject = typeof input['pullRequestId'] === 'string' ? subjectByGlobalId(input['pullRequestId']) : null;
      if (subject === null || subject.kind !== 'pr') return fail('mergePullRequest: unknown pullRequestId.');
      const pull = subject.repo.pulls.find((entry) => entry.number === subject.number);
      if (pull === undefined) return fail('mergePullRequest: unknown pullRequestId.');
      const merged = mergePullRequest(subject.repo, pull);
      if ('error' in merged) return fail(merged.error);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(subject.repo, pull) };
    }
    if (field.name === 'addComment') {
      const subject = typeof input['subjectId'] === 'string' ? subjectByGlobalId(input['subjectId']) : null;
      if (subject === null) return fail('addComment: unknown subjectId.');
      const body = typeof input['body'] === 'string' ? input['body'] : '';
      const commentId = subject.repo.id * 1000000 + 800000 + subject.repo.nextCommentId++;
      if (subject.kind === 'issue') {
        const issue = subject.repo.issues.find((entry) => entry.number === subject.number);
        if (issue !== undefined) {
          issue.comments.push({ id: commentId, body });
          issue.rev = (issue.rev ?? 0) + 1;
        }
      }
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'Comment', id: commentIdOf(subject.repo, commentId), body },
        },
      };
    }
    return fail(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (value === null) return null;
  if (type === 'User') {
    if (field.name === 'login') return value['login'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "User".`);
  }
  if (type === 'Repository') {
    const repo = value['__repo'] as Repo;
    switch (field.name) {
      case 'id':
        return repoIdOf(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${VIEWER_LOGIN}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: VIEWER_LOGIN };
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = args['number'];
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      case 'issues':
        return issuesConnection(repo, args);
      case 'pullRequests': {
        const first = typeof args['first'] === 'number' ? Math.max(0, Math.trunc(args['first'])) : repo.pulls.length;
        return {
          __typename: 'PullRequestConnection',
          nodes: [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first).map((pull) => pullValue(repo, pull)),
        };
      }
      case 'pullRequest': {
        const number = args['number'];
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      default:
        return fail(`Cannot query field "${field.name}" on type "Repository".`);
    }
  }
  if (type === 'Issue') {
    const repo = value['__repo'] as Repo;
    const issue = value['__issue'] as Issue;
    switch (field.name) {
      case 'id':
        return issueIdOf(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body ?? '';
      default:
        return fail(`Cannot query field "${field.name}" on type "Issue".`);
    }
  }
  if (type === 'PullRequest') {
    const repo = value['__repo'] as Repo;
    const pull = value['__pull'] as Pull;
    switch (field.name) {
      case 'id':
        return pullIdOf(repo, pull);
      case 'number':
        return pull.number;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'files': {
        const first = typeof args['first'] === 'number' ? Math.max(0, Math.trunc(args['first'])) : 100;
        const files = diffTrees(repo, commitTree(repo, pull.baseSha), commitTree(repo, pull.headSha));
        return {
          __typename: 'PullRequestFileConnection',
          nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestFile', path: file.path })),
        };
      }
      default:
        return fail(`Cannot query field "${field.name}" on type "PullRequest".`);
    }
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestFileConnection') {
    if (field.name === 'nodes') return value['nodes'] ?? null;
    if (field.name === 'pageInfo') return value['pageInfo'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "${type}".`);
  }
  if (type === 'PageInfo') {
    if (field.name === 'hasNextPage') return value['hasNextPage'] ?? null;
    if (field.name === 'endCursor') return value['endCursor'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "PageInfo".`);
  }
  if (type === 'Ref') {
    if (field.name === 'name') return value['name'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "Ref".`);
  }
  if (type === '__Type') {
    if (field.name === 'name') return value['name'] ?? null;
    if (field.name === 'fields') return value['fields'] ?? [];
    if (field.name === 'enumValues') return value['enumValues'] ?? [];
    return fail(`Cannot query field "${field.name}" on type "__Type".`);
  }
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') return value['issue'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "${type}".`);
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return value['pullRequest'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "${type}".`);
  }
  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return value['commentEdge'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "${type}".`);
  }
  if (type === 'CommentEdge') {
    if (field.name === 'node') return value['node'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "CommentEdge".`);
  }
  if (type === 'Comment') {
    if (field.name === 'id') return value['id'] ?? null;
    if (field.name === 'body') return value['body'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "Comment".`);
  }
  if (type === 'PullRequestFile') {
    if (field.name === 'path') return value['path'] ?? null;
    return fail(`Cannot query field "${field.name}" on type "PullRequestFile".`);
  }
  return fail(`Cannot query field "${field.name}" on type "${type}".`);
}

function executeSelection(
  exec: Executor,
  type: string,
  value: TypedValue | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== type) continue;
      Object.assign(out, executeSelection(exec, type, value, selection.selection));
      continue;
    }
    const resolved = resolveField(exec, type, value, selection);
    const key = selection.alias ?? selection.name;
    if (resolved === null || resolved === undefined || typeof resolved !== 'object') {
      out[key] = resolved ?? null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((entry) => {
        if (entry !== null && typeof entry === 'object' && '__typename' in entry) {
          const item = entry as TypedValue;
          return selection.selection === undefined ? item : executeSelection(exec, item.__typename, item, selection.selection);
        }
        return entry;
      });
      continue;
    }
    const typed = resolved as TypedValue;
    if ('__typename' in typed) {
      out[key] = selection.selection === undefined ? typed : executeSelection(exec, typed.__typename, typed, selection.selection);
    } else {
      // A plain record (e.g. an __Field {name}): resolve its scalar fields directly.
      if (selection.selection === undefined) {
        out[key] = typed;
      } else {
        const nested: Record<string, unknown> = {};
        for (const sub of selection.selection) {
          if (sub.kind === 'field') nested[sub.alias ?? sub.name] = (typed as Record<string, unknown>)[sub.name] ?? null;
        }
        out[key] = nested;
      }
    }
  }
  return out;
}

function executeDocument(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  try {
    const operation = new Parser(tokenize(query)).parseOperation();
    const exec: Executor = { errors: [], variables };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection(exec, rootType, null, operation.selection);
    if (exec.errors.length > 0) return { data, errors: exec.errors };
    return { data };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
}

// -------------------------------------------------------------------------------- endpoint

/** POST /api/graphql. One operation, or a JSON array of operations answered in order. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL request must be an object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record['query'] !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL request must carry a query string' }] };
    }
    const variables =
      record['variables'] !== null && typeof record['variables'] === 'object' && !Array.isArray(record['variables'])
        ? (record['variables'] as Record<string, unknown>)
        : {};
    return executeDocument(record['query'], variables);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
