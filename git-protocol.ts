// makefun-git-forge — git-protocol.ts: the smart-HTTP git wire protocol.
// receive-pack v0 (report-status / side-band-64k / delete-refs), upload-pack v2 fetch
// and ls-refs plus the v0 fetch fallback, shallow/deepen, fast-forward enforcement.
// The client always speaks pkt-lines; the pack bytes after a receive-pack flush are raw.

import {
  AGENT,
  PKT_FLUSH,
  ZERO_OID,
  pktLine,
  type Repo,
} from './store.ts';
import {
  decodePack,
  encodePack,
  isAncestor,
  resolveTagToCommit,
  selectFetchObjects,
} from './git-store.ts';

// -------------------------------------------------------------------------------- advertisements

/**
 * The v2 capability advertisement is the same bytes for every repository: build it once and hand
 * the same buffer to every clone's first request (the clone workload asks for it 55 times in a
 * row). Nothing writes into a response buffer, so sharing it is safe.
 */
const V2_ADVERTISEMENT = (() => {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
})();

/** The v2 capability advertisement: `version 2` then one capability per line, then flush. */
export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** A v0 ref advertisement: the `# service=` preamble, a flush, then the ref lines. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT
      : 'side-band-64k ofs-delta shallow agent=' + AGENT + ' symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    // An empty repository advertises only the capabilities pseudo-ref.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? repo.refs.get(names[0] as string) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const name of names) {
      parts.push(pktLine(`${repo.refs.get(name) as string} ${name}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------- pkt parsing

type PktKind = 'data' | 'flush' | 'delim';

interface Pkt {
  kind: PktKind;
  /** The payload of a data packet, as text (pack bytes are never parsed this way). */
  text: string;
}

/** Parse pkt-lines, keeping flush/delim markers; stops at the first malformed frame. */
function parsePkts(body: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const size = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) {
      out.push({ kind: 'flush', text: '' });
      at += 4;
      continue;
    }
    if (size === 1) {
      out.push({ kind: 'delim', text: '' });
      at += 4;
      continue;
    }
    if (size < 4 || at + size > body.length) break;
    out.push({ kind: 'data', text: body.subarray(at + 4, at + size).toString('utf8') });
    at += size;
  }
  return out;
}

/** Parse a receive-pack body: command lines up to the first flush, then the raw pack bytes. */
function parseReceivePack(body: Buffer): { commands: Array<{ oldOid: string; newOid: string; ref: string }>; pack: Buffer } {
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const size = parseInt(body.subarray(at, at + 4).toString('ascii'), 16);
    if (!Number.isFinite(size) || size < 0) break;
    if (size === 0) {
      // Flush: the command list ends and the raw pack bytes follow.
      at += 4;
      break;
    }
    if (size === 1) {
      at += 4;
      continue;
    }
    if (size < 4 || at + size > body.length) break;
    const text = body.subarray(at + 4, at + size).toString('utf8');
    at += size;
    const nul = text.indexOf('\0');
    const line = (nul < 0 ? text : text.slice(0, nul)).replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  }
  return { commands, pack: body.subarray(at) };
}

/** Wrap an inner pkt-line stream in side-band-64k band-1 frames, then a flush. */
function sidebandWrap(inner: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX_DATA = 65515; // one band byte + data fits a 65520-byte pkt-line
  for (let at = 0; at < inner.length; at += MAX_DATA) {
    const chunk = inner.subarray(at, Math.min(inner.length, at + MAX_DATA));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------- receive-pack

/** Handle POST git-receive-pack: ingest the pack, apply the ref commands, report per ref. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePack(body);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (pack.length > 0) {
    let unpackError: string | null = null;
    try {
      const { objects } = decodePack(pack);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack error';
    }
    if (unpackError !== null) {
      const inner = Buffer.concat([
        pktLine(`unpack ${unpackError}\n`),
        ...commands.map((command) => pktLine(`ng ${command.ref} unpack error\n`)),
        PKT_FLUSH,
      ]);
      return sidebandWrap(inner);
    }
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the old value must match, and the new tip must descend from it.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  const inner = Buffer.concat([
    pktLine('unpack ok\n'),
    ...results.map((result) =>
      result.ok ? pktLine(`ok ${result.ref}\n`) : pktLine(`ng ${result.ref} ${result.reason}\n`),
    ),
    PKT_FLUSH,
  ]);
  return sidebandWrap(inner);
}

// -------------------------------------------------------------------------------- ls-refs

/** Answer a v2 `command=ls-refs` request body with the repo's refs. */
export function lsRefsResponse(repo: Repo, body: Buffer): Buffer {
  const lines = parsePkts(body)
    .filter((pkt) => pkt.kind === 'data')
    .map((pkt) => pkt.text.replace(/\n$/, ''));
  const prefixes: string[] = [];
  let peel = false;
  for (const line of lines) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'peel') peel = true;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    if (headOid !== undefined) out.push(pktLine(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    else out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const commit = resolveTagToCommit(repo, oid);
        if (commit !== null) suffix = ` peeled:${commit}`;
      }
    }
    out.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------- upload-pack

/**
 * Fetch-response cache: a fetch's object selection is a pure function of the repo's
 * (append-only, immutable) objects and the wants/haves/shallow/depth, so an
 * identical fetch can reuse its pack bytes. Bounded and FIFO-evicted; only used
 * when every wanted oid already exists, so a want that later appears is never
 * served a stale empty pack.
 */
const FETCH_CACHE = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
const FETCH_CACHE_MAX = 64;

function fetchCacheKey(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): string {
  return `${repo.id}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
}

/** Handle POST git-upload-pack: v2 ls-refs / fetch, the v0 fetch fallback, or garbage. */
export function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const pkts = parsePkts(body);
  const lines = pkts.filter((pkt) => pkt.kind === 'data').map((pkt) => pkt.text.replace(/\n$/, ''));
  if (lines.some((line) => line.startsWith('command=ls-refs'))) {
    return lsRefsResponse(repo, body);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let isV2Fetch = false;
  for (const line of lines) {
    if (line === 'command=fetch') {
      isV2Fetch = true;
      continue;
    }
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (/^[0-9a-f]{40}$/.test(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (/^[0-9a-f]{40}$/.test(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // agent=, object-format=, thin-pack, no-progress, ofs-delta, filter, done: no effect here.
  }
  // Garbage that parses as neither fetch shape still gets a clean answer, never a crash:
  // a NAK and an empty pack keep the server healthy for the next clone.
  const cacheKey = fetchCacheKey(repo, wants, haves, shallow, depth);
  const cached = FETCH_CACHE.get(cacheKey);
  let pack: Buffer;
  let shallowOut: string[];
  let unshallowOut: string[];
  if (cached !== undefined) {
    pack = cached.pack;
    shallowOut = cached.shallow;
    unshallowOut = cached.unshallow;
  } else {
    const selection = selectFetchObjects(repo, wants, haves, shallow, depth);
    pack = encodePack(selection.objects);
    shallowOut = selection.shallow;
    unshallowOut = selection.unshallow;
    if (wants.every((oid) => repo.objects.has(oid))) {
      if (FETCH_CACHE.size >= FETCH_CACHE_MAX) {
        const oldest = FETCH_CACHE.keys().next().value as string | undefined;
        if (oldest !== undefined) FETCH_CACHE.delete(oldest);
      }
      FETCH_CACHE.set(cacheKey, { pack, shallow: shallowOut, unshallow: unshallowOut });
    }
  }
  const selection = { shallow: shallowOut, unshallow: unshallowOut };
  if (isV2Fetch) {
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(pack)); // band-1 pack chunks, ending with the section's flush
    return Buffer.concat(parts);
  }
  // v0 fetch: NAK, shallow/unshallow lines, then the sideband pack, then a flush.
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(pack));
  return Buffer.concat(parts);
}
