import { createHash } from 'node:crypto';
import db from '../db.js';
import { researchRisk, safeResearchReply } from './qualityPolicy.js';
import { throwIfAgentCancelled } from '../services/agentRunCancellation.js';
import { proposeIntervention } from './tools/intervention.js';
import { authorizeToolCall } from './policyEngine.js';
import {
  aggregateWindow, canCompareWindows, DAY_MS, localDay, METRIC_LABELS, parseRecordedTime,
  proposeAdjustment, rankMemories, TEMPORAL_VERSION, TEMPORAL_DEFAULT,
} from './temporalPolicy.js';
import {
  getTemporalFeedback, getTemporalMeasurements, getTemporalProfiles, makeReference,
  saveMemoryRevisions, temporalPermissions,
} from './temporalStore.js';

const iso = time => new Date(time).toISOString();
const key = (kind, metric, window) => [kind, metric, localDay(window.from), localDay(window.to)].join(':');
const formatValue = row => row.value + (row.value2 == null ? '' : '/' + row.value2) + ' ' + (row.unit || '');
const SHA = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const plain = content => ({ content, selected: [], plan: [] });
const queryFor = (message, request, kinds) => ({ ...request, query: message, kinds });
const insufficient = { insufficient: '可用测量日不足', quality_limited: '单位、来源或测量条件待核对',
  conflict: '存在同时间、同条件的冲突读数，请核对原记录' };

function readyWindows(request, now, defaults) {
  return request.windows.length ? request.windows : [{ from: now - defaults * DAY_MS, to: now + 1, label: '最近' + defaults + '天' }];
}

function trendItem(metric, range, summary) {
  const kind = summary.state === 'conflict' ? 'conflict' : 'trend';
  return { id: key('trend', metric, range), kind, metric, at: range.from, end: range.to,
    eventAt: summary.sources.length ? Math.max(...summary.sources.map(row => parseRecordedTime(row.recorded_at))) : range.from,
    text: METRIC_LABELS[metric] + ' 趋势 变化 比较 ' + range.label, quality: summary.quality, status: summary.state,
    reliability: summary.sources.length ? summary.sources.filter(row => ['manual', 'device', 'clinician', 'caregiver_report'].includes(row.source)).length / summary.sources.length : 0,
    refs: summary.sources.map(row => makeReference('measurement', row)) };
}

