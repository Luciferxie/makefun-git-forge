// makefun-git-forge — git-store.ts: the git object model, packfile read/write, and the
// graph walks the git wire protocol and the REST/Git Data surface both need.
// Standard library only: node:crypto for SHA-1, node:zlib for pack streams.
// No git binary, no network. All objects are stored byte-exactly as pushed or created.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { FIXED_EPOCH, ZERO_OID, type GitObject, type ObjectType, type Repo } from './store.ts';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const AUTHOR = `adaiversen <adaiversen@users.noreply.github.com> ${FIXED_EPOCH} +0000`;

// -------------------------------------------------------------------------------- objects

/** The git object id of `data` as a `type` object: SHA-1 over `<type> <size>\0<data>`. */
export function oidOf(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store `data` as a `type` object in the repo (idempotent) and return its oid. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// -------------------------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's bytes: headers up to the first blank line, then the message verbatim. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** The bytes of a commit with the fixed author/committer; the message is kept exactly as given. */
export function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${AUTHOR}`, `committer ${AUTHOR}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Create a commit object in the repo and return its oid. */
export function createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  return putObject(repo, 'commit', buildCommit(tree, parents, message));
}

// -------------------------------------------------------------------------------- trees

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** git's entry sort: directory names compare as if they ended in '/'. */
function treeKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

function compareTreeNames(aName: string, aDir: boolean, bName: string, bDir: boolean): number {
  const a = Buffer.from(treeKey(aName, aDir), 'utf8');
  const b = Buffer.from(treeKey(bName, bDir), 'utf8');
  return Buffer.compare(a, b);
}

interface TreeNode {
  kind: 'file' | 'dir';
  oid?: string;
  children?: Map<string, TreeNode>;
}

/** Build nested trees from a flat path map, store every tree object, return the root tree oid. */
export function buildTree(repo: Repo, flat: Map<string, FlatEntry>): string {
  const root: TreeNode = { kind: 'dir', children: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      const last = i === parts.length - 1;
      const children = node.children as Map<string, TreeNode>;
      if (last) {
        children.set(part, { kind: 'file', oid: entry.oid });
      } else {
        let child = children.get(part);
        if (child === undefined) {
          child = { kind: 'dir', children: new Map() };
          children.set(part, child);
        }
        node = child;
      }
    }
  }
  const writeNode = (node: TreeNode): string => {
    const entries: Array<{ name: string; mode: string; oid: string; isDir: boolean }> = [];
    for (const [name, child] of node.children as Map<string, TreeNode>) {
      if (child.kind === 'file') entries.push({ name, mode: '100644', oid: child.oid as string, isDir: false });
      else entries.push({ name, mode: '40000', oid: writeNode(child), isDir: true });
    }
    entries.sort((a, b) => compareTreeNames(a.name, a.isDir, b.name, b.isDir));
    const parts: Buffer[] = [];
    for (const entry of entries) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.oid, 'hex'));
    }
    return putObject(repo, 'tree', Buffer.concat(parts));
  };
  return writeNode(root);
}

/** Parse one tree object's entries: [{mode, name, oid}]. */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const out: Array<{ mode: string; name: string; oid: string }> = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(at, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    at = nul + 21;
  }
  return out;
}

/** Flatten a tree object to path -> blob entry, recursing into subdirectories. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree oid of a commit, or the empty tree when the commit is unknown. */
export function commitTree(repo: Repo, commitOid: string): string {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return buildTree(repo, new Map());
  return parseCommit(obj.data).tree;
}

/** Follow annotated tags to the commit they point at (or the oid itself when already a commit). */
export function resolveTagToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const head = obj.data.toString('utf8').split('\n\n')[0] ?? '';
      const line = head.split('\n').find((entry) => entry.startsWith('object '));
      if (line === undefined) return null;
      current = line.slice(7).trim();
      continue;
    }
    return null;
  }
}

// -------------------------------------------------------------------------------- graph

