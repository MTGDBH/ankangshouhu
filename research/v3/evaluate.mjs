import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { memoryUsability, proposeAdjustment, rankMemories, resolveWindows, TEMPORAL_DEFAULT, TEMPORAL_VERSION } from '../../server/src/ai/temporalPolicy.js';

const location = path => new URL(path, import.meta.url);
const manifest = JSON.parse(readFileSync(location('./data/splits.json'), 'utf8'));
const dataset = readFileSync(location('./data/cases.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const validation = dataset.filter(row => row.split === 'validation');
const test = dataset.filter(row => row.split === 'test');
if (dataset.length !== manifest.counts.validation + manifest.counts.test ||
  createHash('sha256').update(JSON.stringify(dataset)).digest('hex') !== manifest.digest ||
  JSON.stringify(validation.map(row => row.id)) !== JSON.stringify(manifest.validation) ||
  JSON.stringify(test.map(row => row.id)) !== JSON.stringify(manifest.test)) throw new Error('Dataset or split mismatch');
const W = [[.55,.20,.15,.10], [.40,.30,.20,.10], [.35,.30,.20,.15], [.25,.40,.20,.15], [.20,.25,.35,.20]];
const grid = W.flatMap(weights => [.25,.35,.45,.55,.65,.75].flatMap(threshold => [7,15,30,60].map(halfLife => ({ weights, threshold, halfLife }))));
const k = 3;
const rate = (n, total) => total ? Number((n / total).toFixed(4)) : null;

function updateView(items, strategy) {
  if (strategy === 'append_without_retraction') return items.map(item => item.status === 'superseded' ? { ...item, status: undefined } : item);
  if (strategy !== 'latest_overwrite') return items;
  const latest = new Map();
  for (const item of items) if (!latest.has(item.key) || latest.get(item.key).revision < item.revision) latest.set(item.key, item);
  return [...latest.values()];
}

function assess(row, options) {
  const windows = resolveWindows(row.query, row.now).windows;
  const comparable = ranges => ranges.map(window => [window.from, window.to]).sort((a, b) => a[0] - b[0]);
  const timeCorrect = JSON.stringify(comparable(windows)) === JSON.stringify(comparable(row.location));
  const request = { query: row.query, metric: row.metric, windows, kinds: row.kinds, historical: row.historical };
  const items = updateView(row.items, options.update);
  const temporal = !options.method || options.method === 'temporal';
  const unresolvedConflict = options.conflicts !== false && temporal && items.some(item => memoryUsability(item, request, row.now) === 'conflict');
  const missingTime = /以前的.*历史记录/.test(row.query) && !windows.length;
  const selected = temporal && (unresolvedConflict || missingTime) ? [] : rankMemories(items, request, row.now, { k, ...options });
  const first = selected[0];
  const decision = unresolvedConflict ? 'clarify_conflict' : temporal && missingTime ? 'clarify_time' : first ? 'answer' : 'abstain';
  const expected = new Set(row.gold);
  const goldRefs = new Set(row.items.filter(item => expected.has(item.id)).flatMap(item => item.refs));
  const references = [...new Set(selected.flatMap(item => item.refs))];
  const selectedStatus = selected.map(item => memoryUsability(row.items.find(original => original.id === item.id), request, row.now));
  const stale = selectedStatus.includes('expired');
  const unsafe = selectedStatus.some(status => ['expired','unavailable','wrong_window','conflict','different_metric','different_kind'].includes(status));
  const suggestions = row.expected_suggestion && first ?
    options.generic ? 'await_recheck' : proposeAdjustment(first).code : null;
  const firstCorrect = selected.findIndex(item => expected.has(item.id));
  return { id: row.id, family: row.family, expected: row.expected_decision, decision, time_correct: timeCorrect,
    gold: row.gold, selected: selected.map(item => item.id), hits: selected.filter(item => expected.has(item.id)).length,
    reciprocal_rank: firstCorrect < 0 ? 0 : 1 / (firstCorrect + 1), expired_used: stale, wrong_memory_used: unsafe,
    reference_total: references.length, reference_correct: references.filter(ref => goldRefs.has(ref)).length,
    expected_suggestion: row.expected_suggestion || null, suggestion: suggestions };
}

function metrics(rows) {
  const answerable = rows.filter(row => row.gold.length);
  const conflicts = rows.filter(row => row.expected === 'clarify_conflict');
  const suggestions = rows.filter(row => row.expected_suggestion);
  const sum = (subset, getter) => subset.reduce((total, row) => total + getter(row), 0);
  return { n: rows.length, answerable_n: answerable.length, conflicts_n: conflicts.length, suggestion_n: suggestions.length,
    recall_at_3: rate(sum(answerable, row => row.hits / row.gold.length), answerable.length),
    mrr_at_3: rate(sum(answerable, row => row.reciprocal_rank), answerable.length),
    time_accuracy: rate(sum(rows, row => Number(row.time_correct)), rows.length),
    conflict_accuracy: rate(sum(conflicts, row => Number(row.expected === row.decision)), conflicts.length),
    expired_misuse: rate(sum(rows, row => Number(row.expired_used)), rows.length),
    long_term_misuse: rate(sum(rows, row => Number(row.wrong_memory_used)), rows.length),
    citation_precision: rate(sum(rows, row => row.reference_correct), sum(rows, row => row.reference_total)),
    suggestion_match: rate(sum(suggestions, row => Number(row.suggestion === row.expected_suggestion)), suggestions.length),
    decision_accuracy: rate(sum(rows, row => Number(row.decision === row.expected)), rows.length),
  };
}

const validationGrid = grid.map(options => ({
  options, metrics: metrics(validation.map(row => assess(row, options))),
})).map(candidate => ({ ...candidate,
  objective: candidate.metrics.recall_at_3 + candidate.metrics.mrr_at_3 + candidate.metrics.citation_precision
    + candidate.metrics.decision_accuracy - 2 * candidate.metrics.long_term_misuse - candidate.metrics.expired_misuse,
}));
validationGrid.sort((a, b) => b.objective - a.objective || a.options.threshold - b.options.threshold
  || Math.abs(a.options.halfLife - 30) - Math.abs(b.options.halfLife - 30));
const best = validationGrid[0].options;
if (JSON.stringify(best) !== JSON.stringify(TEMPORAL_DEFAULT)) throw new Error('Validation choice differs from the frozen runtime configuration');
const methods = {
  vector: { method: 'vector' }, time_filter: { method: 'time_filter' }, temporal: best,
  no_decay: { ...best, decay: false }, no_conflict_control: { ...best, conflicts: false },
  latest_overwrite: { ...best, update: 'latest_overwrite' },
  append_without_retraction: { ...best, update: 'append_without_retraction' },
  generic_suggestions: { ...best, generic: true },
};
const runs = [];
const testMetrics = {};
for (const [label, options] of Object.entries(methods)) {
  const cases = test.map(row => assess(row, options));
  for (const row of cases) runs.push({ method: label, ...row });
  const byFamily = Object.fromEntries([...new Set(cases.map(row => row.family))]
    .map(family => [family, metrics(cases.filter(row => row.family === family))]));
  testMetrics[label] = { ...metrics(cases), by_family: byFamily };
}
const digest = { experiment_version: 'temporal-evaluation.v1', policy_version: TEMPORAL_VERSION,
  dataset: { version: manifest.version, digest: manifest.digest }, selected_options: best,
  candidate_count: grid.length, validation_winner: validationGrid[0], test: testMetrics };
mkdirSync(location('./results/'), { recursive: true });
writeFileSync(location('./results/metrics.json'), JSON.stringify(digest, null, 2) + '\n');
writeFileSync(location('./results/validation-grid.json'), JSON.stringify(validationGrid, null, 2) + '\n');
writeFileSync(location('./results/runs.jsonl'), runs.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log('Validation choice', best);
console.table(Object.fromEntries(Object.entries(testMetrics).map(([method, { by_family, ...row }]) => [method, row])));
