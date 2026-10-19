import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FALLBACK_CLAUDE_MODELS,
  loadClaudeCatalog,
  mergeWithFallback,
  parseClaudeCatalog,
  saveClaudeCatalog,
} from './claude-models.js';

const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];
const m = (value: string, resolvedModel: string | undefined, displayName: string, levels: string[] | null) => ({
  value, resolvedModel, displayName, description: 'x',
  supportsEffort: levels === null ? null : true,
  supportedEffortLevels: levels ?? undefined,
});

const SAMPLE = [
  m('default', 'claude-opus-5-5', 'Opus 5.5', FULL),
  m('opus', 'claude-opus-5-5', 'Opus 5.5', FULL),
  m('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5', FULL),
  m('claude-fable-5-1', undefined, 'Fable 5.1', FULL),
  m('haiku', 'claude-haiku-4-5-20251001', 'Haiku 4.5', null),
  m('claude-sonnet-5', undefined, 'Sonnet 5', FULL),
  m('claude-opus-5', undefined, 'Opus 5', FULL),
  m('claude-fable-5', undefined, 'Fable 5', FULL),
  m('claude-opus-4-8', undefined, 'Opus 4.8', FULL),
  m('claude-opus-4-7', undefined, 'Opus 4.7', FULL),
  m('claude-opus-4-6', undefined, 'Opus 4.6', ['low', 'medium', 'high', 'max']),
  m('claude-sonnet-4-6', undefined, 'Sonnet 4.6', ['low', 'medium', 'high', 'max']),
];

test('parses real 2.1.284 sample', () => {
  const r = parseClaudeCatalog(SAMPLE)!;
  assert.equal(r.length, 11);
  assert.deepEqual(r[0], { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 · official CLI', efforts: FULL });
  assert.equal(r[1].id, 'claude-sonnet-5-5');
  assert.deepEqual(r.find((e) => e.id === 'claude-haiku-4-5-20251001')!.efforts, []);
  assert.deepEqual(r.find((e) => e.id === 'claude-opus-4-6')!.efforts, ['low', 'medium', 'high', 'max']);
  assert.ok(r.some((e) => e.id === 'claude-fable-5-1'));
});

test('rejects bad ids and filters efforts', () => {
  const r = parseClaudeCatalog([
    m('../x', undefined, 'x', FULL), m('CLAUDE', undefined, 'x', FULL), m('gpt-4', undefined, 'x', FULL),
    m('claude-a', undefined, '', ['max', 'bogus', 'low', 'low']),
    m('claude-b', undefined, 'B', ['bogus']),
    m('claude-c', undefined, 'Claude C\u0007', FULL),
  ])!;
  assert.deepEqual(r.map((e) => e.id), ['claude-a', 'claude-c']);
  assert.deepEqual(r[0].efforts, ['low', 'max']);
  assert.equal(r[0].name, 'Claude A · official CLI');
  assert.equal(r[1].name, 'Claude C · official CLI');
  assert.equal(parseClaudeCatalog([m('gpt-4', undefined, 'x', FULL)]), undefined);
});

test('rejects oversized and non-array', () => {
  assert.equal(parseClaudeCatalog(Array.from({ length: 65 }, (_, i) => m(`claude-x-${i}`, undefined, 'x', FULL))), undefined);
  assert.equal(parseClaudeCatalog({}), undefined);
  assert.equal(parseClaudeCatalog(null), undefined);
});

test('merge keeps fallback ids', () => {
  const merged = mergeWithFallback([{ id: 'claude-new-1', name: 'n', efforts: [] }, { ...FALLBACK_CLAUDE_MODELS[1], name: 'override' }]);
  assert.equal(merged[0].id, 'claude-new-1');
  assert.equal(merged[1].name, 'override');
  for (const f of FALLBACK_CLAUDE_MODELS) assert.ok(merged.some((e) => e.id === f.id));
  assert.equal(merged.length, 1 + FALLBACK_CLAUDE_MODELS.length);
  const fb = mergeWithFallback(undefined);
  assert.deepEqual(fb, FALLBACK_CLAUDE_MODELS);
  assert.notEqual(fb[0], FALLBACK_CLAUDE_MODELS[0]);
});

test('save/load roundtrip and corrupt file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-models-'));
  try {
    assert.equal(await loadClaudeCatalog(dir), undefined);
    const entries = parseClaudeCatalog(SAMPLE)!;
    await saveClaudeCatalog(dir, entries);
    assert.deepEqual(await loadClaudeCatalog(dir), entries);
    await writeFile(join(dir, 'claude-models.json'), '{not json');
    assert.equal(await loadClaudeCatalog(dir), undefined);
    await writeFile(join(dir, 'claude-models.json'), JSON.stringify({ version: 1, models: [{ id: '../x', name: 'x', efforts: [] }] }));
    assert.equal(await loadClaudeCatalog(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
