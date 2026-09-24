// Short, page-specific scripts for local speech. Keep controls and secrets out of narration.
(function (root) {
  'use strict';
  const MAX_CHARS = 180;
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function excerpt(value, limit = MAX_CHARS) {
    const chars = Array.from(clean(value));
    if (chars.length <= limit) return chars.join('');
    const short = chars.slice(0, limit);
    let boundary = -1;
    for (let i = 0; i < short.length; i++) if (/[。！？；.!?]/.test(short[i])) boundary = i;
    if (boundary >= Math.floor(limit * 0.4)) return short.slice(0, boundary + 1).join('');
    return short.slice(0, limit - 1).join('') + '。';
  }
  function recordedDate(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? `${date.getMonth() + 1}月${date.getDate()}日` : '';
  }
  function metric(row, type) {
    if (!row || row.value == null || !Number.isFinite(Number(row.value))) return '';
    const day = recordedDate(row.recorded_at);
    const when = day ? `${day}的` : '';
    if (type === 'bp') {
      if (row.value2 == null || !Number.isFinite(Number(row.value2))) return '';
      return `${when}血压：收缩压${row.value}，舒张压${row.value2}毫米汞柱。`;
    }
    if (type === 'glucose') return `${when}血糖${row.value}毫摩尔每升。`;
    if (type === 'hr') return `${when}心率${row.value}次每分。`;
    return '';
  }
  function summarize(tab, state = {}) {
    const { summary = {}, metrics = {}, todos = [], alerts = [], answer = '', trends = null, user = {}, activeAuthorizations = null } = state;
    if (tab === 'overview') {
      const lead = excerpt(summary.summary || '最近暂无健康摘要。', 70);
      const readings = ['bp', 'glucose', 'hr'].map(type => metric(metrics[type], type)).filter(Boolean);
      return excerpt(`健康概览。${lead}${readings.length ? '最近记录：' + readings.join('') : '暂无测量记录。'}`);
    }
    if (tab === 'butler') {
      const latest = clean(answer);
      if (latest === '正在整理回答…') return '小康正在整理回答，请稍后再朗读。';
      return latest ? excerpt(`小康最近一次回答：${latest}`) : '还没有健康问题的回答。可以输入或说出问题。';
    }
    if (tab === 'meds') {
      const pending = todos.filter(item => !item.completed).slice(0, 2);
      const tasks = pending.map(item => `${clean(item.time) ? clean(item.time) + '，' : ''}${clean(item.title)}。`).join('');
      return excerpt(`今日计划。用药计划尚未接入。${tasks ? `待办：${tasks}` : todos.length ? '今天的待办已完成。' : '今天暂无待办。'}`);
    }
    if (tab === 'trends') {
      if (trends === null) return '趋势记录正在加载，请稍后再朗读。';
      const selected = ['bp', 'glucose', 'hr'].map(type => {
        const points = trends[type] || [];
        const latest = points.filter(row => row && row.value != null && Number.isFinite(Number(row.value)))
          .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))[0];
        const latestMetric = metric(latest, type);
        return latestMetric ? `${type === 'bp' ? '血压' : type === 'glucose' ? '血糖' : '心率'}有${points.length}次记录，最近一次${latestMetric}` : '';
      }).filter(Boolean);
      return selected.length ? excerpt(`最近九十天的测量趋势。${selected.join('')}`) : '最近九十天暂无血压、血糖或心率记录。';
    }
    if (tab === 'care') {
      if (!alerts.length) return '亲情守护。目前没有待处理提醒。';
      const selected = alerts.slice(0, 2).map(item => `${clean(item.title)}。${excerpt(item.message, 45)}`).join('');
      return excerpt(`亲情守护。有${alerts.length}条待处理提醒。${selected}`);
    }
    if (tab === 'profile') {
      const identity = clean(user.name) ? `${clean(user.name)}，` : '';
      return excerpt(`个人中心。${identity}可以调整字号和本机朗读音色，也可以管理账号安全与隐私。`);
    }
    if (tab === 'account') {
      const count = Number.isInteger(activeAuthorizations) ? `当前有${activeAuthorizations}人获得有效授权。` : '';
      return `账号安全与隐私管理。${count}可以修改密码、查看访问记录和导出个人数据。注销账号后数据无法恢复。`;
    }
    return '';
  }
  function summarizeFamily(view, card, answer = '') {
    if (!card) return '家属端尚未绑定长辈。请先取得长辈的授权码。';
    const name = clean(card.senior?.name) || '长辈';
    const metrics = card.recent_health || [];
    const alerts = card.severe_alerts || [];
    const retests = card.overdue_retests || [];
    const plans = card.active_interventions || [];
    const executions = card.recent_execution || [];
    const count = Number(card.data_points_30d) || 0;
    const latest = type => metrics.filter(row => row.type === type)
      .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))[0];
    const vital = ['bp', 'glucose', 'hr'].map(type => metric(latest(type), type)).filter(Boolean).slice(0, 2).join('');
    if (view === 'overview') {
      const alert = alerts.length ? `有${alerts.length}条严重预警，最近一条：${clean(alerts[0].title)}。` : '没有待处理的严重预警。';
      const retest = retests.length ? `另有${retests.length}项到期复测。` : '';
      return excerpt(`${name}的健康概览。${alert}${retest}最近三十天有${count}条测量记录。${vital}`);
    }
    if (view === 'ai-agent') {
      if (!card.capabilities?.use_agent) return `${name}尚未授权使用智能健康管家。`;
      return clean(answer) ? excerpt(`小康最近一次回答：${answer}`) : '智能健康管家还没有回答。可以输入健康问题。';
    }
    if (view === 'medication') {
      const plan = plans.length ? `目前有${plans.length}项进行中的改善计划，第一项是${clean(plans[0].title)}。` : '目前没有已授权的改善计划。';
      const pending = executions.filter(row => !row.performed);
      return excerpt(`${name}的改善计划与执行。${plan}${pending.length ? `最近有${pending.length}项执行记录标记为未执行。` : ''}`);
    }
    if (view === 'trends') return excerpt(`${name}最近三十天有${count}条测量记录。${vital || '暂无近期血压或血糖记录。'}`);
    if (view === 'safety') {
      const alert = alerts.length ? `有${alerts.length}条严重预警，最近一条：${clean(alerts[0].title)}。` : '没有待处理的严重预警。';
      const retest = retests.length ? `有${retests.length}项到期复测。` : '没有到期复测。';
      return excerpt(`${name}的提醒与复测。${alert}${retest}`);
    }
    if (view === 'records') return excerpt(`${name}的健康记录。最近三十天有${count}条测量记录。${vital || '暂无近期血压或血糖记录。'}`);
    return '';
  }
  const api = { excerpt, summarize, summarizeFamily };
  root.ProVoiceSummary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
