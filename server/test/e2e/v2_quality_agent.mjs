import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL;
assert(base, 'Use an isolated V2 instance with AGENT_RESEARCH_V2=1 and set TEST_BASE_URL');

async function request(path, { method = 'GET', auth, body, status = 200 } = {}) {
  const response = await fetch(base + path, { method, headers: {
    'Content-Type': 'application/json', ...(auth ? { Cookie: auth.cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, status, path + ' ' + text);
  return { data: JSON.parse(text), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

const stamp = Date.now();
async function register(role) {
  const account = await request('/api/auth/register', { method: 'POST', status: 201, body: {
    name: 'V2合成-' + role + '-' + stamp, password: 'V2-only-123456', age: 72, role,
  } });
  return { id: account.data.user.id, cookie: account.cookie };
}
const elder = await register('senior');
const family = await register('caregiver');
const chat = (auth, message, subject) => request('/api/chat', { method:'POST', auth, body: { message, subject_user_id: subject } }).then(result => result.data);
const save = (value, offset) => request('/api/health/metrics', { method:'POST', auth:elder, body: {
  type:'bp', value, value2:80, unit:'mmHg', measurement_condition:'morning_rest', recorded_at: new Date(stamp - offset).toISOString(),
} });

const missing = await chat(elder, '我想核对近30天血压趋势。');
assert.equal(missing.presentation.research_v2.decision, 'measure');
assert.equal(missing.context_manifest.live_context_loaded, false);
assert.deepEqual(missing.plan, []);
assert.deepEqual(missing.tool_trace.map(row=>row.name), ['check_data_quality']);
assert(missing.tool_trace[0].selection_reason);
await save(127, 86400000);
await save(132, 2 * 86400000);
await save(130, 3 * 86400000);
const summary = await chat(elder, '请给我最近一次血压的摘要。');
assert.equal(summary.presentation.research_v2.decision, 'answer');
assert(summary.tool_trace.some(row => row.name === 'research_metric_history' && row.status === 'success'));
assert.match(summary.content, /127/);
const trend = await chat(elder, '请比较最近30天血压趋势。');
assert.equal(trend.presentation.research_v2.decision, 'answer');
assert(trend.tool_trace.some(row => row.name === 'health_trend' && row.status === 'success'));
const before = (await request('/api/actions/followups', { auth:elder })).data.items.length;
const follow = await chat(elder, '请安排血压复测。');
assert.equal(follow.presentation.research_v2.decision, 'answer');
assert(follow.plan.some(action=>action.action_type === 'schedule_recheck' && action.requires_confirmation));
assert.equal((await request('/api/actions/followups', { auth:elder })).data.items.length, before);
await save(156, 86400000 + 120000);
const conflict = await chat(elder, '请比较最近30天血压趋势。');
assert.equal(conflict.presentation.research_v2.reason, 'conflict');
assert.equal(conflict.task_state.status, 'waiting_user');
assert.deepEqual(conflict.plan, []);

const invitation = (await request('/api/care/invitations', { method:'POST', auth:elder, status:201, body:{
  member_role:'caregiver', scopes:['use_agent', 'manage_followups', 'view_interventions'],
} })).data;
await request('/api/care/accept', { method:'POST', auth:family, body:{ code:invitation.code } });
const denied = await chat(family, '请给我最近一次血压的摘要。', elder.id);
assert.equal(denied.presentation.research_v2.reason, 'permission');
assert.equal(denied.context_manifest.live_context_loaded, false);
assert.deepEqual(denied.tool_trace, []);
assert.deepEqual(denied.plan, []);
for (const message of ['请安排血压复测。', '帮我做一份血压观察草案。']) {
  const result = await chat(family, message, elder.id);
  assert.equal(result.presentation.research_v2.reason, 'permission');
  assert.equal(result.presentation.research_v2.quality, null);
  assert.deepEqual(result.tool_trace, []);
  assert.deepEqual(result.plan, []);
}

const emergency = await chat(elder, '我现在胸痛，先看看血压可以吗？');
assert.equal(emergency.source, 'safety_rule');
assert.deepEqual(emergency.tool_trace, []);
assert(emergency.plan.every(action => action.action_type === 'contact_doctor'));
assert.equal((await request('/api/actions/followups', { auth:elder })).data.items.length, before);
console.log('V2 API PASS: quality prechecks, authorized tool evidence, confirmation-only preview, conflict clarification, scope denial, emergency bypass');
