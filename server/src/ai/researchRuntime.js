import db from '../db.js';
import { decideResearchCase, inferResearchTask, researchRisk, safeResearchReply, POLICY_VERSION } from './qualityPolicy.js';

const trends = { bp: ['systo','diasto'], glucose: ['glucose'], hr: ['pulse'], weight: ['weight'], sleep: ['sleep'] };
const taskScopes = {
  trend: ['view_trends'], screen: ['view_trends'], summary: ['view_summary'], quality: ['view_summary'],
  plan: ['view_interventions', 'view_summary'], followup: ['manage_followups', 'view_summary'],
};

export function prepareResearchTurn({ actor, subject, scopes, question, intent }) {
  if (process.env.AGENT_RESEARCH_V2 !== '1') return null;
  const request = inferResearchTask(question);
  if (intent.evaluateInterventionHit || intent.explainInterventionHit || intent.adherenceHit ||
    intent.listInterventionsHit || intent.followupHit && !intent.actionHit || intent.dailyPlanHit || intent.deviceHit || intent.alertsHit) return null;
  if (request.task === 'knowledge' && researchRisk(question) === 'routine') return null;
  if (intent.days) request.days = intent.days;
  const self = actor.id === subject.id;
  const danger = researchRisk(question);
  if (danger === 'routine' && !self && taskScopes[request.task]?.some(scope => !scopes?.includes(scope))) {
    return { ...request, decision: 'limit', reason: 'permission', tools: [], danger, version: POLICY_VERSION, quality: null };
  }
  // Scope is checked before fetching records. The policy and its log never receive free-text health notes.
  const events = danger === 'routine' && request.metric ? db.prepare(`SELECT id,type,value,value2,unit,recorded_at,source,measurement_condition
    FROM metrics WHERE user_id=? AND type=? ORDER BY recorded_at DESC,id DESC LIMIT 2000`).all(subject.id, request.metric) : [];
  return decideResearchCase({ events, question, request, asOf: new Date().toISOString() });
}

export function researchToolPlan(policy, intent, message, fallback) {
  if (!policy) return fallback;
  const { tools, metric, days, reason, task } = policy;
  if (!tools.length) return [];
  switch (tools[0]) {
    case 'check_data_quality':
      return [{ name: 'check_data_quality', args: { metric }, reason }];
    case 'get_metric_trend':
      return trends[metric]
        ? [{ name: 'health_trend', args: { metrics: trends[metric], days }, reason }]
        : [{ name: 'research_metric_history', args: { metric, days }, reason }];
    case 'get_health_summary':
      return metric ? [{ name: 'research_metric_history', args: { metric, days }, reason }] : [{ name: 'health_summary', args: {}, reason }];
    case 'schedule_followup':
      return [{ name: 'schedule_followup', args: { metric }, reason }];
    case 'create_plan_draft':
      return [{ name: 'propose_intervention', args: { message: message.slice(0, 500) }, reason }];
    case 'screen_risk':
      return [{ name: intent.diseaseRiskHit ? 'disease_risk' : 'htn_risk',
        args: intent.diseaseRiskHit ? { disease: intent.disease } : {}, reason }];
    default:
      return task === 'knowledge' ? fallback : [];
  }
}

export function researchMetricHistory(policy, args, latest) {
  const ids = policy?.quality?.evidence_ids || [];
  if (!ids.length || policy.metric !== args.metric) return { success: false, reason_code: 'RESEARCH_EVIDENCE_UNAVAILABLE' };
  const rows = db.prepare(`SELECT id,value,value2,unit,recorded_at,source FROM metrics
    WHERE user_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY recorded_at,id`)
    .all(policy.subjectId, JSON.stringify(ids));
  if (!rows.length) return { success: false, reason_code: 'RESEARCH_EVIDENCE_UNAVAILABLE' };
  return { success: true, metric: args.metric, count: rows.length,
    latest: rows.at(-1), ...(latest ? {} : { first: rows[0], change: Number((rows.at(-1).value - rows[0].value).toFixed(2)) }) };
}

export function researchReply(policy, results, label) {
  if (!policy) return null;
  const force = safeResearchReply(policy);
  const base = { plan: [], source: 'quality_policy',
    confidence: { type: 'common_sense', sources: ['研究质量门控'], reasoning: policy.quality?.reasons.join('；') || policy.reason } };
  if (force) return { ...base, content: force };
  const quality = results.find(row => row.name === 'check_data_quality' && row.status === 'success')?.result?.quality;
  if (quality) return { ...base, content: label + '记录的质量评分为 ' + quality.score + '。' +
    (quality.reasons.length ? quality.reasons.join('；') + '。' : '在本规则下暂未发现所检查的问题。') + ' 分数用于判断当前数据能否支持任务。' };
  const history = results.find(row => row.name === 'research_metric_history' && row.status === 'success')?.result;
  if (history) {
    const format = row => row.value + (row.value2 == null ? '' : '/' + row.value2) + ' ' + row.unit;
    return { ...base, confidence: { ...base.confidence, type: 'data' }, content: '最近的' + label + '记录为 ' + format(history.latest) +
      (history.first ? '，所选时段最早一条为 ' + format(history.first) + '。' : '。') };
  }
  const preview = results.find(row => row.name === 'schedule_followup' && row.status === 'success')?.result?.preview;
  if (preview) return { ...base, content: '已准备' + label + '复测预览。请选择时间并确认。', plan: [preview] };
  return null;
}

export function researchPresentation(policy, existing, response) {
  if (!policy) return existing;
  const { decision, reason, quality, version } = policy;
  const assessment = quality ? { ...quality, evidence_ids: undefined } : null;
  return { ...existing, ...(decision === 'answer' ? {} : {
    mode: decision === 'escalate' ? 'emergency' : 'health_card',
    status: { title: decision === 'ask' ? '需要您核对信息' : decision === 'measure' ? '需要补充测量' : '安全提示',
      text: response.content, tone: decision === 'escalate' ? 'urgent' : 'insufficient' },
    facts: [], actions: [],
    ...(decision === 'escalate' ? { safety: { level: 'urgent', text: response.content } } : {}),
  }), research_v2: { version, decision, reason, quality: assessment } };
}
