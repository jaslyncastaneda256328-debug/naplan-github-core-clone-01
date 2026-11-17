// The forge's in-memory store: repositories, git objects, refs, issues, pull requests,
// labels and comments, plus the git object model (trees, commits, tags, packs) and the
// deterministic scenario identity the suite's token names.
//
// Everything here is written from the wire formats git and GitHub define: a commit is
// `tree <oid>\nparent ...\nauthor ...\ncommitter ...\n\n<message>`, a tree entry is
// `<mode> <name>\0<20-byte oid>`, an object id is SHA-1 over `<type> <size>\0<bytes>`,
// and a pack is `PACK` + version 2 + count + deflated objects + a SHA-1 trailer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The viewer login, derived deterministically from the suite's fixed seed.
//
// The suite names its users from one seeded stream (FNV-1a over the label,
// splitmix64's finalizer, xorshift64*). Re-implementing that stream here gives the
// login the bearer token owns without ever seeing the token: the first user of the
// 'users' stream is the viewer. Verified against the kit's own scenario builder:
// viewer adaiversen, teammate quinnkeller, stranger olgabauer.
// ---------------------------------------------------------------------------

const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The login the suite's bearer token owns (the scenario's viewer). */
export function viewerLogin(): string {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

export const VIEWER_LOGIN = viewerLogin();
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`, `committer ${fields.committer} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// Packs (plain objects only: the suite's client never sends deltas, and the
// reference forge never needs to either — a plain pack is always valid).
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects, in the caller's order. Trailer is SHA-1 over the rest. */
export function writePack(objects: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, next: offset, first: buffer[start] ?? 0 };
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  version: number;
  count: number;
}

/** Read a packfile of plain objects. Throws on a bad header, count, checksum or entry. */
export function readPack(pack: Buffer): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not supported');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset, trailerStart));
    if (inflated.length !== header.size) {
      throw new Error(`pack entry ${index} declares ${header.size} bytes but inflated to ${inflated.length}`);
    }
    // Advance past the deflated stream: the compressed form is never much longer
    // than the declared size, so the search range is tight.
    offset = skipZlib(pack, offset, trailerStart, header.size);
    const data = Buffer.from(inflated);
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return { objects, version, count };
}

/** The offset just past one zlib stream starting at `start` (bounded by `end`).
 * inflateSync ignores trailing bytes and throws on a truncated stream, so the
 * smallest prefix that inflates cleanly is exactly the stream's end. */
