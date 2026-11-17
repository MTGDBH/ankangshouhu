import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DAY_MS, localDay } from '../../src/ai/temporalPolicy.js';

const base = process.env.TEST_BASE_URL;
const databasePath = process.env.TEST_TEMPORAL_DB;
assert(base && databasePath, 'Set TEST_BASE_URL and TEST_TEMPORAL_DB for an isolated V3 instance');
assert.match(databasePath, /bigchuang-v3-.*\.db$/);
const require = createRequire(import.meta.url);
const db = require('better-sqlite3')(databasePath, { fileMustExist: true });
const anchor = Date.now();
const ago = days => new Date(anchor - days * DAY_MS).toISOString();
const range = (first, last) => localDay(anchor - first * DAY_MS) + '至' + localDay(anchor - last * DAY_MS);

async function request(path, { method = 'GET', actor, body, status = 200 } = {}) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Cookie: actor.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, status, path + ' ' + text);
  return { data: JSON.parse(text), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function register(role, label = role) {
  const result = await request('/api/auth/register', { method: 'POST', status: 201,
    body: { name: 'V3-' + label + '-' + anchor, password: 'TEMP-v3-e2e-test!', age: 71, role } });
  return { id: result.data.user.id, cookie: result.cookie };
}
const senior = await register('senior');
const stranger = await register('senior', 'stranger');
const caregiver = await register('caregiver');
const chat = (message, actor = senior, subject = senior.id) => request('/api/chat', { method: 'POST', actor,
  body: { message, subject_user_id: subject } }).then(result => result.data);
const source = (id, actor = senior, subject = senior.id, status = 200) => request('/api/agent/temporal-memory/' + id + '?subject_user_id=' + subject, { actor, status }).then(result => result.data);
const reading = (value, days, offset = 0, condition = 'morning_rest') => request('/api/health/metrics', { method: 'POST', actor: senior, body: {
  type: 'bp', value, value2: 79, unit: 'mmHg', measurement_condition: condition, recorded_at: new Date(anchor - days * DAY_MS + offset).toISOString(),
} }).then(result => result.data);
const memory = response => response.presentation.temporal_memory;

const missing = await chat('请回顾我以前的血压历史记录。');
assert.equal(memory(missing).decision, 'clarify');
assert.deepEqual(missing.tool_trace, []);
assert.equal((await chat('请看看早于两年的2020年5月的血压趋势。')).task_state.status, 'waiting_user');

const history = [];
for (const day of [20, 19, 18]) history.push(await reading(121 + 20 - day, day));
for (const day of [7, 6, 5]) await reading(131 + 7 - day, day);
const question = '比较' + range(21, 17) + '和' + localDay(anchor - 6 * DAY_MS) + '的血压趋势。';
const trend = await chat(question);
assert.equal(memory(trend).evidence.length, 2);
assert.equal(memory(trend).decision, 'insufficient');
assert.match(trend.content, /122\/79/);
assert.match(trend.content, /可用测量日不足/);
const firstId = memory(trend).evidence[0].id;
assert.equal((await source(firstId)).status, 'verified');
assert.equal((await source(firstId)).sources.length, 3);
const comparison = await chat('比较' + range(21, 17) + '和' + range(8, 4) + '的血压趋势。');
assert.equal(memory(comparison).decision, 'answered', comparison.content);
assert.match(comparison.content, /均值差为 10\/0/);
await source(firstId, stranger, stranger.id, 404);
await source(firstId, stranger, senior.id, 403);
const invitation = (await request('/api/care/invitations', { method: 'POST', actor: senior, status: 201,
  body: { member_role: 'caregiver', scopes: ['use_agent','view_interventions'] } })).data;
await request('/api/care/accept', { method: 'POST', actor: caregiver, body: { code: invitation.code } });
const limited = await chat(question, caregiver);
assert.equal(memory(limited).decision, 'permission');
assert.deepEqual(limited.tool_trace, []);
await source(firstId, caregiver, senior.id, 404);

const events = await chat(range(21, 17) + '的血压记录有哪些？');
assert(memory(events).evidence.every(row => row.kind === 'event'));
assert.equal(memory(events).evidence.length, 3);
assert.equal((await source(memory(events).evidence[0].id)).status, 'verified');
const changed = (await request('/api/health/metrics/' + history[0].id, {
  method: 'PATCH', actor: senior, body: { value: 127, revision: history[0].revision },
})).data;
assert.equal((await source(firstId)).status, 'source_changed');
const corrected = await chat(question);
const correctedId = memory(corrected).evidence[0].id;
assert.notEqual(correctedId, firstId);
assert.equal((await source(correctedId)).supersedes_id, firstId);
assert.equal((await source(firstId)).status, 'superseded');
await reading(157, 20, 120000);
const conflict = await chat(question);
assert.equal(memory(conflict).decision, 'conflict');
assert.equal(memory(conflict).evidence[0].kind, 'conflict');
assert.match(conflict.content, /冲突读数/);
assert.equal(conflict.task_state.status, 'waiting_user');
assert(!conflict.content.includes('157'));
assert.equal((await source(memory(conflict).evidence[0].id)).sources.length, 4);

const profile = db.prepare(`INSERT INTO agent_memories
  (subject_user_id,actor_user_id,category,memory_key,content,status,confirmed_at,valid_until)
  VALUES (?,?,'schedule',?,?,'confirmed',?,?)`);
profile.run(senior.id, senior.id, 'morning', '我习惯早上记录', ago(2), ago(-30));
profile.run(senior.id, senior.id, 'old', '已过期的偏好', ago(50), ago(10));
const prefs = await chat('我已确认的偏好和档案记忆有哪些？');
assert.match(prefs.content, /早上记录/);
assert(!prefs.content.includes('已过期'));
assert.equal((await source(memory(prefs).evidence[0].id)).sources[0].kind, 'profile');
assert.equal(memory(await chat('我已确认的偏好和档案记忆有哪些？', caregiver)).decision, 'permission');

// Add a reviewed synthetic article only to the isolated fixture if the seed has no approved source.
if (!db.prepare("SELECT 1 FROM knowledge_articles WHERE review_status='approved' AND title LIKE '%血压%'").get()) {
  db.prepare(`UPDATE knowledge_articles SET review_status='approved',source_label='V3 fixture',reviewed_at=?
    WHERE id=(SELECT id FROM knowledge_articles WHERE title LIKE '%血压%' LIMIT 1)`).run(ago(1));
}
const draft = await chat('结合我' + range(8, 4) + '的历史血压，生成非药物观察计划草案。');
assert.equal(draft.task_state.status, 'waiting_confirmation', draft.content);
const payload = draft.plan[0].intervention_payload;
assert.equal(payload.draft, true);
assert.equal((await request('/api/actions/interventions', { actor: senior })).data.items.length, 0);

const plans = '/api/actions/interventions';
const stored = (await request(plans, { method: 'POST', actor: senior, status: 201, body: {
  ...payload, baseline_start: ago(8), baseline_end: ago(4), intervention_start: ago(4), intervention_end: ago(3),
  outcome_start: ago(3), outcome_end: ago(-6),
} })).data.intervention;
const path = plans + '/' + stored.intervention_id;
const edit = (await request(path, { method: 'PATCH', actor: senior, body: { revision: stored.revision, title: 'V3 测试已修改草案' } })).data.intervention;
assert.equal(edit.status, 'proposed');
const confirmation = (await request(path + '/submit', { method: 'POST', actor: senior, body: {} })).data.confirmation;
await request(path + '/confirm', { method: 'POST', actor: senior, body: { confirmation_token: confirmation.one_time_token } });
const feedback = { performed: false, performed_at: ago(3.5), skip_reason: '时间不方便', user_note: '想找更合适的记录时段' };
const log = (await request(path + '/executions', { method: 'POST', actor: senior, status: 201, body: feedback })).data.execution_log;
const adjustment = await chat('根据上次计划反馈给出血压调整建议。');
assert.equal(adjustment.context_manifest.temporal_memory.adjustment, 'review_schedule');
assert.equal(adjustment.plan.length, 0);
assert.match(adjustment.content, /尚缺乏/);
const feedbackId = memory(adjustment).evidence[0].id;
assert.equal((await source(feedbackId)).sources.find(row => row.kind === 'feedback').performed, 0);
await request(path + '/executions', { method: 'POST', actor: senior, status: 201, body: { performed: true, performed_at: ago(3.5),
  user_note: '回看日记后确认已执行', supersedes_execution_log_id: log.execution_log_id, change_reason: '核对了原始记录' } });
assert.equal((await source(feedbackId)).status, 'source_changed');
const updatedFeedback = await chat('根据上次计划反馈给出血压调整建议。');
assert.equal(updatedFeedback.context_manifest.temporal_memory.adjustment, 'await_recheck');
assert.equal((await source(memory(updatedFeedback).evidence[0].id)).supersedes_id, feedbackId);
for (const day of [2.2, 1.2, 0.2]) await reading(130, day);
const completedLoop = await chat('根据上次计划反馈给出血压调整建议。');
assert.equal(completedLoop.context_manifest.temporal_memory.adjustment, 'review_with_user');
assert.match(completedLoop.content, /无法据此归因于计划/);
const loopSource = await source(memory(completedLoop).evidence[0].id);
assert.equal(loopSource.sources.filter(row => row.kind === 'measurement').length, 6);
const delegatedFeedback = await chat('查询最近30天的血压计划反馈。', caregiver);
assert.equal(memory(delegatedFeedback).decision, 'answered');
assert(!delegatedFeedback.content.includes('计划前为'));
assert(!(await source(memory(delegatedFeedback).evidence[0].id, caregiver)).sources.some(row => row.kind === 'measurement'));
await request('/api/health/metrics/' + history[0].id, { method: 'DELETE', actor: senior, body: { revision: changed.revision } });
assert.equal((await source(memory(conflict).evidence[0].id)).status, 'source_changed');

const urgent = await chat('我现在明显胸痛，同时想核对上月的血压趋势。');
assert.equal(urgent.source, 'safety_rule');
assert.deepEqual(urgent.tool_trace, []);
const medication = await chat('结合历史血压生成停药调整计划草案。');
assert.equal(memory(medication).decision, 'limit');
assert.deepEqual(medication.tool_trace, []);
db.close();
console.log('V3 API PASS: periods, source lineage, deletion boundary, scopes, profiles, edited and confirmed draft, corrected feedback, safety');
