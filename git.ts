// git smart HTTP: protocol v2 upload-pack (advertisement, ls-refs, fetch) and v0
// receive-pack (advertisement, push), over /{owner}/{repo}.git.
//
// Framing is pkt-line throughout: a 4-hex-digit length (including the 4 header
// bytes) + payload; 0000 is flush, 0001 is a section delimiter. A v2 advertisement
// opens with `version 2`; a v0 one opens with `# service=git-<service>` and lists
// refs with capabilities after a NUL on the first line. Fetch answers in sections
// (acknowledgments, shallow-info, packfile) with the pack inside sideband band 1.
// A push answers report-status inside sideband band 1: `unpack ok` then one
// `ok <ref>` / `ng <ref> non-fast-forward` line per command.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds the 65520 maximum`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const lengthText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line is truncated');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** The data packets' payloads as text lines (without the trailing newline). */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const FORGE_AGENT = 'naplan-github-forge/1.0.0';
const UPLOAD_V2_CAPS = ['agent', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack_detailed object-format=sha1';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** A repo's refs as advertisement lines, HEAD first, then sorted; peeled tags follow their ref. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main !== undefined) lines.push({ oid: main, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(oid, (id) => repo.objects.get(id));
      if (peeled !== null) entry.peeled = peeled;
    }
    lines.push(entry);
  }
  return lines;
}

/** The v2 capability advertisement for upload-pack. */
function advertisementV2(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v0 ref advertisement: service preamble, then ref lines with capabilities on the first. */
function advertisementV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      const text = index === 0 ? `${line.oid} ${line.name}\0${caps}\n` : `${line.oid} ${line.name}\n`;
      parts.push(pktLine(text));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}
function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'text/plain', body: Buffer.from(message, 'utf8') };
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  wantsV2: boolean,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0('git-upload-pack', repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0('git-receive-pack', repo) };
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Fetch: which objects to send
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to pack, in deterministic (oid-sorted) order. */
  objects: GitObject[];
  /** The new shallow boundary commits. */
  shallow: string[];
  /** Old shallow commits whose parent is now included. */
  unshallow: string[];
  /** Haves the server acknowledges as common. */
  acks: string[];
}

/** Commit distances from the wants (0 = a want itself), following parents. A tag
 * want counts at the same distance as the commit it names. */
function commitDistances(repo: Repo, wants: readonly string[], maxDepth: number | null): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (distances.has(oid)) continue;
    distances.set(oid, depth);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth });
      continue;
    }
    if (object.type !== 'commit') continue;
    if (maxDepth !== null && depth >= maxDepth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return distances;
}

/** Reachability from roots that never crosses out of `allowed` commits: a parent
 * edge is followed only when the parent is in `allowed`. Trees, blobs and tag
 * targets are followed in full. This is what keeps a shallow fetch shallow. */
function collectReachableBounded(
  roots: Iterable<string>,
  allowed: ReadonlySet<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
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
      for (const parent of commit.parents) {
        if (allowed.has(parent)) queue.push(parent);
      }
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

/**
 * Work out what a fetch sends. `depth` caps the commit generations (null = the whole
 * history); `shallowBoundary` is the client's current shallow line (for deepen).
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundary: readonly string[],
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // The commits the fetch includes, and the boundary where history is cut.
  const distances = commitDistances(repo, wants, depth === null ? null : depth);
  const included = new Set<string>();
  const boundary = new Set<string>();
  if (depth === null) {
    for (const oid of distances.keys()) included.add(oid);
  } else {
    for (const [oid, distance] of distances) {
      if (distance < depth) included.add(oid);
      if (distance === depth - 1) {
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length > 0) {
          boundary.add(oid);
        }
      }
    }
  }
  // The old boundary commits that stop being shallow: included, with a parent included too.
  const unshallow: string[] = [];
  for (const old of shallowBoundary) {
    if (!included.has(old)) continue;
    const object = repo.objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => included.has(parent))) unshallow.push(old);
  }
  // Objects reachable from the included commits, without crossing the shallow
  // boundary: a parent edge is followed only when the parent is included too.
  const wanted = new Set<string>();
  for (const oid of included) {
    for (const reachable of collectReachableBounded([oid], included, lookup)) wanted.add(reachable);
  }
  const held = new Set<string>();
  for (const have of haves) {
    try {
      for (const reachable of collectReachable([have], lookup)) held.add(reachable);
    } catch {
      // A have the server does not hold is simply not common ground.
    }
  }
  // The client's shallow boundary hides history the client does not hold: the
  // parents of a shallow commit are not in the client's object store, so they
  // are not held either — otherwise a deepen would never send the next commit.
  for (const boundaryOid of shallowBoundary) {
    const boundary = repo.objects.get(boundaryOid);
    if (boundary === undefined || boundary.type !== 'commit') continue;
    for (const parent of parseCommit(boundary.data).parents) {
      try {
        for (const reachable of collectReachable([parent], lookup)) held.delete(reachable);
      } catch {
        // Not common ground; ignore.
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Acknowledgments: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.get(have) === undefined) continue;
    const peeledHave = peelToCommit(have, lookup) ?? have;
    const ok = wants.some((want) => {
      const peeledWant = peelToCommit(want, lookup) ?? want;
      return peeledHave === peeledWant || isAncestor(peeledHave, peeledWant, lookup);
    });
    if (ok) acks.push(have);
  }
  return {
    objects,
    shallow: [...boundary].sort(),
    unshallow: unshallow.sort(),
    acks,
  };
}

/** Split a pack into sideband band-1 pkt-lines (32768-byte chunks). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function packCacheKey(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, shallow: readonly string[]): string {
  return `${repo.fullName}|w:${[...wants].sort().join(',')}|h:${[...haves].sort().join(',')}|d:${depth ?? ''}|s:${[...shallow].sort().join(',')}`;
}

/** POST /{owner}/{repo}.git/git-upload-pack — a v2 command or a v0 fetch. */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, wantsV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  const lines = packetLines(packets);
  const first = lines[0] ?? '';
  const isV2 = first.startsWith('command=');
  if (!isV2 && !first.startsWith('want ')) return badRequest('expected a git-upload-pack command or want list');
  if (isV2 && first === 'command=ls-refs') return handleLsRefs(repo, lines);
  if (isV2 && first === 'command=fetch') return handleFetchV2(store, repo, lines);
  if (!isV2) return handleFetchV0(store, repo, lines);
  return badRequest(`unknown upload-pack command ${JSON.stringify(first)}`);
}