function skipZlib(buffer: Buffer, start: number, end: number, declaredSize: number): number {
  const ok = (n: number): boolean => {
    try {
      inflateSync(buffer.subarray(start, n));
      return true;
    } catch {
      return false;
    }
  };
  let low = start;
  let high = Math.min(end, start + declaredSize + 128 + Math.floor(declaredSize / 8));
  if (!ok(high)) {
    if (!ok(end)) throw new Error('zlib stream does not terminate');
    high = end;
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ok(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Reachability, trees and merges
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots`: commit → tree + parents, tag → target, tree → entries. */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag (repeatedly) to the commit it names, or the oid itself when it is one. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The first common ancestor of two commits (the merge base), or null. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** A tree flattened to path → {oid, mode} for files (blobs) only. */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file changes between two trees (base → head). */
export function diffTrees(baseTree: string, headTree: string, lookup: ObjectLookup): FileChange[] {
  const base = flattenTree(baseTree, lookup);
  const head = flattenTree(headTree, lookup);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const path of base.keys()) {
    if (!head.has(path)) changes.push({ path, status: 'removed', oldOid: base.get(path)?.oid ?? null, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Count added/removed lines between two blob contents (a simple multiset diff). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) {
    const oldCount = oldLines.get(line) ?? 0;
    if (count > oldCount) additions += count - oldCount;
  }
  for (const [line, count] of oldLines) {
    const newCount = newLines.get(line) ?? 0;
    if (count > newCount) deletions += count - newCount;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, decodable. base64url of a typed string.
// ---------------------------------------------------------------------------

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(owner: string, name: string): string {
  return b64urlEncode(`Repository:${owner}/${name}`);
}
export function issueGlobalId(owner: string, name: string, number: number): string {
  return b64urlEncode(`Issue:${owner}/${name}:${number}`);
}
export function pullGlobalId(owner: string, name: string, number: number): string {
  return b64urlEncode(`PullRequest:${owner}/${name}:${number}`);
}
export function commentGlobalId(owner: string, name: string, number: number, commentId: number): string {
  return b64urlEncode(`IssueComment:${owner}/${name}:${number}:${commentId}`);
}

export interface DecodedGlobalId {
  kind: string;
  owner: string;
  name: string;
  number: number;
  extra: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const match = /^([A-Za-z]+):([^/]+)\/([^:]+)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (match === null) return null;
  return {
    kind: match[1] as string,
    owner: match[2] as string,
    name: match[3] as string,
    number: match[4] === undefined ? 0 : Number(match[4]),
    extra: match[5] === undefined ? 0 : Number(match[5]),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdOrder: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  /** One shared number sequence for issues and pull requests, GitHub's way. */
  nextNumber: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextRepoOrder = 0;
  nextRestId = 100000;
  nextCommentId = 1;
  nextGlobalSeq = 1;
  /** Monotonic commit clock for REST-created commits (deterministic, unique SHAs). */
  commitClock = 1700000000;
  /** Cache of built fetch packs, keyed by repo + wants + haves + depth. */
  packCache = new Map<string, Buffer>();
  /** Comments on pull requests, keyed by `${owner}/${name}#${number}` (GraphQL only). */
  pullComments = new Map<string, Comment[]>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdOrder - b.createdOrder);
    return out;
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdOrder: this.nextRepoOrder,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      seq: 0,
    };
    this.nextRepoId += 1;
    this.nextRepoOrder += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The tip oid of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a ref argument: a branch name, a full ref, or a 40-hex oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    return null;
  }

  /** Commits reachable from a tip, newest first (parent-chain walk). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** The tree oid of a commit, or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Build a new tree from an old one with one path set (blob oid) or removed (null). */
  setPathInTree(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (currentOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (currentOid !== null) {
        const object = repo.objects.get(currentOid);
        if (object !== undefined && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const segment = segments[depth] as string;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(segment);
        else entries.set(segment, { mode: '100644', name: segment, oid: blobOid });
      } else {
        const child = entries.get(segment);
        const childTree = build(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
        const childObject = repo.objects.get(childTree);
        const isEmpty = childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0;
        if (isEmpty) entries.delete(segment);
        else entries.set(segment, { mode: '40000', name: segment, oid: childTree });
      }
      const data = buildTree([...entries.values()]);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build(treeOid, 0);
  }

  /** Create a commit object in the repo and return its oid. */
  createCommit(repo: Repo, fields: { tree: string; parents: readonly string[]; message: string }): string {
    const timestamp = this.commitClock;
    this.commitClock += 1;
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({ tree: fields.tree, parents: fields.parents, message: fields.message, author, committer: author, timestamp });
    const oid = hashObject('commit', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  /** The blob oid at a path in a tree, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
    const flat = flattenTree(treeOid, (oid) => repo.objects.get(oid));
    return flat.get(path)?.oid ?? null;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      number,
      id: this.nextRestId,
      globalId: issueGlobalId(repo.owner, repo.name, number),
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextGlobalSeq,
      comments: [],
    };
    this.nextRestId += 1;
    this.nextGlobalSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, fields: { title: string; body: string; head: string; base: string; headSha: string; baseSha: string }): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      number,
      id: this.nextRestId,
      globalId: pullGlobalId(repo.owner, repo.name, number),
      title: fields.title,
      body: fields.body,
      state: 'open',
      head: fields.head,
      base: fields.base,
      headSha: fields.headSha,
      baseSha: fields.baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextGlobalSeq,
    };
    this.nextRestId += 1;
    this.nextGlobalSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Whether merging `pull` into its base tip would conflict (same file changed both sides). */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const headTip = pull.headSha;
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === null) return false;
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return false;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const currentTree = this.commitTree(repo, baseTip);
    if (baseTree === null || headTree === null || currentTree === null) return false;
    const changes = diffTrees(baseTree, headTree, (oid) => repo.objects.get(oid));
    const baseFlat = flattenTree(baseTree, (oid) => repo.objects.get(oid));
    const currentFlat = flattenTree(currentTree, (oid) => repo.objects.get(oid));
    for (const change of changes) {
      const atBase = baseFlat.get(change.path)?.oid ?? null;
      const atCurrent = currentFlat.get(change.path)?.oid ?? null;
      const atHead = change.newOid;
      if (atCurrent !== atBase && atCurrent !== atHead) return true;
    }
    return false;
  }

  /** Squash-merge an open pull request onto its base branch. Returns the merge commit oid, or null. */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = this.branchTip(repo, pull.base);
    const headTree = this.commitTree(repo, pull.headSha);
    if (baseTip === null || headTree === null) return null;
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`;
    const mergeOid = this.createCommit(repo, { tree: headTree, parents: [baseTip], message });
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeOid;
    pull.baseSha = mergeOid;
    return mergeOid;
  }
}