async function readings(args, request, now) {
  const { subject, message } = args;
  const ranges = readyWindows(request, now, 14);
  const label = METRIC_LABELS[request.metric];
  const periodData = ranges.map(window => getTemporalMeasurements(subject.id, request.metric, window, now));
  if (periodData.some(period => period.overflow)) return { ...plain('该时间段的测量记录较多，请缩短时间范围。'), decision: 'narrow' };
  const summaries = ranges.map((window, index) => aggregateWindow(periodData[index].rows, request.metric, window, now, request.mode === 'events' ? 1 : 3));
  if (request.mode === 'draft') {
    const baseline = summaries[0];
    if (ranges.length !== 1 || baseline.state !== 'supported') {
      return { ...plain('草案需要一段可比较的个人基线。' + (insufficient[baseline.state] || '请选一个连续时间段。')), decision: 'insufficient',
        selected: ranges.map((range, i) => trendItem(request.metric, range, summaries[i])) };
    }
    const latest = baseline.sources.toSorted((a, b) => parseRecordedTime(b.recorded_at) - parseRecordedTime(a.recorded_at))[0];
    const result = await proposeIntervention(args, { message, temporalBaseline: { measurementId: latest.id } });
    if (!result.success) return { ...plain(result.message), decision: 'limited', selected: [trendItem(request.metric, ranges[0], baseline)] };
    const proposal = result.proposal;
    const payload = { ...proposal.intervention_payload, baseline_start: iso(ranges[0].from),
      baseline_end: iso(Math.min(now, ranges[0].to)), draft: true,
      idempotency_key: SHA({ draft: proposal.intervention_payload.idempotency_key, from: localDay(ranges[0].from),
        to: localDay(ranges[0].to), records: baseline.sources.map(row => makeReference('measurement', row)) }) };
    return { content: '我依据所选历史时段中 ' + baseline.days + ' 个可比较测量日生成了非药物观察草案。您可以先编辑，再由本人确认。',
      selected: [trendItem(request.metric, ranges[0], baseline)],
      plan: [{ icon: '观', title: payload.title, desc: '先核对记录和复测方式，再确认。', action_type: 'n_of_1_intervention',
        requires_confirmation: true, intervention_payload: payload, proposal_details: { ...proposal, intervention_payload: payload } }] };
  }
  if (request.mode === 'events' && summaries[0].state === 'supported') {
    const candidates = summaries[0].sources.map(row => ({ id: 'event:' + row.id, kind: 'event', at: parseRecordedTime(row.recorded_at),
      metric: request.metric, text: label + ' 测量记录 读数 ' + ranges[0].label, quality: summaries[0].quality,
      source: row.source, row, refs: [makeReference('measurement', row)] }));
    const selected = rankMemories(candidates, queryFor(message, request, ['event']), now, { ...TEMPORAL_DEFAULT, k: 5 });
    if (selected.length) return { content: selected.map(({ row, at }) => localDay(at) + '的' + label + '记录为 ' + formatValue(row) + '。').join('\n'),
      selected, plan: [] };
  }
  const selected = ranges.map((range, i) => trendItem(request.metric, range, summaries[i]));
  const lines = summaries.map((summary, index) => {
    const heading = ranges[index].label + '（' + localDay(ranges[index].from) + ' 至 ' + localDay(Math.min(now, ranges[index].to - 1)) + '）';
    return heading + '，' + (summary.state === 'supported'
      ? summary.days + ' 个可用测量日，' + label + '按测量日平均为 ' + formatValue(summary) + '。'
      : insufficient[summary.state] + '。');
  });
  if (ranges.length > 1) {
    const periods = ranges.map((range, i) => ({ range, summary: summaries[i] })).sort((a, b) => a.range.from - b.range.from);
    const nonOverlapping = periods.every(({ range }, i) => i === 0 || periods[i - 1].range.to <= range.from);
    if (nonOverlapping && canCompareWindows(request.metric, periods.map(item => item.summary))) {
      const first = periods[0];
      const last = periods.at(-1);
      const delta = Math.round((last.summary.value - first.summary.value) * 100) / 100;
      const secondary = request.metric === 'bp' ? Math.round((last.summary.value2 - first.summary.value2) * 100) / 100 : null;
      lines.push(last.range.label + '相对' + first.range.label + '的均值差为 ' + formatValue({ value: delta, value2: secondary, unit: last.summary.unit }) + '。');
    } else lines.push('时段重叠、可用记录不足或测量条件不同，无法直接比较。');
  }
  const decision = summaries.some(row => row.state === 'conflict') ? 'conflict'
    : summaries.every(row => row.state === 'supported') ? 'answered' : 'insufficient';
  return { content: lines.join('\n'), selected, plan: [], decision };
}

function profiles(subject, message, request, now) {
  const candidates = getTemporalProfiles(subject.id, now).map(row => {
    const at = parseRecordedTime(row.confirmed_at);
    const expires = row.valid_until ? parseRecordedTime(row.valid_until) : at + 365 * DAY_MS;
    return { id: 'profile:' + row.memory_key, kind: 'profile', at, end: expires, expires, source: 'confirmed', quality: 1,
      text: '档案记忆 已确认的偏好 ' + row.category + ' ' + row.content, row, refs: [makeReference('profile', row)] };
  });
  const selected = rankMemories(candidates, queryFor(message, request, ['profile']), now, { k: 5 });
  if (!selected.length) return { ...plain('这个范围内暂无有效的本人已确认档案记忆。'), decision: 'insufficient' };
  return { content: '已确认的档案记忆\n' + selected.map(item => '• ' + item.row.content).join('\n'), selected, plan: [] };
}

