// Private transfer link registry. No vscode imports, so this runs under Vitest.
// On-disk form of the application setting gitKitchen.transfer.links.
// The file is <privateOps>/transfer/links.json. Workspace and folder settings are not used.

import * as fs from 'fs';
import * as path from 'path';

export const LINKS_SETTING_KEY = 'gitKitchen.transfer.links';
export const LINKS_SETTING_SCOPE = 'application';

export type LinkPolicy = Record<string, string | number | boolean | null>;

export interface LinkRecord {
  linkId: string;
  targetPath: string;
  targetBaseSha: string;
  disabled: boolean;
  policy: LinkPolicy;
}

export interface LinkRegistry {
  root: string;
  links: LinkRecord[];
}

export interface LinkDraft {
  linkId: string;
  targetPath: string;
  targetBaseSha: string;
  policy?: LinkPolicy;
}

export type LinkUpdate = Partial<Pick<LinkRecord, 'targetPath' | 'targetBaseSha' | 'policy' | 'disabled'>>;

export type RefuseReason =
  | 'empty-registry'
  | 'missing-id'
  | 'path-escape'
  | 'missing-target'
  | 'credential-url'
  | 'invalid-registry';

export type ResolveResult =
  | { outcome: 'resolved'; path: string; policy: LinkPolicy; targetBaseSha: string }
  | { outcome: 'refuse'; reason: RefuseReason }
  | { outcome: 'blocked'; reason: 'disabled' };

const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const POLICY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_QUERY = /(?:^|[?&])(?:access_token|token|password|secret|auth)=/i;

export function registryPath(privateOps: string): string {
  return path.join(path.resolve(privateOps), 'transfer', 'links.json');
}

export function loadRegistry(privateOps: string): LinkRegistry {
  const read = readRegistry(privateOps);
  if (!read.ok) throw new Error('Link registry is invalid.');
  return read.registry;
}

/** Resolve one opaque link id. Reads the private registry and the target directory. Writes nothing. */
export function resolveLink(privateOps: string, linkId: string): ResolveResult {
  const read = readRegistry(privateOps);
  if (!read.ok) return { outcome: 'refuse', reason: 'invalid-registry' };
  if (read.registry.links.length === 0) return { outcome: 'refuse', reason: 'empty-registry' };
  const link = read.registry.links.find(item => item.linkId === linkId);
  if (!link) return { outcome: 'refuse', reason: 'missing-id' };
  return classify(read.registry.root, link);
}

export function addLink(privateOps: string, root: string, draft: LinkDraft): LinkRecord {
  const registry = loadRegistry(privateOps);
  const linkId = cleanLinkId(draft.linkId);
  if (registry.links.some(item => item.linkId === linkId)) throw new Error('A link with this id already exists.');
  const nextRoot = cleanRoot(root);
  if (registry.root !== '' && !samePath(registry.root, nextRoot)) throw new Error('Link root does not match the registry.');
  const record = buildRecord(nextRoot, {
    linkId,
    targetPath: draft.targetPath,
    targetBaseSha: draft.targetBaseSha,
    disabled: false,
    policy: draft.policy,
  });
  const next: LinkRegistry = {
    root: registry.root === '' ? nextRoot : registry.root,
    links: [...registry.links, record],
  };
  writeRegistry(privateOps, next);
  return cloneRecord(record);
}

export function updateLink(privateOps: string, linkId: string, patch: LinkUpdate): LinkRecord {
  const registry = loadRegistry(privateOps);
  const id = cleanLinkId(linkId);
  const index = registry.links.findIndex(item => item.linkId === id);
  if (index < 0) throw new Error('Unknown link id.');
  const current = registry.links[index];
  const record = buildRecord(registry.root, {
    linkId: id,
    targetPath: patch.targetPath ?? current.targetPath,
    targetBaseSha: patch.targetBaseSha ?? current.targetBaseSha,
    disabled: patch.disabled ?? current.disabled,
    policy: patch.policy ?? current.policy,
  });
  const links = registry.links.slice();
  links[index] = record;
  writeRegistry(privateOps, { root: registry.root, links });
  return cloneRecord(record);
}

export function disableLink(privateOps: string, linkId: string): LinkRecord {
  return updateLink(privateOps, linkId, { disabled: true });
}

function classify(root: string, link: LinkRecord): ResolveResult {
  const target = link.targetPath.trim();
  if (isCredentialBearingTarget(target)) return { outcome: 'refuse', reason: 'credential-url' };
  if (isRemoteUrl(target)) return { outcome: 'refuse', reason: 'path-escape' };
  const rootAbs = root.trim() === '' ? '' : path.resolve(root);
  const lexical = rootAbs === '' ? '' : lexicalTarget(rootAbs, target);
  if (rootAbs === '' || lexical === '' || !inside(rootAbs, lexical)) return { outcome: 'refuse', reason: 'path-escape' };
  if (link.disabled) return { outcome: 'blocked', reason: 'disabled' };
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootAbs);
  } catch {
    return { outcome: 'refuse', reason: 'path-escape' };
  }
  let realTarget: string;
  try {
    const stat = fs.statSync(lexical);
    if (!stat.isDirectory()) return { outcome: 'refuse', reason: 'missing-target' };
    realTarget = fs.realpathSync(lexical);
  } catch {
    return { outcome: 'refuse', reason: 'missing-target' };
  }
  if (!inside(realRoot, realTarget)) return { outcome: 'refuse', reason: 'path-escape' };
  return { outcome: 'resolved', path: realTarget, policy: { ...link.policy }, targetBaseSha: link.targetBaseSha };
}