export interface WalkedCommit {
  oid: string;
  depth: number;
}

/**
 * Breadth-first walk from `tips`, tip first. `maxDepth` caps the generations included
 * (depth 1 = the tips only); `stopAt` commits are included but their parents are not
 * traversed — that is how a shallow boundary holds back a walk.
 */
export function walkCommits(
  repo: Repo,
  tips: Iterable<string>,
  opts: { maxDepth?: number; stopAt?: Set<string> } = {},
): WalkedCommit[] {
  const out: WalkedCommit[] = [];
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) {
    const commit = resolveTagToCommit(repo, tip);
    if (commit !== null && !seen.has(commit)) {
      seen.add(commit);
      queue.push({ oid: commit, depth: 1 });
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; depth: number };
    out.push({ oid: current.oid, depth: current.depth });
    if (opts.maxDepth !== undefined && current.depth >= opts.maxDepth) continue;
    if (opts.stopAt !== undefined && opts.stopAt.has(current.oid)) continue;
    const obj = repo.objects.get(current.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push({ oid: parent, depth: current.depth + 1 });
      }
    }
  }
  return out;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  for (const commit of walkCommits(repo, [descendant])) {
    if (commit.oid === ancestor) return true;
  }
  return false;
}

/** A merge-base of two commits: the first commit reachable from both, nearest to `b`. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set(walkCommits(repo, [a]).map((entry) => entry.oid));
  for (const commit of walkCommits(repo, [b])) {
    if (fromA.has(commit.oid)) return commit.oid;
  }
  return null;
}

/** Commits from a tip, newest first, with their messages (for GET /commits). */
export function commitList(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  for (const entry of walkCommits(repo, [tip])) {
    const obj = repo.objects.get(entry.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push({ sha: entry.oid, message: parseCommit(obj.data).message });
  }
  return out;
}

// -------------------------------------------------------------------------------- diff

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function blobLines(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line difference: how many lines appear in `next` but not `prev`, and vice versa. */
function lineDiff(prev: string[], next: string[]): { additions: number; deletions: number } {
  const prevCount = new Map<string, number>();
  for (const line of prev) prevCount.set(line, (prevCount.get(line) ?? 0) + 1);
  const nextCount = new Map<string, number>();
  for (const line of next) nextCount.set(line, (nextCount.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of nextCount) additions += Math.max(0, count - (prevCount.get(line) ?? 0));
  for (const [line, count] of prevCount) deletions += Math.max(0, count - (nextCount.get(line) ?? 0));
  return { additions, deletions };
}

/** Diff two trees, by path, sorted: added / removed / modified with line counts. */
export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileDiff[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const inBase = base.get(path);
    const inHead = head.get(path);
    if (inBase === undefined && inHead !== undefined) {
      const lines = blobLines(repo, inHead.oid);
      out.push({ path, status: 'added', additions: lines.length, deletions: 0 });
    } else if (inBase !== undefined && inHead === undefined) {
      const lines = blobLines(repo, inBase.oid);
      out.push({ path, status: 'removed', additions: 0, deletions: lines.length });
    } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
      const { additions, deletions } = lineDiff(blobLines(repo, inBase.oid), blobLines(repo, inHead.oid));
      out.push({ path, status: 'modified', additions, deletions });
    }
  }
  return out;
}

/**
 * True when a three-way merge of `headTip` into `baseTip` would conflict: some path changed
 * on both sides of their merge-base with different results (or delete-vs-modify).
 */
export function threeWayConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  const baseTree = commitTree(repo, baseTip);
  const headTree = commitTree(repo, headTip);
  if (base === null) return baseTree !== headTree;
  const flatBase = flattenTree(repo, baseTree);
  const flatHead = flattenTree(repo, headTree);
  const flatMergeBase = flattenTree(repo, commitTree(repo, base));
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
    (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid);
  const paths = new Set([...flatBase.keys(), ...flatHead.keys(), ...flatMergeBase.keys()]);
  for (const path of paths) {
    const atMergeBase = flatMergeBase.get(path);
    const atBase = flatBase.get(path);
    const atHead = flatHead.get(path);
    if (!same(atHead, atMergeBase) && !same(atBase, atMergeBase) && !same(atHead, atBase)) return true;
  }
  return false;
}