function feedback(args, request, now, permissions) {
  const { actor, subject, message } = args;
  const ranges = readyWindows(request, now, 120);
  const { items, overflow } = getTemporalFeedback(subject.id, request.metric, ranges, now);
  if (overflow) return { ...plain('该时间段的计划或反馈记录较多，请缩短时间范围。'), decision: 'narrow' };
  const candidates = items.map(({ plan, logs }) => {
    const metric = JSON.parse(plan.target_metrics)[0];
    const start = parseRecordedTime(plan.confirmed_at);
    const end = parseRecordedTime(plan.outcome_end);
    const visibility = permissions.measurements ? 'with_measurements' : 'feedback_only';
    return { id: 'feedback:' + plan.id + ':' + visibility + ':' + ranges.map(range => localDay(range.from) + '/' + localDay(range.to)).join(':'),
      at: start, end, eventAt: start, expires: end + 120 * DAY_MS, metric, kind: 'feedback',
      text: (METRIC_LABELS[metric] || '') + ' 计划反馈 执行反馈 调整建议 计划前后', source: 'self_report',
      quality: Math.min(1, 0.45 + logs.length * 0.1),
      refs: [makeReference('plan', plan), ...logs.map(row => makeReference('feedback', row))], plan, logs };
  }).filter(item => item.at < item.end);
  const ranked = rankMemories(candidates, queryFor(message, request, ['feedback']), now, { k: candidates.length });
  const latest = /上次|上一份|最近一次/.test(message);
  if (ranked.length > 1 && !latest) return { ...plain('这段时间有多个已确认计划。请再指定指标或一个更短的时间段。'), decision: 'clarify' };
  if (latest) ranked.sort((a, b) => b.eventAt - a.eventAt);
  const selected = ranked.slice(0, 1);
  if (!selected.length) return { ...plain('这个时段找不到匹配且已确认的计划。请指定计划的指标或时间。'), decision: 'insufficient' };
  const item = selected[0];
  const { plan, logs, metric } = item;
  const lines = ['找到 ' + localDay(item.eventAt) + ' 确认的' + (METRIC_LABELS[metric] || '健康') + '观察计划。',
    '该查询范围内有 ' + logs.length + ' 条有效执行记录，其中完成 ' + logs.filter(row => row.performed).length + ' 条。'];
  let matchedOutcome = false;
  if (permissions.measurements && METRIC_LABELS[metric]) {
    const phases = [
      { from: parseRecordedTime(plan.baseline_start), to: parseRecordedTime(plan.baseline_end), label: '计划前' },
      { from: parseRecordedTime(plan.outcome_start), to: parseRecordedTime(plan.outcome_end), label: '计划后' },
    ];
    const summaries = phases.map(window => {
      if (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.from >= Math.min(window.to, now)) return null;
      const { rows, overflow } = getTemporalMeasurements(subject.id, metric, window, now);
      return overflow ? null : aggregateWindow(rows, metric, window, now);
    });
    matchedOutcome = summaries.every(Boolean) && canCompareWindows(metric, summaries);
    if (matchedOutcome) {
      lines.push('匹配测量条件后，计划前为 ' + formatValue(summaries[0]) + '，计划后为 ' + formatValue(summaries[1]) + '。此处只描述个人前后变化，无法据此归因于计划。');
      for (const summary of summaries) item.refs.push(...summary.sources.map(row => makeReference('measurement', row)));
    } else lines.push('计划前后尚缺乏条件一致且数量足够的测量，本次不比较变化。');
  }
  if (request.mode === 'adjustment' && actor.id === subject.id) {
    const notes = logs.map(row => (row.user_note || '') + ' ' + (row.skip_reason || '')).join(' ');
    const burden = /胸痛|头晕|喘不过气|不舒服|不适|摔倒/.test(notes) ? 'discomfort' : /时间|忙|忘|太晚|太早/.test(notes) ? 'schedule' : 'unknown';
    const suggestion = proposeAdjustment({ recorded: logs.length, skips: logs.filter(row => !row.performed).length, matchedOutcome, burden });
    lines.push(suggestion.message, '本轮仅提供调整建议，计划仍需由您核对和确认。');
    return { content: lines.join('\n'), selected, plan: [], suggestion: suggestion.code };
  }
  return { content: lines.join('\n'), selected, plan: [] };
}