function handleLsRefs(repo: Repo, lines: readonly string[]): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const main = repo.refs.get('refs/heads/main');
  if (prefixes.length === 0) {
    if (main !== undefined) {
      parts.push(pktLine(`${main} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let text = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid, (id) => repo.objects.get(id));
        if (peeled !== null) text += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isSafeInteger(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): GitResponse {
  for (const want of args.wants) {
    if (!isOid(want) || repo.objects.get(want) === undefined) {
      const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
      parts.push(pktLine('packfile\n'));
      parts.push(pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR object ${want} not found\n`, 'utf8')])));
      parts.push(pktFlush());
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
    }
  }
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  if (plan.objects.length > 0) parts.push(pktLine('ready\n'));
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    const key = packCacheKey(repo, args.wants, args.haves, args.depth, args.shallow);
    let pack = store.packCache.get(key);
    if (pack === undefined) {
      pack = writePack(plan.objects);
      if (store.packCache.size >= 128) {
        const oldest = store.packCache.keys().next().value as string | undefined;
        if (oldest !== undefined) store.packCache.delete(oldest);
      }
      store.packCache.set(key, pack);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV2(store: Store, repo: Repo, lines: readonly string[]): GitResponse {
  return fetchResponseV2(store, repo, parseFetchArgs(lines));
}

function handleFetchV0(store: Store, repo: Repo, lines: readonly string[]): GitResponse {
  const args = parseFetchArgs(lines);
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const key = packCacheKey(repo, args.wants, args.haves, args.depth, args.shallow);
    let pack = store.packCache.get(key);
    if (pack === undefined) {
      pack = writePack(plan.objects);
      store.packCache.set(key, pack);
    }
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — a v0 push. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  // Parse pkt-lines one at a time until the first flush: everything after the
  // flush is the pack itself, raw binary, not pkt-lines.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = -1;
  while (offset < body.length) {
    if (offset + 4 > body.length) return badRequest('pkt-line header is truncated');
    const lengthText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) return badRequest(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) return badRequest('pkt-line is truncated');
    const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const command = nul >= 0 ? line.slice(0, nul) : line;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(command);
    if (match === null) return badRequest(`bad push command ${JSON.stringify(command.slice(0, 80))}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    offset += length;
  }
  if (packStart === -1) return badRequest('push command list has no flush');
  if (commands.length === 0) return badRequest('push needs at least one command');

  // Unpack first: a bad pack refuses the whole push, but the report still answers.
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail.replace(/\n/g, ' ')}`];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? null;
      let verdict: { ok: boolean; reason: string } | null = null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === null) verdict = { ok: false, reason: 'remote ref does not exist' };
        else if (command.oldOid !== current) verdict = { ok: false, reason: 'non-fast-forward' };
        else {
          repo.refs.delete(command.ref);
          verdict = { ok: true, reason: '' };
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) verdict = { ok: false, reason: 'already exists' };
        else if (repo.objects.get(command.newOid) === undefined) verdict = { ok: false, reason: 'object not found' };
        else {
          repo.refs.set(command.ref, command.newOid);
          verdict = { ok: true, reason: '' };
        }
      } else {
        // Update: the old tip must match, and the new tip must descend from it.
        if (current === null) verdict = { ok: false, reason: 'remote ref does not exist' };
        else if (command.oldOid !== current) verdict = { ok: false, reason: 'non-fast-forward' };
        else {
          const newCommit = peelToCommit(command.newOid, lookup);
          const oldCommit = peelToCommit(command.oldOid, lookup);
          if (newCommit === null || oldCommit === null) verdict = { ok: false, reason: 'object not found' };
          else if (!isAncestor(oldCommit, newCommit, lookup)) verdict = { ok: false, reason: 'non-fast-forward' };
          else {
            repo.refs.set(command.ref, command.newOid);
            verdict = { ok: true, reason: '' };
          }
        }
      }
      reportLines.push(verdict.ok ? `ok ${command.ref}` : `ng ${command.ref} ${verdict.reason}`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }

  // report-status is itself pkt-line encoded, one packet per line, carried in band 1.
  const reportPackets = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportPackets]))];
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
