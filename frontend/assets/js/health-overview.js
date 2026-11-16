(function () {
  'use strict';

  const metrics = [
    ['bp', '血压', 'mmHg'], ['hr', '心率', '次/分'],
    ['glucose', '血糖', 'mmol/L'], ['weight', '体重', 'kg'],
  ];
  const severity = {
    critical: [3, '紧急'], warning: [2, '需关注'], info: [1, '提醒'],
  };
  const sources = { manual: '手工记录', device: '设备同步', synthetic: '演示数据', caregiver: '家属代填' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const date = value => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }) : '时间未标注';
  };
  const links = {
    measure: ['记录健康数据', 'monitoring.html'], agent: ['打开智能管家', 'agent.html'],
    metrics: ['全部记录', 'monitoring.html'], alerts: ['全部提醒', 'alerts.html'],
    tasks: ['查看改善计划', 'intervention.html'], assessment: ['查看评估依据', 'assessment.html'],
  };
  const mobileActions = { measure: 'measure', agent: 'butler', metrics: 'trends', alerts: 'care' };

  function link(key, mobile, style = 'health-link') {
    const [label, href] = links[key];
    const action = mobile && mobileActions[key];
    return action ? `<button type="button" class="${style}" data-pro-action="${action}">${label}</button>`
      : `<a class="${style}" href="${href}">${label}</a>`;
  }

  function panelState(section, detail) {
    return `<div class="health-panel-state"><p>${detail}</p><button type="button" class="health-link" data-home-retry="${section}">重试</button></div>`;
  }

  function assessment(summary, mobile) {
    if (!summary) return panelState('summary', '健康概况暂时无法读取。');
    const score = summary.total_score;
    const coverage = summary.scoring_details?.coverage_percent;
    const hasScore = score != null;
    return `<div class="health-score-row">
      <div class="health-score"><strong>${hasScore ? escape(score) : '—'}</strong>${hasScore ? '<span>/ 100</span>' : ''}</div>
      <div><strong>${hasScore ? '综合健康评分' : '暂无可评分记录'}</strong>${coverage != null ? `<p>数据覆盖率 ${escape(coverage)}%</p>` : ''}</div>
    </div>
    <p class="health-summary-text">${escape(hasScore ? summary.summary || '依据近期记录计算。' : '记录健康数据后，可查看综合评分和评估依据。')}</p>
    ${link('assessment', mobile)}`;
  }

  function reminders(alerts) {
    if (!alerts) return panelState('alerts', '提醒暂时无法读取。');
    const sorted = [...alerts].sort((a, b) => (severity[b.severity]?.[0] || 0) - (severity[a.severity]?.[0] || 0));
    if (!sorted.length) return '<p class="health-empty">暂无待处理提醒。</p>';
    return `<ul class="health-reminders">${sorted.slice(0, 3).map(item => {
      const [, label] = severity[item.severity] || severity.info;
      return `<li><span class="health-status ${item.severity === 'critical' ? 'is-urgent' : ''}">${label}</span><div><strong>${escape(item.title || '健康提醒')}</strong>${item.message ? `<p>${escape(item.message)}</p>` : ''}</div></li>`;
    }).join('')}</ul>`;
  }

  function readings(rows, mobile) {
    if (!rows) return panelState('metrics', '关键指标暂时无法读取。');
    return `<div class="health-vitals">${metrics.map(([type, name, fallbackUnit]) => {
      const row = rows[type];
      const value = row ? (row.value2 != null ? `${row.value}/${row.value2}` : row.value) : '暂无记录';
      return `<article class="health-vital"><h3>${name}</h3><p><strong>${escape(value)}</strong>${row ? ` <span>${escape(row.unit || fallbackUnit)}</span>` : ''}</p>
        <div class="health-meta">${row ? `${escape(date(row.recorded_at))} · ${escape(sources[row.source] || '来源未标注')}` : '等待首次测量'}</div>
        ${mobile ? '' : `<a class="health-link health-vital-link" href="metric.html?type=${type}" aria-label="查看${name}趋势">查看趋势</a>`}</article>`;
    }).join('')}</div>`;
  }

  function tasks(todos) {
    if (!todos) return panelState('todos', '今日任务暂时无法读取。');
    if (!todos.length) return '<p class="health-empty">今天暂无任务。</p>';
    const ordered = [...todos].sort((a, b) => Number(Boolean(a.completed)) - Number(Boolean(b.completed)));
    return `<details class="health-task-disclosure" open><summary>已完成 ${todos.filter(todo => todo.completed).length} / ${todos.length} 项</summary>
      <ul class="health-tasks">${ordered.map(todo => `<li><div><strong>${escape(todo.title)}</strong><p>${escape(todo.time || '时间未安排')} · ${todo.completed ? '已完成' : '待完成'}</p></div>
        <button type="button" class="health-button health-button-secondary" data-home-todo="${Number(todo.id)}" data-home-completed="${todo.completed ? '1' : '0'}" aria-label="${todo.completed ? '撤销完成' : '完成'}：${escape(todo.title)}">${todo.completed ? '撤销' : '完成'}</button></li>`).join('')}</ul></details>`;
  }

  function render(host, user, data, { mobile = false } = {}) {
    const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    host.innerHTML = `<header class="health-home-header">
      <div><p class="health-meta">${escape(today)}</p><h1>您好，<span id="${mobile ? 'mobile' : 'desktop'}-user-name">${escape(user.name || '欢迎回来')}</span></h1></div>
      <div class="health-home-actions">${link('measure', mobile, 'health-button health-button-primary')}${link('agent', mobile, 'health-button health-button-secondary')}</div>
    </header>
    <div class="health-home-top">
      <section class="health-panel health-summary-panel" aria-labelledby="health-summary-title"><h2 id="health-summary-title">今日健康概况</h2>${assessment(data.summary, mobile)}</section>
      <section class="health-panel" aria-labelledby="health-alerts-title"><header class="health-panel-heading"><h2 id="health-alerts-title">重要提醒</h2>${link('alerts', mobile)}</header>${reminders(data.alerts)}</section>
    </div>
    <section class="health-home-readings" aria-labelledby="health-vitals-title"><header class="health-panel-heading"><h2 id="health-vitals-title">关键指标</h2>${link('metrics', mobile)}</header>${readings(data.metrics, mobile)}</section>
    <section class="health-panel" aria-labelledby="health-tasks-title"><header class="health-panel-heading"><h2 id="health-tasks-title">今日行动</h2>${link('tasks', mobile)}</header>${tasks(data.todos)}</section>
    ${mobile ? '<div id="pro-overview-chart"></div>' : ''}`;
  }

  window.HealthOverview = { render, date, sources };
})();
