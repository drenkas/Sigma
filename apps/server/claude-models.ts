import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ClaudeModelEntry = { id: string; name: string; efforts: string[] };

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];
const ID_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_MODELS = 64;
const CATALOG_FILE = 'claude-models.json';

export const FALLBACK_CLAUDE_MODELS: ClaudeModelEntry[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 · official CLI', efforts: [...FULL] },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 · official CLI', efforts: [...FULL] },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · official CLI', efforts: [...FULL] },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 · official CLI', efforts: [] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 · official CLI', efforts: ['low', 'medium', 'high', 'max'] },
];

const copy = (e: ClaudeModelEntry): ClaudeModelEntry => ({ id: e.id, name: e.name, efforts: [...e.efforts] });

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && ID_RE.test(id);
}

function filterEfforts(levels: unknown[]): string[] {
  return EFFORT_LEVELS.filter((l) => levels.includes(l));
}

function deriveDisplay(id: string): string {
  return id
    .replace(/^claude-/, '')
    .split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

function buildName(displayName: unknown, id: string): string {
  let display = typeof displayName === 'string'
    // eslint-disable-next-line no-control-regex
    ? displayName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 40).trim()
    : '';
  if (!display) display = deriveDisplay(id);
  return display.startsWith('Claude ') ? `${display} · official CLI` : `Claude ${display} · official CLI`;
}

export function parseClaudeCatalog(models: unknown): ClaudeModelEntry[] | undefined {
  if (!Array.isArray(models) || models.length > MAX_MODELS) return undefined;
  const out: ClaudeModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const id = typeof m.resolvedModel === 'string' && m.resolvedModel ? m.resolvedModel : m.value;
    if (!validId(id) || seen.has(id)) continue;
    let efforts: string[] = [];
    if (m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)) {
      efforts = filterEfforts(m.supportedEffortLevels);
    }
    if (m.supportsEffort === true && efforts.length === 0) continue;
    seen.add(id);
    out.push({ id, name: buildName(m.displayName, id), efforts });
  }
  return out.length ? out : undefined;
}

export function mergeWithFallback(discovered: ClaudeModelEntry[] | undefined): ClaudeModelEntry[] {
  if (!discovered) return FALLBACK_CLAUDE_MODELS.map(copy);
  const ids = new Set(discovered.map((e) => e.id));
  return [...discovered.map(copy), ...FALLBACK_CLAUDE_MODELS.filter((e) => !ids.has(e.id)).map(copy)];
}

function validStored(e: unknown): e is ClaudeModelEntry {
  if (!e || typeof e !== 'object') return false;
  const m = e as Record<string, unknown>;
  return validId(m.id)
    && typeof m.name === 'string' && m.name.length <= 80
    && Array.isArray(m.efforts)
    && m.efforts.every((x) => typeof x === 'string' && EFFORT_LEVELS.includes(x));
}

export async function loadClaudeCatalog(dataDir: string): Promise<ClaudeModelEntry[] | undefined> {
  try {
    const data = JSON.parse(await readFile(join(dataDir, CATALOG_FILE), 'utf8')) as unknown;
    if (!data || typeof data !== 'object') return undefined;
    const { version, models } = data as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) return undefined;
    if (!models.every(validStored)) return undefined;
    return models.map(copy);
  } catch {
    return undefined;
  }
}

export async function saveClaudeCatalog(dataDir: string, entries: ClaudeModelEntry[]): Promise<void> {
  const target = join(dataDir, CATALOG_FILE);
  const temp = join(dataDir, `.claude-models-${randomUUID()}.json`);
  try {
    await writeFile(temp, `${JSON.stringify({ version: 1, models: entries.map(copy) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}