function lexicalTarget(rootAbs: string, target: string): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootAbs, target);
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).includes('..');
}

function isRemoteUrl(target: string): boolean {
  const raw = target.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^git@[^:\s]+:\S+$/.test(raw);
}

function isCredentialBearingTarget(target: string): boolean {
  const raw = target.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.password !== '') return true;
    if (url.username !== '' && (url.protocol === 'http:' || url.protocol === 'https:')) return true;
    return SECRET_QUERY.test(url.search);
  } catch {
    return /:\/\/[^/\s]*@/.test(raw);
  }
}

function cleanLinkId(id: unknown): string {
  if (typeof id !== 'string' || !LINK_ID.test(id)) throw new Error('Link id must be an opaque token.');
  return id;
}

function cleanSha(sha: unknown): string {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('targetBaseSha must be a commit sha.');
  return sha;
}

function cleanRoot(root: unknown): string {
  if (typeof root !== 'string' || root.trim() === '' || root.includes('\0')) throw new Error('Root path is invalid.');
  return path.resolve(root);
}

function cleanPolicy(policy: LinkPolicy | undefined): LinkPolicy {
  if (policy === undefined) return {};
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Policy must be an object.');
  const out: LinkPolicy = {};
  for (const [key, value] of Object.entries(policy)) {
    if (!POLICY_KEY.test(key)) throw new Error('Invalid policy key.');
    if (typeof value === 'string') {
      if (value.includes('\0') || isCredentialBearingTarget(value) || isRemoteUrl(value)) throw new Error('Policy cannot hold a remote URL.');
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Invalid policy value.');
      out[key] = value;
    } else if (typeof value === 'boolean' || value === null) out[key] = value;
    else throw new Error('Invalid policy value.');
  }
  return out;
}

function buildRecord(root: string, input: { linkId: string; targetPath: unknown; targetBaseSha: unknown; disabled: boolean; policy?: LinkPolicy }): LinkRecord {
  if (typeof input.targetPath !== 'string' || input.targetPath.trim() === '' || input.targetPath.includes('\0')) {
    throw new Error('Target path is invalid.');
  }
  const target = input.targetPath.trim();
  const stored = isCredentialBearingTarget(target) || isRemoteUrl(target) ? target : lexicalTarget(path.resolve(root), target);
  return {
    linkId: input.linkId,
    targetPath: stored,
    targetBaseSha: cleanSha(input.targetBaseSha),
    disabled: input.disabled === true,
    policy: cleanPolicy(input.policy),
  };
}

function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

function cloneRecord(link: LinkRecord): LinkRecord {
  return { ...link, policy: { ...link.policy } };
}

function readRegistry(privateOps: string): { ok: true; registry: LinkRegistry } | { ok: false } {
  const file = registryPath(privateOps);
  if (!fs.existsSync(file)) return { ok: true, registry: { root: '', links: [] } };
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false }; }
  const registry = parseRegistry(parsed);
  if (!registry) return { ok: false };
  return { ok: true, registry };
}

function parseRegistry(value: unknown): LinkRegistry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.root !== 'string' || rec.root.includes('\0')) return undefined;
  if (!Array.isArray(rec.links)) return undefined;
  const links: LinkRecord[] = [];
  const seen = new Set<string>();
  for (const item of rec.links) {
    const link = parseLink(item);
    if (!link || seen.has(link.linkId)) return undefined;
    seen.add(link.linkId);
    links.push(link);
  }
  return { root: rec.root, links };
}

function parseLink(value: unknown): LinkRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.linkId !== 'string' || !LINK_ID.test(rec.linkId)) return undefined;
  if (typeof rec.targetPath !== 'string' || rec.targetPath.trim() === '' || rec.targetPath.includes('\0')) return undefined;
  if (typeof rec.targetBaseSha !== 'string' || !SHA.test(rec.targetBaseSha)) return undefined;
  if (rec.disabled !== undefined && typeof rec.disabled !== 'boolean') return undefined;
  let policy: LinkPolicy;
  try { policy = cleanPolicy(rec.policy === undefined ? undefined : rec.policy as LinkPolicy); } catch { return undefined; }
  return {
    linkId: rec.linkId,
    targetPath: rec.targetPath.trim(),
    targetBaseSha: rec.targetBaseSha,
    disabled: rec.disabled === true,
    policy,
  };
}

function writeRegistry(privateOps: string, registry: LinkRegistry): void {
  const file = registryPath(privateOps);
  assertPrivateFile(file, registry);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing to write the link registry inside a target.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const ops = path.resolve(privateOps);
  const dir = path.dirname(file);
  fs.mkdirSync(ops, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(ops, 0o700);
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.links.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({
    root: registry.root,
    links: registry.links.map(link => ({
      linkId: link.linkId,
      targetPath: link.targetPath,
      targetBaseSha: link.targetBaseSha,
      disabled: link.disabled,
      policy: { ...link.policy },
    })),
  }, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* registry file is left as it was */ }
    throw err;
  }
}

function assertPrivateFile(file: string, registry: LinkRegistry): void {
  const store = path.resolve(file);
  if (store.split(path.sep).some(part => part === '.git' || part === '.vscode')) {
    throw new Error('Refusing to write the link registry inside a target.');
  }
  for (const link of registry.links) {
    if (isCredentialBearingTarget(link.targetPath) || isRemoteUrl(link.targetPath)) continue;
    if (inside(path.resolve(link.targetPath), store)) throw new Error('Refusing to write the link registry inside a target.');
  }
}
