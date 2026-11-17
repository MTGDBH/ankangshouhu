export const POLICY_VERSION = 'research-quality.v2.1';
const DAY = 86400000;
const SPECS = {
  bp: { unit: 'mmHg', min: 50, max: 250, dual: true, difference: 18, jump: 42, condition: true },
  glucose: { unit: 'mmol/L', min: 1, max: 33, difference: 2, jump: 6, condition: true },
  hr: { unit: 'bpm', min: 20, max: 220, difference: 20, jump: 45, condition: true },
  spo2: { unit: '%', min: 50, max: 100, difference: 5, jump: 12 },
  sleep: { unit: 'h', min: 0, max: 24, difference: 3, jump: 7 },
  weight: { unit: 'kg', min: 20, max: 200, difference: 3, jump: 9 },
  steps: { unit: '步', min: 0, max: 100000, difference: 3000, jump: 12000 },
};

const SOURCE_SCORE = { device: 1, clinician: 1, manual: 0.75, caregiver_report: 0.6 };
const REASONS = {
  missing: '可用记录数量或不同测量日不足',
  stale: '最新记录早于本次任务的时效窗口',
  unknown_source: '部分记录缺少可核对的来源',
  noise: '记录超出录入范围或存在孤立的异常跳变',
  conflict: '近同时、同条件的记录之间有明显差异',
  unit_error: '存在与指标字典不一致或未标注的单位',
  mixed_conditions: '存在不能直接比较的测量条件',
  missing_condition: '缺少任务所需的测量条件',
  invalid_time: '记录时间无效或晚于评估时间',
};

const round = value => Math.round(value * 1000) / 1000;
const ratio = (n, d) => d ? round(n / d) : 0;
const number = value => typeof value === 'number' && Number.isFinite(value);
const knownCondition = condition => typeof condition === 'string' && !['', 'unknown', 'other', '未注明'].includes(condition);
const knownSource = value => Object.hasOwn(SOURCE_SCORE, value);
const metricPattern = {
  bp: /血压|高压|低压|收缩压|舒张压|blood pressure|\bbp\b/i,
  glucose: /血糖|glucose/i, hr: /心率|脉搏|pulse|heart rate/i, spo2: /血氧|oxygen|spo2/i,
  sleep: /睡眠|睡得|sleep/i, weight: /体重|weight/i, steps: /步数|走得少|走了多少步|step count|walking/i,
};

export function researchMetricTypes(question) {
  return Object.keys(metricPattern).filter(type => metricPattern[type].test(question));
}

export function inferResearchTask(question) {
  const metric = researchMetricTypes(question)[0] || null;
  const daysText = /(?:近|过去)?\s*(\d{1,3})\s*(?:天|days?)/i.exec(question)?.[1];
  const days = daysText ? Math.max(7, Math.min(365, Number(daysText))) : 30;
  let task = 'knowledge';
  if (/复测.{0,6}(?:安排|预约)|(?:安排|预约|约个).{0,10}复测|schedule|book.*recheck/i.test(question)) task = 'followup';
  else if (/草案|改善计划|制定.{0,15}方案|draft|management plan/i.test(question)) task = 'plan';
  else if (/风险|筛查|risk/i.test(question)) task = 'screen';
  else if (/数据质量|可靠|单位对不对|冲突|能不能用|可信|quality|trust these|inconsistent/i.test(question)) task = 'quality';
  else if (/趋势|变高|变低|变化|走势|上升|下降|trend|rising|falling/i.test(question)) task = 'trend';
  else if (/摘要|总结|概况|最近.{0,7}(?:怎么样|如何)|最近一次|summary|latest/i.test(question)) task = 'summary';
  else if (metric && /我|这些|本次|这几次|我的|my|these/i.test(question)) task = 'summary';
  return { task, metric, days };
}

function normalUnit(raw, metric) {
  const unit = String(raw ?? '').trim();
  if (metric === 'hr' && ['次/分', '次/分钟'].includes(unit)) return 'bpm';
  if (metric === 'sleep' && ['小时', 'hours'].includes(unit)) return 'h';
  if (metric === 'spo2' && unit === '％') return '%';
  if (metric === 'steps' && unit === 'steps') return '步';
  return unit;
}

function isValidValue(row, spec) {
  return number(row.value) && row.value >= spec.min && row.value <= spec.max &&
    (!spec.dual || (number(row.value2) && row.value2 >= 30 && row.value2 <= 180 && row.value >= row.value2));
}

