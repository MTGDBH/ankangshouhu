(function () {
  'use strict';

  const names = {
    hypertension:'高血压', diabetes:'糖尿病', heart_disease:'心脏病', stroke:'脑卒中',
  };
  const checks = {
    participant_disjoint:'受试者独立', auc:'区分能力', auc_ci:'置信区间',
    brier_skill:'整体预测误差', calibration_slope:'校准斜率', calibration_ece:'校准误差',
    subgroup_fairness:'亚组公平性', artifact_binding:'评估与模型版本绑定',
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const number = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);

  function diseaseCard(name, result) {
    const gate = result.gate_result;
    const available = result.status === 'available' && gate?.passed === true;
    const hasDiagnosis = result.existing_diagnosis === true;
    const noData = result.error === 'no_data' || result.status === 'insufficient_data';
    const limited = result.status === 'limited' || gate?.passed === false;
    const probability = available ? number(result.risk_percent) : null;
    const percentage = probability != null && probability >= 0 && probability <= 100 ? probability : null;
    const completeness = result.data_completeness || {};
    const ratio = number(completeness.ratio);
    const status = hasDiagnosis ? '已确诊，进入管理' : noData ? '资料不足' : limited ? '未达准入' : available ? '可筛查' : '暂不可用';
    const next = completeness.next_steps?.[0] || result.actions?.[0]?.label ||
      (noData ? '先记录健康测量。' : '可到健康档案核对资料。');
    const evidence = Object.entries(gate?.checks || {}).map(([key, passed]) =>
      '<li>' + escape(checks[key] || key) + ' · ' + (passed ? '通过' : '未通过') + '</li>').join('');
    const auc = number(gate?.metrics?.roc_auc);
    const ece = number(gate?.metrics?.ece);
    const metrics = [auc != null && 'AUROC ' + auc.toFixed(3), ece != null && 'ECE ' + ece.toFixed(3)].filter(Boolean);
    const description = hasDiagnosis ? '已有诊断记录，按日常管理查看。' :
      noData ? '还没有可用于筛查的测量。' :
      limited ? '模型未通过个人概率准入，个人风险暂不可显示。' :
      percentage != null ? '模型筛查结果' : '暂无可展示的筛查结论。';
    return `<article class="disease-discovery-card health-disease-card"><header class="health-panel-heading">
      <h3>${escape(name)}</h3><span class="health-status">${status}</span>
    </header><p>${description}</p>
    ${percentage == null ? '' : `<p><strong>${percentage.toFixed(1)}%</strong>${result.horizon_years ? ' · ' + escape(result.horizon_years) + ' 年窗口' : ''}</p>`}
    ${ratio == null ? '<p class="health-meta">资料完整度未提供</p>' :
      `<p class="health-meta">资料完整度 ${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%</p>`}
    <p class="health-risk-next"><strong>下一步</strong> ${escape(next)}</p>
    <details><summary>查看筛查依据</summary>
      <p>${escape(result.disclaimer || '筛查结果用于日常健康管理参考。')}</p>
      ${evidence ? '<ul>' + evidence + '</ul>' : '<p>暂无可展示的模型验证明细。</p>'}
      ${metrics.length ? '<p>时间验证：' + escape(metrics.join(' · ')) + '</p>' : ''}
    </details></article>`;
  }

  function cards(results = {}) {
    return Object.entries(names).map(([type, name]) => diseaseCard(name, results[type] || {})).join('');
  }

  function events(items = [], hasData = true) {
    if (!items.length) return '<p class="health-empty">' +
      (hasData ? '当前没有待处理的发现。' : '暂无测量可供分析。') + '</p>';
    const priority = { critical:3, warning:2, info:1 };
    return '<ul class="health-discovery-events">' + [...items].sort((a,b) => (priority[b.severity] || 0) - (priority[a.severity] || 0))
      .map(event => '<li><span class="health-status ' + (event.severity === 'critical' ? 'is-urgent' : '') + '">' +
        (event.severity === 'critical' ? '立即处理' : event.severity === 'warning' ? '需关注' : '提醒') +
        '</span><div><strong>' + escape(event.title) + '</strong><p>' + escape(event.message) +
        '</p><p>' + escape(event.action) + '</p></div></li>').join('') + '</ul>';
  }

  function summary(data) {
    const current = data.summary || {};
    const latest = data.data?.latest_measurement_at;
    return `<article><span>现在怎么样</span><strong>${escape(current.current || '暂无结论')}</strong>
      <p class="health-meta">最近测量：${escape(latest ? window.HealthOverview.date(latest) : '暂无')}</p></article>
      <article><span>资料概况</span><strong>${escape(current.change || '暂无可展示记录')}</strong>
      ${data.data?.metric_count == null ? '' : '<p class="health-meta">已记录 ' + escape(data.data.metric_count) + ' 类指标</p>'}</article>
      <article class="action"><span>下一步</span><strong>${escape(current.action || '先记录近期测量')}</strong></article>`;
  }

  window.HealthDiscovery = { cards, events, summary };
})();
