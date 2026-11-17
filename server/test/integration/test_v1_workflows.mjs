import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const base = process.env.TEST_BASE_URL;
assert(base && process.env.DB_PATH, 'Run against a temporary database using npm run test:integration');
const database = new Database(process.env.DB_PATH, { readonly: true });
const stamp = Date.now();
const daysAgo = (days = 0) => new Date(stamp - days * 86400000).toISOString();

async function request(path, { method = 'GET', actor, body, status = 200 } = {}) {
  const response = await fetch(base + path, { method, headers: {
    'Content-Type': 'application/json', ...(actor ? { Cookie: actor.cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, status, path + ' ' + text);
  const data = JSON.parse(text);
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function register(label, role = 'senior') {
  const result = await request('/api/auth/register', { method: 'POST', status: 201, body: {
    name: label + stamp, password: 'V1-tests-123456', age: 71, role,
  } });
  return { id: result.data.user.id, cookie: result.cookie };
}

const senior = await register('V1 本人');
const caregiver = await register('V1 家属', 'caregiver');
const other = await register('V1 其他家庭', 'caregiver');
const make = (actor, body, status = 200) => request('/api/health/metrics', { actor, method: 'POST', body, status });
const get = async (path, actor, status = 200) => (await request(path, { actor, status })).data;
const mutate = (id, actor, method, body, status = 200) => request('/api/health/metrics/' + id, { actor, method, body, status });

try {
  const initial = await get('/api/health/metrics', senior);
  assert.equal(initial.bp, null);
  const rules = (await get('/api/health/alert-rules', senior)).measurement;
  assert(rules.rules.bp.source && rules.version);
  const examples = [
    ['bp', 134, 82, 'mmHg'], ['glucose', 5.5, null, 'mmol/L'], ['hr', 75, null, 'bpm'],
    ['spo2', 97, null, '%'], ['sleep', 7, null, 'h'], ['weight', 65, null, 'kg'], ['steps', 4400, null, '步'],
  ];
  for (const [type, value, value2, unit] of examples) {
    const { data: row } = await make(senior, { type, value, value2, unit, recorded_at: daysAgo(1) });
    assert.equal(row.actor_user_id, senior.id);
    assert.equal(row.user_id, senior.id);
    assert.equal(row.unit, unit);
    assert.equal(row.revision, 1);
    assert(row.created_at && row.data_quality);
  }
  await make(senior, { type: 'steps', value: 3000, recorded_at: daysAgo(20) });
  await make(senior, { type: 'steps', value: 2500, recorded_at: daysAgo(70) });
  await make(senior, { type: 'steps', value: 1900, recorded_at: daysAgo(180) });
  for (const [days, count] of [[7, 1], [30, 2], [90, 3], [365, 4]]) {
    const data = await get('/api/health/metrics/steps/history?days=' + days, senior);
    assert.equal(data.points.length, count);
    assert.equal(data.statistics[0].value.count, count);
    assert.deepEqual(data.statistics[0].record_ids, data.points.map(row => row.id));
  }
  await get('/api/health/metrics/steps/history?days=oops', senior, 400);
  await make(senior, { type: 'bp', value: 124, value2: ' ', recorded_at: daysAgo(1) }, 400);
  await make(senior, { type: 'glucose', value: 90, unit: 'mg/dL' }, 400);
  await make(senior, { type: 'steps', value: 4500, recorded_at: 'invalid' }, 400);
  await make(senior, { type: 'bp', value: 134, value2: 82, source: 'device', device_id: 777777 }, 400);

  const draftMeasurement = { type: 'bp', value: 136, value2: 82, unit: 'mmHg', subject_user_id: senior.id, recorded_at: daysAgo(0.1), measurement_condition: 'morning_rest' };
  const invitation = async (actor, scopes) => (await request('/api/care/invitations', {
    actor, method: 'POST', status: 201, body: { member_role: 'caregiver', scopes, valid_days: 1 },
  })).data;
  const accept = (actor, code) => request('/api/care/accept', { actor, method: 'POST', body: { code } });
  const defaultInvite = await invitation(senior);
  assert(!defaultInvite.scopes.includes('record_measurements'));
  await accept(caregiver, defaultInvite.code);
  await make(caregiver, draftMeasurement, 403);
  await make(other, draftMeasurement, 403);
  const scoped = await invitation(senior, ['record_measurements']);
  const relationship = (await accept(caregiver, scoped.code)).data.relationship;
  const recorded = (await make(caregiver, { ...draftMeasurement, source: 'synthetic' })).data;
  assert.equal(recorded.source, 'caregiver_report');
  assert.equal(recorded.actor_user_id, caregiver.id);
  assert.equal(recorded.user_id, senior.id);
  assert.equal(recorded.followup_match, null);
  const duplicate = (await make(caregiver, draftMeasurement)).data;
  assert(duplicate.duplicate && duplicate.id === recorded.id && duplicate.value === undefined);
  await get('/api/health/metrics/' + recorded.id + '?subject_user_id=' + senior.id, caregiver, 403);
  await get('/api/health/metrics/bp/history?subject_user_id=' + senior.id, caregiver, 403);
  await mutate(recorded.id, caregiver, 'PATCH', { value: 132, revision: 1, subject_user_id: senior.id }, 403);
  await mutate(recorded.id, other, 'DELETE', { revision: 1 }, 404);
  const update = (await mutate(recorded.id, senior, 'PATCH', { value: 131, note: '测试备注不会复制到审计', revision: 1 })).data;
  assert.equal(update.value, 131);
  assert.equal(update.source, 'caregiver_report');
  assert.equal(update.actor_user_id, caregiver.id);
  assert.equal(update.revision, 2);
  assert.equal((await get('/api/health/metrics/' + recorded.id, senior)).value, 131);
  await mutate(recorded.id, senior, 'PATCH', { value: 132, revision: 1 }, 409);
  await mutate(recorded.id, senior, 'DELETE', { revision: 1 }, 409);
  await mutate(recorded.id, senior, 'DELETE', { revision: 2 });
  await get('/api/health/metrics/' + recorded.id, senior, 404);
  assert.equal(database.prepare('SELECT * FROM metrics WHERE id=?').get(recorded.id), undefined);
  const audit = database.prepare("SELECT actor_user_id,subject_user_id,action,metadata FROM audit_logs WHERE event_type='health_measurement' AND resource=? ORDER BY id").all('measurement:' + recorded.id);
  assert.deepEqual(audit.map(row => row.action), ['create','update','delete']);
  assert.deepEqual(audit.map(row => row.actor_user_id), [caregiver.id,senior.id,senior.id]);
  assert(!JSON.stringify(audit).includes('测试备注'));
  const replacement = (await make(senior, { type: 'weight', value: 66, recorded_at: daysAgo(0.1) })).data;
  assert(replacement.id > recorded.id);
  await request('/api/care/relationships/' + relationship.id + '/revoke', {
    actor: senior, method: 'POST', body: { reason: '验收撤回' },
  });
  await make(caregiver, draftMeasurement, 403);

  const critical = (await make(senior, { type: 'bp', value: 181, value2: 100, recorded_at: daysAgo(0.05) })).data;
  const alertItems = (await get('/api/alerts', senior)).items;
  const warning = alertItems.find(row => row.rule_key === 'measurement.bp.very_high');
  assert.equal(warning.rule_version, rules.version);
  assert.deepEqual(JSON.parse(warning.evidence_metric_ids), [critical.id]);
  assert.equal(database.prepare("SELECT count(*) n FROM todos WHERE user_id=? AND kind='followup'").get(senior.id).n, 0);
  assert.equal((await mutate(critical.id, senior, 'PATCH', { value: 132, revision: 1 })).data.revision, 2);
  assert.equal((await get('/api/alerts', senior)).items.find(row => row.id === warning.id).status, 'resolved');

  const baseline = (await make(senior, { type: 'bp', value: 134, value2: 84, recorded_at: daysAgo(0.003), measurement_condition: 'morning_rest' })).data;
  const action = (await request('/api/actions', { actor: senior, method: 'POST', status: 202,
    body: { action_type: 'schedule_recheck', title: 'V1 血压复测', metric_type: 'bp', baseline_metric_id: baseline.id,
      due_at: new Date(Date.now()+60000).toISOString() },
  })).data;
  const followup = (await request('/api/actions/' + action.request.id + '/confirm', { actor: senior, method: 'POST',
    body: { confirmation_token: action.confirmation.one_time_token },
  })).data.followup;
  const candidate = (await make(senior, { type: 'bp', value: 130, value2: 81, recorded_at: daysAgo(), measurement_condition: 'morning_rest' })).data;
  assert.equal(candidate.followup_match.id, followup.id);
  const confirmCandidate = () => request('/api/actions/followups/' + followup.id + '/candidate/confirm', {
    actor: senior, method: 'POST', body: { metric_id: candidate.id },
  });
  assert.equal((await confirmCandidate()).data.status, 'completed');
  const corrected = (await mutate(candidate.id, senior, 'PATCH', { value: 129, revision: 1 })).data;
  const reopened = (await get('/api/actions/followups', senior)).items.find(row => row.id === followup.id);
  assert.equal(reopened.status, 'pending_result_confirmation');
  assert.equal(reopened.comparison.result.value, corrected.value);
  await confirmCandidate();
  await mutate(candidate.id, senior, 'DELETE', { revision: corrected.revision });
  const deletedResult = (await get('/api/actions/followups', senior)).items.find(row => row.id === followup.id);
  assert.equal(deletedResult.result_metric_id, null);
  assert.equal(deletedResult.comparison, null);

  const plans = '/api/actions/interventions';
  const windows = { baseline_start: daysAgo(16), baseline_end: daysAgo(8), intervention_start: daysAgo(7),
    intervention_end: daysAgo(-2), outcome_start: daysAgo(-3), outcome_end: daysAgo(-10) };
  const plan = (await request(plans, { actor: senior, method: 'POST', status: 201, body: {
    title: 'V1 初始观察', intervention_type: 'activity', protocol: { action: '散步', frequency: '每天一次' },
    adherence_target: { minimum_rate: 0.7 }, target_metrics: ['steps'], ...windows,
  } })).data;
  const planPath = plans + '/' + plan.intervention.intervention_id;
  await request(planPath, { actor: caregiver, method: 'PATCH', status: 403, body: { revision: 1, title: '越权' } });
  const revision = (await request(planPath, { actor: senior, method: 'PATCH', body: {
    revision: plan.intervention.revision, title: 'V1 已修订草案', protocol: { frequency: '每周两次' },
  } })).data.intervention;
  assert.equal(revision.status, 'proposed');
  assert.equal(revision.protocol.action, '散步');
  await request(planPath, { actor: senior, method: 'PATCH', status: 409, body: { revision: plan.intervention.revision, title: '旧编辑' } });
  await request(planPath + '/confirm', { actor: senior, method: 'POST', status: 409, body: {
    confirmation_token: plan.confirmation.one_time_token,
  } });
  const submit = (await request(planPath + '/submit', { actor: senior, method: 'POST', body: {} })).data;
  await request(planPath + '/confirm', { actor: senior, method: 'POST', status: 409, body: {
    confirmation_token: plan.confirmation.one_time_token,
  } });
  const activated = (await request(planPath + '/confirm', { actor: senior, method: 'POST', body: {
    confirmation_token: submit.confirmation.one_time_token,
  } })).data.intervention;
  assert.equal(activated.status, 'active');
  await request(planPath, { actor: senior, method: 'PATCH', status: 409, body: { revision: activated.revision, title: '不能直接改生效计划' } });
  const note = (await request(planPath + '/executions', { actor: senior, method: 'POST', status: 201, body: {
    performed: false, performed_at: daysAgo(), skip_reason: '因个人时间未执行', user_note: '补充反馈',
  } })).data.execution_log;
  assert.equal(note.user_note, '补充反馈');
  assert.equal((await get(planPath, senior)).intervention.execution_logs[0].skip_reason, '因个人时间未执行');

  const chat = (await request('/api/chat', { actor: senior, method: 'POST', body: { message: '我最近走得少吗' } })).data;
  assert.equal(chat.confidence.type, 'data', JSON.stringify(chat));
  assert(chat.tool_trace.some(tool => tool.name === 'behavior' && tool.status === 'success'));
  await request('/api/chat', { actor: caregiver, method: 'POST', status: 403, body: { message: '我最近走得少吗', subject_user_id: senior.id } });
  const agentOnly = await invitation(senior, ['use_agent']);
  await accept(caregiver, agentOnly.code);
  const limited = (await request('/api/chat', { actor: caregiver, method: 'POST', body: {
    message: '我最近走得少吗', subject_user_id: senior.id,
  } })).data;
  assert.equal(limited.context_manifest.live_context_loaded, false);
  assert(limited.tool_trace.some(tool => tool.name === 'behavior' && tool.error_code === 'TOOL_PERMISSION_DENIED'));
  const inbox = await get('/api/agent/inbox?subject_user_id=' + senior.id, caregiver);
  assert.deepEqual(inbox.active_interventions, []);
  assert.deepEqual(inbox.scheduled, []);
  console.log('V1 workflows PASS: attribution, scoped CRUD, SQLite audit, four history windows, rule evidence, retest correction, plan edit/confirmation/feedback, behavior and tools');
} finally {
  database.close();
}