const distinctDays = rows => new Set(rows.map(row => new Date(row.time).toISOString().slice(0, 10))).size;

function requirements(task, days) {
  if (task === 'trend') return { minimum: 3, maximumAge: Math.min(days, 14) };
  if (task === 'screen' || task === 'plan') return { minimum: 2, maximumAge: Math.min(days, 7) };
  return { minimum: 1, maximumAge: Math.min(days, 7) };
}

function findConflict(rows, spec) {
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    for (let j = i + 1; j < rows.length && rows[j].time - a.time < 10 * 60000; j++) {
      const b = rows[j];
      if (a.measurement_condition !== b.measurement_condition) continue;
      if (Math.abs(a.value - b.value) >= spec.difference || (spec.dual && Math.abs(a.value2 - b.value2) >= spec.difference)) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}

function findIsolatedNoise(rows, spec) {
  const ids = new Set();
  for (let i = 1; i < rows.length - 1; i++) {
    const [a, b, c] = rows.slice(i - 1, i + 2);
    if (a.measurement_condition !== b.measurement_condition || b.measurement_condition !== c.measurement_condition) continue;
    if (Math.abs(a.value - c.value) <= spec.difference && Math.abs(b.value - a.value) >= spec.jump && Math.abs(b.value - c.value) >= spec.jump) ids.add(b.id);
  }
  return ids;
}

export function assessQuality({ events, metric, task, days = 30, asOf, basic = false }) {
  const spec = SPECS[metric];
  const now = Date.parse(asOf);
  if (!spec || !Number.isFinite(now)) return null;
  const { minimum, maximumAge } = requirements(task, days);
  const typed = events.filter(row => row.type === metric).map(row => ({ ...row, time: Date.parse(row.recorded_at) }));
  const eligible = typed.filter(row => Number.isFinite(row.time) && row.time <= now).sort((a, b) => a.time - b.time);
  const recent = eligible.filter(row => now - row.time <= days * DAY);
  const age = eligible.length ? (now - eligible.at(-1).time) / DAY : null;
  const unitOK = recent.filter(row => normalUnit(row.unit, metric) === spec.unit);
  const valueOK = unitOK.filter(row => isValidValue(row, spec));
  const conflicts = basic ? new Set() : findConflict(valueOK, spec);
  const isolated = basic ? new Set() : findIsolatedNoise(valueOK, spec);
  const clean = basic ? recent : valueOK.filter(row => !conflicts.has(row.id) && !isolated.has(row.id));
  const comparable = spec.condition && task !== 'summary' && task !== 'quality';
  const conditions = new Set(valueOK.filter(row => knownCondition(row.measurement_condition)).map(row => row.measurement_condition));
  const selected = basic ? clean : clean.filter(row => knownSource(row.source) && (!comparable || knownCondition(row.measurement_condition)));
  const issues = [];
  if (!typed.length || (age != null && age <= maximumAge && distinctDays(recent) < minimum)) issues.push('missing');
  if (age != null && age > maximumAge) issues.push('stale');
  if (!basic) {
    if (typed.length > eligible.length) issues.push('invalid_time');
    if (recent.length > unitOK.length) issues.push('unit_error');
    if (unitOK.length > valueOK.length || isolated.size) issues.push('noise');
    if (conflicts.size) issues.push('conflict');
    if (recent.some(row => !knownSource(row.source))) issues.push('unknown_source');
    if (comparable && conditions.size > 1) issues.push('mixed_conditions');
    if (comparable && valueOK.some(row => !knownCondition(row.measurement_condition))) issues.push('missing_condition');
  }
  const features = {
    completeness: Math.min(1, ratio(distinctDays(recent), minimum)),
    freshness: age == null ? 0 : round(Math.max(0, 1 - age / (maximumAge * 2))),
    source_reliability: ratio(recent.reduce((sum, row) => sum + (knownSource(row.source) ? SOURCE_SCORE[row.source] : 0), 0), recent.length),
    consistency: ratio(clean.length, recent.length),
    condition_completeness: spec.condition ? ratio(recent.filter(row => knownCondition(row.measurement_condition)).length, recent.length) : (recent.length ? 1 : 0),
  };
  const score = Math.round(Object.values(features).reduce((sum, value) => sum + value, 0) * 20);
  const sufficientRows = distinctDays(selected) >= minimum;
  return {
    version: POLICY_VERSION, metric, task, days, features, score, grade: score >= 80 ? 'high' : score >= 55 ? 'limited' : 'low',
    issues, reasons: issues.map(issue => REASONS[issue]), age_days: age == null ? null : round(age),
    minimum_days: minimum, usable_days: distinctDays(selected), evidence_ids: selected.map(row => row.id),
    needs_data: Boolean(issues.length || !sufficientRows),
  };
}

export function researchRisk(question) {
  const clauses = String(question).split(/[。！？，；、.!?,;]/);
  for (const clause of clauses) {
    const acute = /胸痛|胸口.{0,6}(?:压住|压着|疼)|喘不上气|呼吸困难|一侧.{0,8}(?:抬不起来|无力)|说不清话|说话不清|意识模糊|晕过去|chest pain|cannot breathe|slurred speech|one.side weakness/i;
    const match = acute.exec(clause);
    if (match && !/(从未|没有|并无|不伴|无|否认|no |not |without |denies )[^，。！？.!?]{0,8}$/i.test(clause.slice(0, match.index))) return 'urgent';
  }
  if (/(?:停药|停掉.{0,6}药|加倍.{0,8}药|改药量|药量.{0,6}翻倍|加量|减量|换药|开处方|dosage|double.*dose|stop.*medication|prescri)/i.test(question)) return 'medication';
  return 'routine';
}

const TOOLS = {
  summary: 'get_health_summary', trend: 'get_metric_trend', quality: 'check_data_quality',
  screen: 'screen_risk', knowledge: 'retrieve_knowledge', plan: 'create_plan_draft', followup: 'schedule_followup',
};
export const RESEARCH_TOOLS = Object.values(TOOLS);

export function decideResearchCase(input, { quality = true, routing = true, evidence = true, risk = true, basic = false } = {}) {
  const { task, metric, days } = input.request || inferResearchTask(input.question);
  const danger = researchRisk(input.question);
  const assessment = quality && metric && task !== 'knowledge' ? assessQuality({ ...input, metric, task, days, basic }) : null;
  const allowed = new Set(input.candidates || RESEARCH_TOOLS);
  let decision = 'answer', reason = 'task_supported';
  if (risk && danger === 'urgent') [decision, reason] = ['escalate', 'urgent_symptoms'];
  else if (risk && danger === 'medication') [decision, reason] = ['limit', 'medication_boundary'];
  else if (evidence && !metric && ['trend','screen','followup','quality'].includes(task)) [decision, reason] = ['ask', 'metric_missing'];
  else if (evidence && assessment && task !== 'quality') {
    const issues = assessment.issues;
    if (issues.includes('conflict') || issues.includes('mixed_conditions')) [decision, reason] = ['ask', issues.includes('conflict') ? 'conflict' : 'mixed_conditions'];
    else if (issues.some(issue => ['noise','unit_error','invalid_time','missing','stale'].includes(issue))) [decision, reason] = ['measure', issues[0]];
    else if (issues.includes('unknown_source') || issues.includes('missing_condition')) [decision, reason] = ['ask', issues[0]];
    else if (assessment.usable_days < assessment.minimum_days) [decision, reason] = ['measure', 'insufficient_usable_days'];
  }
  const stopped = ['urgent_symptoms','medication_boundary','metric_missing'].includes(reason);
  const tool = stopped ? null : decision === 'answer' || !routing ? TOOLS[task] : 'check_data_quality';
  const tools = tool && allowed.has(tool) ? [tool] : [];
  if (tool && !tools.length && decision === 'answer') [decision, reason] = ['limit', 'tool_unavailable'];
  return { decision, reason, tools, quality: assessment, task, metric, days, danger, version: POLICY_VERSION };
}

export function safeResearchReply(result) {
  const texts = {
    escalate: '描述中有需要尽快处理的急症信号。请联系当地急救服务，避免等待线上评估。',
    limit: result.reason === 'medication_boundary' ? '药物或剂量调整需要开药医生或药师核对。请按原医嘱执行，并联系专业人员确认。' : '当前工具或证据不足，暂时无法判断。',
    ask: result.reason === 'metric_missing' ? '您想核对哪一项健康指标？' : result.reason === 'conflict' ? '这些记录不一致。您能核对对应的测量时间、设备和原始读数吗？'
      : result.reason === 'mixed_conditions' ? '这些记录的测量条件不同。您想比较哪一种测量条件？' : '能先确认测量条件或记录来源吗？',
    measure: '现有记录不足以回答这个问题。请核对单位并按相同条件补充近期测量。',
  };
  return texts[result.decision] || null;
}
