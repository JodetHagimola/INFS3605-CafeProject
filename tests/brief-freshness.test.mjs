import test from 'node:test';
import assert from 'node:assert/strict';
import { withConsistentBrief } from '../lib/agent/brief-freshness.ts';
import { sydneyDay } from '../lib/inventory-sales/operations-model.ts';

test('unchanged data uses the saved brief without generation', async () => {
  const result = await withConsistentBrief({
    fingerprint: async () => 'a', load: async () => 'saved',
    generate: async () => { throw new Error('unexpected generation'); },
    save: async () => { throw new Error('unexpected save'); },
  });
  assert.equal(result, 'saved');
});

for (const changeAt of ['load', 'generate', 'save']) {
  test(`a stock change during ${changeAt} cannot return a stale brief`, async () => {
    let version = 0, changed = false;
    const change = (stage) => { if (stage === changeAt && !changed) { version++; changed = true; } };
    const saved = [];
    const result = await withConsistentBrief({
      fingerprint: async () => String(version),
      load: async () => { const previous = version; change('load'); return changeAt === 'load' ? previous : null; },
      generate: async () => { const previous = version; change('generate'); return previous; },
      save: async (brief, fingerprint) => { saved.push([brief, fingerprint]); change('save'); return brief; },
    });
    assert.equal(result, 1);
    for (const [brief, fingerprint] of saved) assert.equal(String(brief), fingerprint);
  });
}

test('continuously changing stock fails visibly instead of serving stale results', async () => {
  let version = 0;
  await assert.rejects(withConsistentBrief({
    fingerprint: async () => String(version++), load: async () => 'old',
    generate: async () => 'generated', save: async (brief) => brief,
  }), /Stock changed/);
});

test('refresh bypasses a valid saved brief', async () => {
  assert.equal(await withConsistentBrief({
    refresh: true, fingerprint: async () => 'a', load: async () => { throw new Error('cache used'); },
    generate: async () => 'new', save: async (brief) => brief,
  }), 'new');
});

test('operation dates use Sydney midnight in summer and winter', () => {
  assert.equal(sydneyDay('2026-11-09T12:59:59Z'), '2026-11-09');
  assert.equal(sydneyDay('2026-11-09T13:00:00Z'), '2026-11-10');
  assert.equal(sydneyDay('2026-07-09T13:59:59Z'), '2026-07-09');
  assert.equal(sydneyDay('2026-07-09T14:00:00Z'), '2026-07-10');
});
