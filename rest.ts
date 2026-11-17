// REST v3 (GitHub-style) over /api/v3. All answers are JSON with an
// X-GitHub-Request-Id header (added by the app layer); errors are
// {"message": string}. Authentication is the Bearer token checked by the app
// layer (a missing token is a 401 before any handler runs). Issues and pull
// requests share one per-repo number sequence, as on GitHub, and every object
// carries a stable REST id plus a stable opaque global id.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commentGlobalId,
  diffTrees,
  flattenTree,
  hashObject,
  lineDiff,
  parseCommit,
  parseTree,
  repoGlobalId,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200): RestResponse {
  return { status, body };
}
export function created(body: unknown): RestResponse {
  return { status: 201, body };
}
export function noContent(): RestResponse {
  return { status: 204, body: null };
}
export function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

/** A synthetic, stable timestamp for an object created at global sequence `seq`. */
function at(seq: number): string {
  return new Date(1700000000000 + seq * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: at(repo.createdOrder),
    updated_at: at(repo.createdOrder),
    pushed_at: at(repo.createdOrder),
    git_url: `git://example.invalid/${repo.fullName}.git`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    html_url: `https://example.invalid/${repo.fullName}`,
    has_issues: true,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  let id = 0;
  for (let i = 0; i < label.name.length; i += 1) id = (id * 31 + label.name.charCodeAt(i)) >>> 0;
  return { id, node_id: `label:${label.name}`, name: label.name, color: label.color, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => ({ name })),
    created_at: at(issue.createdSeq),
    updated_at: at(issue.createdSeq),
    closed_at: issue.state === 'closed' ? at(issue.createdSeq) : null,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: at(pull.createdSeq),
    updated_at: at(pull.createdSeq),
    closed_at: pull.state === 'closed' ? at(pull.createdSeq) : null,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: at(comment.createdSeq),
    updated_at: at(comment.createdSeq),
    html_url: `https://example.invalid/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------------------
// Routing. `segments` is the path after /api/v3.
// ---------------------------------------------------------------------------

export function handleRest(
  store: Store,
  segments: readonly string[],
  query: URLSearchParams,
  method: string,
  body: unknown,
  origin = 'http://127.0.0.1',
): RestResponse {
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Number(query.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const repos = store.listReposByOwner(VIEWER_LOGIN);
      const start = (page - 1) * perPage;
      const slice = repos.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < repos.length) {
        headers.Link = `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      return { status: 200, body: slice.map(repoJson), headers };
    }
    if (method === 'POST') {
      const data = body as { name?: unknown; private?: unknown; description?: unknown } | null;
      if (data === null || typeof data.name !== 'string' || data.name === '') return err(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, data.name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, data.name, {
        private: data.private === true,
        description: typeof data.description === 'string' ? data.description : '',
      });
      return created(repoJson(repo));
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'repos') return handleRepoRest(store, segments.slice(1), query, method, body);
  return err(404, 'Not Found');
}

