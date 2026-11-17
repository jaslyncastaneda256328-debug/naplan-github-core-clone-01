// MCP over POST /mcp: JSON-RPC 2.0 Streamable HTTP, era 2026-07-28.
// `server/discover` answers without a handshake and without a session; `initialize`
// is kept as a fallback. A request without an id is a notification and gets a 202
// with an empty body. The tools list is one module-level constant, so two
// `tools/list` calls return the identical array byte for byte. Every tool result
// carries both `content` (text JSON) and `structuredContent`.

import {
  VIEWER_LOGIN,
  commentGlobalId,
  type Store,
} from './store.ts';
import { issueJsonFor, pullJsonFor, repoJsonFor } from './rest.ts';

const SERVER_NAME = 'naplan-github-forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

/** The one and only tools list. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        description: { type: 'string', description: 'A short description of the repository.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to attach.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the viewer\'s repositories.',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'integer', description: 'How many repositories to return.' },
        page: { type: 'integer', description: 'Which page to return.' },
      },
    },
  },
];

interface McpResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}
function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A tool result: text JSON plus the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function missingArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null || value === '') return `Missing required argument: ${name}`;
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const lookup = (owner: unknown, repo: unknown) => {
    if (typeof owner !== 'string' || typeof repo !== 'string') return null;
    return store.getRepo(owner, repo) ?? null;
  };
  switch (name) {
    case 'create_repo': {
      const problem = missingArg(args, 'name');
      if (problem !== null) return toolError(problem);
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError('Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolResult(repoJsonFor(repo));
    }
    case 'get_repo': {
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      return toolResult(repoJsonFor(repo));
    }
    case 'create_issue': {
      for (const field of ['owner', 'repo', 'title']) {
        const problem = missingArg(args, field);
        if (problem !== null) return toolError(problem);
      }
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (repo.labels.get(label) === undefined) return toolError(`label ${label} does not exist`);
      }
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', labels);
      return toolResult(issueJsonFor(repo, issue));
    }
    case 'list_issues': {
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJsonFor(repo, issue));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      for (const field of ['owner', 'repo', 'title', 'head', 'base']) {
        const problem = missingArg(args, field);
        if (problem !== null) return toolError(problem);
      }
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const head = String(args.head);
      const base = String(args.base);
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) return toolError('head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head);
      if (duplicate !== undefined) return toolError('a pull request for this head already exists');
      const pull = store.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
        headSha,
        baseSha,
      });
      return toolResult(pullJsonFor(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const number = Number(args.pull_number);
      if (!Number.isSafeInteger(number)) return toolError('Missing required argument: pull_number');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return toolError('Not Found');
      const merged = store.mergePull(repo, pull);
      if (merged === null) return toolError('This pull request cannot be merged');
      return toolResult({ sha: merged, merged: true, message: pull.title });
    }
    case 'get_issue': {
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.issue_number));
      if (issue === undefined) return toolError('Not Found');
      return toolResult(issueJsonFor(repo, issue));
    }
    case 'list_pull_requests': {
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .map((pull) => pullJsonFor(repo, pull));
      return toolResult({ pull_requests: pulls });
    }
    case 'create_comment': {
      for (const field of ['owner', 'repo', 'issue_number', 'body']) {
        const problem = missingArg(args, field);
        if (problem !== null) return toolError(problem);
      }
      const repo = lookup(args.owner, args.repo);
      if (repo === null) return toolError('Not Found');
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.issue_number));
      if (issue === undefined) return toolError('Not Found');
      const comment = {
        id: store.nextCommentId,
        globalId: commentGlobalId(repo.owner, repo.name, issue.number, store.nextCommentId),
        body: String(args.body),
        createdSeq: store.nextGlobalSeq,
      };
      store.nextCommentId += 1;
      store.nextGlobalSeq += 1;
      issue.comments.push(comment);
      return toolResult({ id: comment.id, node_id: comment.globalId, body: comment.body });
    }
    case 'list_repos': {
      const perPage = typeof args.per_page === 'number' ? Math.max(1, args.per_page) : 30;
      const page = typeof args.page === 'number' ? Math.max(1, args.page) : 1;
      const repos = store.listReposByOwner(VIEWER_LOGIN);
      return toolResult({ repositories: repos.slice((page - 1) * perPage, page * perPage).map(repoJsonFor) });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function handleOne(store: Store, request: unknown): McpResponse {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = request as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = id !== undefined && id !== null;
  if (typeof method !== 'string') return rpcError(hasId ? id : null, -32600, 'Invalid Request');
  // A notification (no id) is acknowledged with 202 and an empty body.
  if (!hasId) return { status: 202, body: null };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof call.name !== 'string') return rpcError(id, -32602, 'tools/call requires a tool name');
      const tool = TOOLS.find((candidate) => candidate.name === call.name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${call.name}`);
      const args = call.arguments !== null && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? (call.arguments as Record<string, unknown>)
        : {};
      for (const required of tool.inputSchema.required ?? []) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      const result = callTool(store, call.name, args);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle a POST /mcp body (raw text, so a parse failure can still answer -32700). */
export function handleMcp(store: Store, rawBody: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    const match = /"id"\s*:\s*("([^"]*)"|(-?\d+))/.exec(rawBody);
    const id = match === null ? null : match[2] !== undefined ? match[2] : Number(match[3]);
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((request) => handleOne(store, request));
    return { status: 200, body: results.map((result) => result.body) };
  }
  return handleOne(store, parsed);
}