// -------------------------------------------------------------------------------- packfile

function writePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (no deltas), with the SHA-1 trailer. */
export function encodePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Inflate one zlib stream starting at `start`: inflate the remainder once, then
 * re-deflate the result and compare bytes — a producer using the default settings
 * reproduces the exact stream, so its length is the consumed length. A producer
 * with other settings falls back to a binary search for the smallest end offset
 * that inflates cleanly (inflateSync ignores trailing bytes, and throws while
 * truncated), so the consumed length is exact whatever the compression level.
 */
function inflateOne(buf: Buffer, start: number): { data: Buffer; next: number } {
  const data = inflateSync(buf.subarray(start));
  const recomp = deflateSync(data);
  if (recomp.length > 0 && buf.length - start >= recomp.length && buf.subarray(start, start + recomp.length).equals(recomp)) {
    return { data, next: start + recomp.length };
  }
  let low = start + 2;
  let high = buf.length;
  if (low > high) throw new Error('pack entry is truncated');
  // The stream end is the smallest offset that inflates cleanly.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buf.subarray(start, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(start, low)), next: low };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[at++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (base.length !== sourceSize) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++] as number;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) {
        if ((op & (1 << i)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= (delta[at++] as number) << (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if ((op & (0x10 << i)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= (delta[at++] as number) << (8 * i);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (at + op > delta.length) throw new Error('delta insert is truncated');
      if (written + op > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Read a version-2/3 packfile, resolving OFS_DELTA and REF_DELTA entries. */
export function decodePack(buf: Buffer): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  if (trailerStart < 12) throw new Error('packfile is truncated');
  const expected = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (buf.subarray(trailerStart).toString('hex') !== expected) throw new Error('pack trailer checksum mismatch');

  const entries: PackEntry[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const offset = at;
    if (at >= trailerStart) throw new Error('pack entry is truncated');
    let byte = buf[at++] as number;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (at >= trailerStart) throw new Error('pack object header is truncated');
      byte = buf[at++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { offset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: the base offset, git's offset varint.
      if (at >= trailerStart) throw new Error('ofs-delta base offset is truncated');
      byte = buf[at++] as number;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (at >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[at++] as number;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = offset - baseOffset;
    } else if (typeCode === 7) {
      if (at + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const inflated = inflateOne(buf, at);
    entry.data = inflated.data;
    at = inflated.next;
    entries.push(entry);
  }

  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolving = new Set<number>();
  const resolve = (entry: PackEntry): GitObject => {
    const existingOid = entry.typeCode <= 4 ? oidOf(CODE_TYPES[entry.typeCode] as ObjectType, entry.data) : null;
    if (existingOid !== null && objects.has(existingOid)) return objects.get(existingOid) as GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      if (resolving.has(entry.offset)) throw new Error('delta cycle in packfile');
      resolving.add(entry.offset);
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry);
      } else if (entry.baseOid !== undefined) {
        const inPack = [...entries].find(
          (candidate) => candidate.typeCode <= 4 && oidOf(CODE_TYPES[candidate.typeCode] as ObjectType, candidate.data) === entry.baseOid,
        );
        base = inPack !== undefined ? resolve(inPack) : undefined;
      }
      resolving.delete(entry.offset);
      if (base === undefined) throw new Error('delta base is not in the pack');
      const data = applyDelta(base.data, entry.data);
      const obj: GitObject = { type: base.type, data };
      objects.set(oidOf(base.type, data), obj);
      return obj;
    }
    const type = CODE_TYPES[entry.typeCode] as ObjectType;
    const obj: GitObject = { type, data: entry.data };
    objects.set(oidOf(type, entry.data), obj);
    return obj;
  };
  for (const entry of entries) resolve(entry);
  return { objects, deltaCount };
}

// -------------------------------------------------------------------------------- fetch sets

export interface FetchSelection {
  /** Objects to put in the pack, in a stable order (commits, then trees, then blobs). */
  objects: GitObject[];
  /** Commits that are new shallow boundaries for the client. */
  shallow: string[];
  /** Client shallow boundaries that are now fully included. */
  unshallow: string[];
}

/**
 * The objects a fetch must deliver: commits reachable from `wants` (within `depth`, when
 * given), minus the objects the client already holds (reachable from `haves` without
 * crossing a shallow boundary). `shallow` holds the client's current shallow boundaries.
 */
export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
): FetchSelection {
  const shallowSet = new Set(shallow);
  // Held: reachable from haves without crossing a shallow boundary.
  const held = new Set<string>();
  const heldCommits = walkCommits(repo, haves, { stopAt: shallowSet });
  for (const commit of heldCommits) held.add(commit.oid);
  const heldObjects = new Map<string, GitObject>();
  const collectTreeObjects = (treeOid: string, into: Map<string, GitObject>): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const obj = repo.objects.get(oid);
      if (obj === undefined || into.has(oid)) continue;
      into.set(oid, obj);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  };
  for (const commit of heldCommits) {
    const obj = repo.objects.get(commit.oid);
    if (obj !== undefined) heldObjects.set(commit.oid, obj);
    if (obj !== undefined && obj.type === 'commit') collectTreeObjects(parseCommit(obj.data).tree, heldObjects);
  }

  // Wanted commits, depth-limited when asked.
  const wanted = walkCommits(repo, wants, depth === null ? {} : { maxDepth: depth });
  const wantedSet = new Set(wanted.map((entry) => entry.oid));
  const frontier = new Set<string>();
  if (depth !== null) {
    for (const entry of wanted) {
      if (entry.depth !== depth) continue;
      const obj = repo.objects.get(entry.oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
        frontier.add(entry.oid);
      }
    }
  }
  // Shallow-info: boundaries still cut off stay shallow; boundaries whose parents are now
  // included become unshallow.
  const shallowOut = new Set<string>(frontier);
  const unshallowOut = new Set<string>();
  for (const boundary of shallowSet) {
    if (!wantedSet.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    const parents = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).parents : [];
    if (parents.length === 0) continue;
    if (parents.every((parent) => wantedSet.has(parent))) unshallowOut.add(boundary);
    else shallowOut.add(boundary);
  }
  // Tag wants resolve to their commits; plain tree/blob wants ship as-is.
  const extraObjects = new Map<string, GitObject>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      extraObjects.set(want, obj);
      const target = resolveTagToCommit(repo, want);
      if (target !== null && !wantedSet.has(target)) {
        for (const entry of walkCommits(repo, [target])) wantedSet.add(entry.oid);
      }
    } else if (obj.type === 'tree' || obj.type === 'blob') {
      extraObjects.set(want, obj);
    }
  }
  const wantedObjects = new Map<string, GitObject>();
  for (const entry of wanted) {
    if (!wantedSet.has(entry.oid)) continue;
    const obj = repo.objects.get(entry.oid);
    if (obj === undefined) continue;
    wantedObjects.set(entry.oid, obj);
    if (obj.type === 'commit') collectTreeObjects(parseCommit(obj.data).tree, wantedObjects);
  }
  for (const [oid, obj] of extraObjects) wantedObjects.set(oid, obj);
  // Drop what the client holds.
  for (const oid of heldObjects.keys()) wantedObjects.delete(oid);
  for (const oid of held) wantedObjects.delete(oid);
  const ordered = [...wantedObjects.values()].sort((a, b) => {
    const rank = (type: ObjectType): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3);
    return rank(a.type) - rank(b.type);
  });
  return {
    objects: ordered,
    shallow: [...shallowOut].sort(),
    unshallow: [...unshallowOut].sort(),
  };
}