function handleRepoRest(store: Store, segments: readonly string[], query: URLSearchParams, method: string, body: unknown): RestResponse {
  const [owner, name, ...rest] = segments;
  if (owner === undefined || name === undefined) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const data = body as { description?: unknown } | null;
      if (data !== null && typeof data.description === 'string') repo.description = data.description;
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  const [head, ...tail] = rest;
  switch (head) {
    case 'branches': {
      if (tail.length === 0) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort();
        return ok(branches.map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? null } })));
      }
      if (tail.length === 1 && method === 'GET') {
        const sha = store.branchTip(repo, tail[0] as string);
        if (sha === null) return err(404, 'Branch not found');
        return ok({ name: tail[0], commit: { sha } });
      }
      return err(404, 'Not Found');
    }
    case 'commits': {
      if (tail.length !== 0 || method !== 'GET') return err(404, 'Not Found');
      const ref = query.get('sha') ?? undefined;
      const tip = ref === undefined ? store.branchTip(repo, repo.defaultBranch) : store.resolveRef(repo, ref);
      if (tip === null) return err(404, 'Not Found');
      return ok(
        store.commitsFrom(repo, tip).map((oid) => {
          const object = repo.objects.get(oid);
          const message = object !== undefined && object.type === 'commit' ? parseCommit(object.data).message : '';
          return { sha: oid, commit: { message } };
        }),
      );
    }
    case 'contents': {
      const path = tail.join('/');
      if (method === 'GET') return getContents(store, repo, path, query.get('ref') ?? undefined);
      if (method === 'PUT') return putContents(store, repo, path, body);
      if (method === 'DELETE') return deleteContents(store, repo, path, body);
      return err(404, 'Not Found');
    }
    case 'labels': {
      if (method === 'GET' && tail.length === 0) return ok([...repo.labels.values()].map(labelJson));
      if (method === 'POST' && tail.length === 0) {
        const data = body as { name?: unknown; color?: unknown } | null;
        if (data === null || typeof data.name !== 'string' || data.name === '') return err(422, 'name is required');
        const existing = repo.labels.get(data.name);
        if (existing !== undefined) return ok(labelJson(existing));
        const label: Label = { name: data.name, color: typeof data.color === 'string' ? data.color : 'ededed' };
        repo.labels.set(data.name, label);
        return created(labelJson(label));
      }
      return err(404, 'Not Found');
    }
    case 'issues': {
      if (tail.length === 0) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          issues = [...issues].sort((a, b) =>
            sort === 'created' ? (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq) : a.number - b.number,
          );
          return ok(issues.map((issue) => issueJson(repo, issue)));
        }
        if (method === 'POST') {
          const data = body as { title?: unknown; body?: unknown; labels?: unknown } | null;
          if (data === null || typeof data.title !== 'string' || data.title === '') return err(422, 'title is required');
          const labels = Array.isArray(data.labels) ? data.labels.filter((x): x is string => typeof x === 'string') : [];
          for (const label of labels) {
            if (repo.labels.get(label) === undefined) return err(422, `label ${label} does not exist`);
          }
          const issue = store.createIssue(repo, data.title, typeof data.body === 'string' ? data.body : '', labels);
          return created(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number(tail[0]);
      if (!Number.isSafeInteger(number)) return err(404, 'Not Found');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (tail.length === 1) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(issueJson(repo, issue));
        if (method === 'PATCH') {
          const data = body as { state?: unknown } | null;
          if (data !== null && (data.state === 'open' || data.state === 'closed')) issue.state = data.state;
          return ok(issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail[1] === 'comments' && tail.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(issue.comments.map((comment) => commentJson(repo, number, comment)));
        if (method === 'POST') {
          const data = body as { body?: unknown } | null;
          if (data === null || typeof data.body !== 'string') return err(422, 'body is required');
          const comment: Comment = {
            id: store.nextCommentId,
            globalId: commentGlobalId(repo.owner, repo.name, number, store.nextCommentId),
            body: data.body,
            createdSeq: store.nextGlobalSeq,
          };
          store.nextCommentId += 1;
          store.nextGlobalSeq += 1;
          issue.comments.push(comment);
          return created(commentJson(repo, number, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    case 'pulls': {
      if (tail.length === 0) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          return ok(pulls.map((pull) => pullJson(repo, pull)));
        }
        if (method === 'POST') {
          const data = body as { title?: unknown; head?: unknown; base?: unknown; body?: unknown } | null;
          if (data === null || typeof data.head !== 'string' || typeof data.base !== 'string') return err(422, 'head and base are required');
          const headSha = store.branchTip(repo, data.head);
          const baseSha = store.branchTip(repo, data.base);
          if (headSha === null || baseSha === null) return err(422, 'head or base branch does not exist');
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === data.head);
          if (duplicate !== undefined) return err(422, 'a pull request for this head already exists');
          const pull = store.createPull(repo, {
            title: typeof data.title === 'string' ? data.title : '',
            body: typeof data.body === 'string' ? data.body : '',
            head: data.head,
            base: data.base,
            headSha,
            baseSha,
          });
          return created(pullJson(repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number(tail[0]);
      if (!Number.isSafeInteger(number)) return err(404, 'Not Found');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (tail.length === 1) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
        if (pull === undefined) return err(404, 'Not Found');
        return ok(pullFiles(store, repo, pull));
      }
      if (tail[1] === 'merge' && tail.length === 2 && method === 'PUT') {
        if (pull === undefined) return err(404, 'Not Found');
        const merged = store.mergePull(repo, pull);
        if (merged === null) return err(405, 'This pull request cannot be merged');
        return ok({ sha: merged, merged: true, message: pull.title });
      }
      return err(404, 'Not Found');
    }
    case 'git': {
      if (tail[0] === 'refs' && method === 'POST' && tail.length === 1) {
        const data = body as { ref?: unknown; sha?: unknown } | null;
        if (data === null || typeof data.ref !== 'string' || typeof data.sha !== 'string') return err(422, 'ref and sha are required');
        const match = /^refs\/heads\/(.+)$/.exec(data.ref);
        if (match === null) return err(422, 'only branch refs are supported');
        if (repo.objects.get(data.sha) === undefined) return err(422, 'sha does not exist');
        if (repo.refs.has(data.ref)) return err(422, 'ref already exists');
        repo.refs.set(data.ref, data.sha);
        return created({ ref: data.ref, object: { sha: data.sha } });
      }
      if (tail[0] === 'refs' && tail[1] === 'heads' && tail.length === 3 && method === 'GET') {
        const sha = store.branchTip(repo, tail[2] as string);
        if (sha === null) return err(404, 'Not Found');
        return ok({ ref: `refs/heads/${tail[2]}`, object: { sha } });
      }
      return err(404, 'Not Found');
    }
    default:
      return err(404, 'Not Found');
  }
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

/** Walk a tree to `path`; returns the entry (tree or blob) or null. */
function findTreeEntry(repo: Repo, treeOid: string, path: string): { type: 'tree' | 'blob'; oid: string } | null {
  if (path === '') return { type: 'tree', oid: treeOid };
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) return { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function getContents(store: Store, repo: Repo, path: string, ref: string | undefined): RestResponse {
  const tip = ref === undefined ? store.branchTip(repo, repo.defaultBranch) : store.resolveRef(repo, ref);
  if (tip === null) return err(404, 'Not Found');
  const treeOid = store.commitTree(repo, tip);
  if (treeOid === null) return err(404, 'Not Found');
  const entry = findTreeEntry(repo, treeOid, path);
  if (entry === null) return err(404, 'Not Found');
  if (entry.type === 'tree') {
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'tree') return err(404, 'Not Found');
    const children = parseTree(object.data).map((child) => ({
      type: child.mode === '40000' ? 'dir' : 'file',
      name: child.name,
      path: path === '' ? child.name : `${path}/${child.name}`,
      sha: child.oid,
      size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
    }));
    return ok(children);
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return err(404, 'Not Found');
  return ok({
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: path.split('/').pop(),
    path,
    content: blob.data.toString('base64'),
    sha: entry.oid,
  });
}

function putContents(store: Store, repo: Repo, path: string, body: unknown): RestResponse {
  const data = body as { message?: unknown; content?: unknown; branch?: unknown; sha?: unknown } | null;
  if (data === null || typeof data.content !== 'string') return err(422, 'content is required');
  const branch = typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
  let content: Buffer;
  try {
    content = Buffer.from(data.content, 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const tip = store.branchTip(repo, branch);
  const treeOid = tip === null ? null : store.commitTree(repo, tip);
  if (typeof data.sha === 'string') {
    const current = treeOid === null ? null : store.blobAtPath(repo, treeOid, path);
    if (current === null || current !== data.sha) return err(409, 'sha does not match the current file');
  }
  const isUpdate = treeOid !== null && store.blobAtPath(repo, treeOid, path) !== null;
  const blobOid = hashObject('blob', content);
  if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: content });
  const newTree = store.setPathInTree(repo, treeOid, path, blobOid);
  const commitOid = store.createCommit(repo, {
    tree: newTree,
    parents: tip === null ? [] : [tip],
    message: typeof data.message === 'string' ? data.message : `Update ${path}`,
  });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return ok(
    {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message: typeof data.message === 'string' ? data.message : '' },
    },
    isUpdate ? 200 : 201,
  );
}

function deleteContents(store: Store, repo: Repo, path: string, body: unknown): RestResponse {
  const data = body as { message?: unknown; branch?: unknown; sha?: unknown } | null;
  const branch = data !== null && typeof data.branch === 'string' ? data.branch : repo.defaultBranch;
  const tip = store.branchTip(repo, branch);
  if (tip === null) return err(404, 'Not Found');
  const treeOid = store.commitTree(repo, tip);
  if (treeOid === null) return err(404, 'Not Found');
  if (store.blobAtPath(repo, treeOid, path) === null) return err(404, 'Not Found');
  if (typeof data?.sha === 'string' && store.blobAtPath(repo, treeOid, path) !== data.sha) return err(409, 'sha does not match the current file');
  const newTree = store.setPathInTree(repo, treeOid, path, null);
  const commitOid = store.createCommit(repo, {
    tree: newTree,
    parents: [tip],
    message: typeof data?.message === 'string' ? data.message : `Delete ${path}`,
  });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return ok({ commit: { sha: commitOid } });
}

/** The files a pull request changes, with additions/deletions counted from line diffs. */
function pullFiles(store: Store, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const lookup = (oid: string) => repo.objects.get(oid);
  const baseTree = pull.baseSha === '' ? null : store.commitTree(repo, pull.baseSha);
  const headTree = pull.headSha === '' ? null : store.commitTree(repo, pull.headSha);
  if (baseTree === null && headTree === null) return [];
  const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const changes = diffTrees(baseTree ?? emptyTree, headTree ?? emptyTree, lookup);
  const files: Array<Record<string, unknown>> = [];
  for (const change of changes) {
    let additions = 0;
    let deletions = 0;
    if (change.status === 'added') {
      additions = countLines(repo, change.newOid as string);
    } else if (change.status === 'removed') {
      deletions = countLines(repo, change.oldOid as string);
    } else {
      const before = blobText(repo, change.oldOid as string);
      const after = blobText(repo, change.newOid as string);
      const counted = lineDiff(before, after);
      additions = counted.additions;
      deletions = counted.deletions;
      if (additions === 0 && deletions === 0) additions = 1;
    }
    files.push({ filename: change.path, status: change.status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function countLines(repo: Repo, oid: string): number {
  const text = blobText(repo, oid);
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Exported for the GraphQL and MCP layers: the repo object in REST shape. */
export function repoJsonFor(repo: Repo): Record<string, unknown> {
  return repoJson(repo);
}

export function issueJsonFor(repo: Repo, issue: Issue): Record<string, unknown> {
  return issueJson(repo, issue);
}

export function pullJsonFor(repo: Repo, pull: Pull): Record<string, unknown> {
  return pullJson(repo, pull);
}

export function flattenTreeFor(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  return flattenTree(treeOid, (oid) => repo.objects.get(oid));
}
