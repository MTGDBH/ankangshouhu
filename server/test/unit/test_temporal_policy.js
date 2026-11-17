import assert from 'node:assert/strict';
import { aggregateWindow, canCompareWindows, localDay, memoryUsability, parseRecordedTime,
  proposeAdjustment, rankMemories, resolveWindows, temporalRequest } from '../../src/ai/temporalPolicy.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const dateRange = resolveWindows('比较2026-10-14至2026-10-16和2026-11-16', now);
assert.deepEqual(dateRange.windows.map(row => [localDay(row.from), localDay(row.to)]), [
  ['2026-10-14', '2026-10-17'], ['2026-11-16', '2026-11-17'],
]);
assert.equal(resolveWindows('2026年2月30日', now).invalid, true);
assert.equal(resolveWindows('近999天', now).invalid, true);
assert.equal(resolveWindows('2026-11-18', now).invalid, true);
assert.deepEqual(resolveWindows('去年9月', now).windows.map(row => localDay(row.from)), ['2025-09-01']);
assert.equal(parseRecordedTime('2026-10-14 00:01:00'), Date.parse('2026-10-13T16:01:00Z'));
assert.equal(temporalRequest('看看历史血压', now), null);
assert.equal(temporalRequest('回顾以前的血压记录', now).reason, 'time_missing');
assert.equal(temporalRequest('上个月的血压和血糖走势', now).reason, 'multiple_metrics');
assert.equal(temporalRequest('近30天血压数据质量', now), null);

const window = dateRange.windows[0];
const reading = (id, day, value, condition = 'morning_rest', time = '00:01:00') => ({
  id, type: 'bp', value, value2: 80, unit: 'mmHg', recorded_at: `2026-10-${day} ${time}`, measurement_condition: condition, source: 'manual',
});
const rows = [reading(1, 14, 120), reading(2, 15, 125), reading(3, 16, 130), reading(4, 17, 190), reading(5, 14, 126, 'morning_rest', '01:01:00')];
const historical = aggregateWindow(rows, 'bp', window, now);
assert.equal(historical.days, 3);
assert.equal(historical.value, 126);
assert.equal(historical.sources[0].recorded_at, rows[0].recorded_at);
assert.equal(aggregateWindow([...rows, reading(6, 15, 156, 'morning_rest', '00:06:00')], 'bp', window, now).state, 'conflict');
const evening = aggregateWindow(rows.map(row => ({ ...row, measurement_condition: 'evening_rest' })), 'bp', window, now);
assert.equal(canCompareWindows('bp', [historical, evening]), false);
assert.equal(aggregateWindow(rows.map(row => ({ ...row, unit: 'wrong' })), 'bp', window, now).state, 'quality_limited');

const request = { query: '当前血压记录', windows: [], historical: false, metric: 'bp', kinds: ['event'] };
const item = { id: 'new', kind: 'event', at: now - 10000, metric: 'bp', source: 'device', text: '当前血压记录', quality: 0.99 };
assert.equal(memoryUsability({ ...item, expires: now }, request, now), 'expired');
assert.equal(memoryUsability({ ...item, status: 'superseded' }, request, now), 'unavailable');
assert.equal(rankMemories([item, { ...item, id: 'conflict', status: 'conflict' }], request, now)[0].id, 'new');
assert.equal(proposeAdjustment({ skips: 2, recorded: 3, burden: 'discomfort' }).code, 'review_discomfort');
assert.equal(proposeAdjustment({ recorded: 3, matchedOutcome: false }).code, 'await_recheck');
assert.equal(proposeAdjustment({ recorded: 3, matchedOutcome: true }).code, 'review_with_user');
console.log('V3 temporal policy PASS: calendar boundaries, time validity, V2 routing, evidence quality, update and feedback safeguards');