export async function runTemporalTurn(args, request, runId, now = Date.now()) {
  const { actor, subject, conversation, signal, message } = args;
  const started = Date.now();
  const originalRisk = researchRisk(message);
  const medication = /调整.{0,4}(?:用药|药物|药量)|药物.{0,4}调整|加药|减药/.test(message);
  const risk = originalRisk === 'routine' && medication ? 'medication' : originalRisk;
  const toolArgs = { mode: request.mode, metric: request.metric, windows: request.windows.map(window => [iso(window.from), iso(window.to)]) };
  const permissions = risk === 'routine' && !request.reason ? temporalPermissions(actor, subject, request.mode) : null;
  let result;
  let evidence = [];
  let trace = [];
  if (risk !== 'routine') {
    const decision = risk === 'urgent' ? 'escalate' : 'limit';
    result = { ...plain(safeResearchReply({ decision, reason: 'medication_boundary' })), decision };
  } else if (request.reason) {
    const questions = { time_missing: '您想核对哪段时间？例如上个月、2026年8月，或最近30天。', metric_missing: '您想核对哪项指标？例如血压、血糖或体重。',
      invalid_time: '请核对日期并给出两年以内的有效时间段。', multiple_metrics: '请先选一项指标，我会按所选时间段核对。' };
    result = { ...plain(questions[request.reason]), decision: 'clarify' };
  } else if (!permissions.allowed || !authorizeToolCall({ name: 'temporal_memory', args: toolArgs, actor, subject }).allowed) {
    result = { ...plain('当前授权无法读取这类历史记忆。请由本人操作，或核对已共享的范围。'), decision: 'permission' };
  } else {
    args.onProgress?.('context', '正在核对历史时间与原始记录…');
    throwIfAgentCancelled(signal);
    try {
      if (request.mode === 'profile') result = profiles(subject, message, request, now);
      else if (request.mode === 'feedback' || request.mode === 'adjustment') result = feedback(args, request, now, permissions);
      else result = await readings(args, request, now);
      throwIfAgentCancelled(signal);
      evidence = saveMemoryRevisions(subject.id, result.selected, now).map(item => ({
        id: item.revisionId, kind: item.kind, metric: item.metric || null, event_at: iso(item.eventAt ?? item.at),
        quality: item.status || 'supported', source_count: item.refs.length,
      }));
    } catch (error) {
      if (signal?.aborted || error?.code === 'AGENT_CANCELLED') throw error;
      console.warn('[temporal-memory] retrieval failed:', error.code || error.name);
      result = { ...plain('历史记忆暂时无法读取。请稍后重试，或从健康记录中核对原始测量。'), decision: 'retrieval_failed' };
    }
    const duration = Date.now() - started;
    const status = result.decision === 'retrieval_failed' ? 'error' : 'success';
    const manifest = { version: TEMPORAL_VERSION, decision: result.decision || 'answered', source_ids: evidence.map(row => row.id) };
    db.prepare(`INSERT INTO agent_tool_calls
      (run_id,call_index,tool_name,subject_user_id,arguments,dedupe_key,status,latency_ms,error_code,result_manifest,result_hash,completed_at)
      VALUES (?,0,'temporal_memory',?,?,?,?,?,?,?,?,?)`).run(runId, subject.id, JSON.stringify(toolArgs), SHA(toolArgs), status,
      duration, status === 'error' ? 'TEMPORAL_RETRIEVAL_FAILED' : null, JSON.stringify(manifest), SHA(manifest), iso(Date.now()));
    trace = [{ name: 'temporal_memory', label: '时序记忆与来源核对', status, latency_ms: duration, selection_reason: request.mode }];
  }
  const decision = result.decision || 'answered';
  const waiting = ['clarify', 'narrow', 'conflict'].includes(decision);
  const taskStatus = waiting ? 'waiting_user' : result.plan.length ? 'waiting_confirmation' : decision === 'answered' ? 'completed' : 'needs_followup';
  const context = { orchestrator_version: 'v3', live_context_loaded: false,
    temporal_memory: { version: TEMPORAL_VERSION, mode: request.mode, decision, windows: request.windows.map(row => [iso(row.from), iso(row.to)]),
      adjustment: result.suggestion || null, revision_ids: evidence.map(row => row.id) } };
  db.prepare('UPDATE agent_runs SET status=?,context_manifest=?,latency_ms=?,completed_at=? WHERE id=?')
    .run('completed', JSON.stringify(context), Date.now() - started, iso(Date.now()), runId);
  return { source: decision === 'escalate' ? 'safety_rule' : 'temporal_memory', content: result.content, plan: result.plan,
    confidence: { type: decision === 'answered' && evidence.length ? 'data' : 'common_sense', sources: ['时序记忆与原始记录'], reasoning: '按时间、权限、质量和来源核对' },
    run_id: runId, conversation_id: conversation.id, context_manifest: context, tool_trace: trace,
    task_state: { goal: '核对长期健康记录', status: taskStatus, next_step: result.plan.length ? '核对后由本人确认' : '', success_criteria: '证据与原记录、时间及对象一致' },
    presentation: { mode: 'plain', temporal_memory: { version: TEMPORAL_VERSION, decision, subject_id: subject.id, evidence } },
  };
}
