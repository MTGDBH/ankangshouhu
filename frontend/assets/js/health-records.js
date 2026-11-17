(function () {
  'use strict';

  const priority = ['bp', 'glucose', 'hr', 'spo2', 'sleep', 'weight', 'steps'];
  const conditions = {
    morning_rest: '早晨静坐后', evening_rest: '晚间静坐后', fasting: '空腹',
    postprandial_2h: '餐后 2 小时', random: '随机测量', resting: '静息', active: '活动后',
    morning_fasting: '晨起空腹', other: '其他条件', unknown: '未注明',
  };
  const optionsByType = {
    bp: ['morning_rest', 'evening_rest', 'other'],
    glucose: ['fasting', 'postprandial_2h', 'random'],
    hr: ['resting', 'active'],
    weight: ['morning_fasting', 'other'],
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const date = value => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', {
      year:'numeric', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit',
    }) : '时间未标注';
  };
  const source = value => window.HealthOverview.sources[value] || '来源未标注';
  const condition = value => conditions[value] || '未注明';
  const valueText = row => row.value2 == null ? String(row.value) : row.value + '/' + row.value2;

  function recordDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'health-record-dialog';
    dialog.setAttribute('aria-labelledby', 'record-form-title');
    dialog.innerHTML = `<form id="record-form">
      <header class="health-panel-heading"><h2 id="record-form-title">记录健康数据</h2><button type="button" class="health-link" data-close-record>关闭</button></header>
      <div class="health-form-grid">
        <label>选择指标<select name="type" required></select></label>
        <label>测量时间<input type="datetime-local" name="time" required></label>
        <label><span data-value-label>测量数值</span><input type="number" name="value" inputmode="decimal" step="any" required></label>
        <label data-second-value hidden>舒张压（mmHg）<input type="number" name="value2" inputmode="decimal" min="30" max="180" step="any"></label>
        <label>测量条件<select name="condition"></select></label>
      </div>
      <p class="health-meta" data-record-source>来源：手工记录</p>
      <p role="status" class="health-record-status" data-form-status></p>
      <button type="submit" class="health-button health-button-primary">保存记录</button>
    </form>`;
    document.body.append(dialog);
    return dialog;
  }

  function connect(workspace, { api, initialType = 'bp', getDraft = () => null, getSubject = () => null, onSaved, onChanged } = {}) {
    const dialog = recordDialog();
    const form = dialog.querySelector('form');
    const fields = form.elements;
    const submit = form.querySelector('[type=submit]');
    const formStatus = form.querySelector('[data-form-status]');
    const status = workspace?.querySelector('[data-history-status]');
    const charts = workspace?.querySelector('[data-history-charts]');
    const history = workspace?.querySelector('[data-history-rows]');
    const chooser = workspace?.querySelector('[data-history-metric]');
    const period = workspace?.querySelector('[data-history-period]');
    const recordButton = workspace?.querySelector('[data-history-record]');
    let definitions = null;
    let opener = null;
    let requestVersion = 0;
    let type = initialType;
    let saving = false;
    let editing = null;
    let subject = null;
    let openVersion = 0;
    let renderedRows = [];

    async function loadDefinitions() {
      definitions ??= api.get('/api/health/metric-defs').then(rows => {
        const preferred = priority.flatMap(key => rows.filter(row => row.type === key));
        return preferred.concat(rows.filter(row => !priority.includes(row.type)));
      }).catch(error => { definitions = null; throw error; });
      return definitions;
    }

    function addOptions(select, rows) {
      select.replaceChildren(...rows.map(row => new Option(row.name, row.type)));
    }

    function updateForm(definition, draft) {
      const { type, unit, min_value: min, max_value: max, value_type: valueType } = definition;
      form.querySelector('[data-value-label]').textContent =
        (type === 'bp' ? '收缩压（高压）' : '测量数值') + (unit ? ' · ' + unit : '');
      fields.value.min = min ?? '';
      fields.value.max = max ?? '';
      fields.value.value = draft?.value ?? '';
      fields.value2.value = draft?.value2 ?? '';
      fields.value2.required = valueType === 'dual';
      fields.value2.disabled = valueType !== 'dual';
      form.querySelector('[data-second-value]').hidden = fields.value2.disabled;
      fields.condition.replaceChildren(...['unknown', ...(optionsByType[type] || ['other'])]
        .map(value => new Option(conditions[value], value)));
      fields.condition.value = [...fields.condition.options].some(option => option.value === draft?.measurement_condition)
        ? draft.measurement_condition : 'unknown';
    }

    async function open(selected = type, trigger = document.activeElement, original = null) {
      if (dialog.open) return;
      opener = trigger;
      const version = ++openVersion;
      editing = original;
      subject = getSubject();
      form.reset();
      dialog.querySelector('#record-form-title').textContent = editing
        ? '修改健康记录' : subject ? '为' + subject.name + '代录测量' : '记录健康数据';
      form.querySelector('[data-record-source]').textContent = '来源：' + (editing ? source(editing.source) : subject ? '家属代录' : '手工记录');
      formStatus.textContent = '正在读取指标选项…';
      submit.disabled = true;
      fields.type.disabled = true;
      dialog.showModal();
      try {
        const rows = await loadDefinitions();
        if (!dialog.open || version !== openVersion) return;
        addOptions(fields.type, rows);
        const definition = rows.find(row => row.type === selected) || rows[0];
        if (!definition) throw new Error('no definitions');
        fields.type.value = definition.type;
        const measured = editing ? new Date(editing.recorded_at) : new Date();
        fields.time.value = new Date(measured.getTime() - measured.getTimezoneOffset() * 60000).toISOString().slice(0,16);
        fields.time.dataset.prefilled = fields.time.value;
        updateForm(definition, editing || getDraft(definition.type));
        fields.type.disabled = Boolean(editing);
        submit.disabled = false;
        formStatus.textContent = '';
        fields.value.focus();
      } catch {
        formStatus.textContent = '指标选项暂时无法读取。关闭后可重新打开。';
      }
    }

    function renderHistory(rows, definition) {
      const ordered = [...rows].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
      renderedRows = ordered;
      status.textContent = rows.length ? `共 ${rows.length} 条实测记录，按时间排序。` : '这个时间范围内暂无记录。';
      if (!rows.length) { charts.replaceChildren(); history.replaceChildren(); return; }
      const groups = new Map();
      for (const row of rows) {
        const label = ['glucose', 'hr'].includes(definition.type) ? condition(row.measurement_condition) : '';
        const unit = row.unit || '';
        const key = JSON.stringify([label, unit]);
        if (!groups.has(key)) groups.set(key, { label, unit, points:[] });
        groups.get(key).points.push(row);
      }
      const dual = definition.value_type === 'dual';
      const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits:2 });
      charts.innerHTML = [...groups.values()].map(({ label, unit, points }) => {
        const values = points.filter(row => row.value != null).map(row => Number(row.value)).filter(Number.isFinite);
        const stats = values.length ? (dual ? '收缩压' : '') + '均值 ' +
          format.format(values.reduce((sum, value) => sum + value, 0) / values.length) +
          '，最高 ' + format.format(Math.max(...values)) + (unit ? ' ' + unit : '') + '。' : '';
        return window.ProCharts.line({
          title: [definition.name, label, unit === definition.unit ? '' : unit || '单位未标注'].filter(Boolean).join(' · '),
          unit, points, secondary: dual,
          note: stats + '横轴为测量时间，连线用于辅助阅读。',
        });
      }).join('');
      history.innerHTML = `<details class="health-history-list" open><summary>查看实测明细</summary><ul>
        ${ordered.map(row => `<li>
          <div><strong>${escape(valueText(row))} ${escape(row.unit || '')}</strong><small>${escape(date(row.recorded_at))}${row.unit ? '' : ' · 单位未标注'}</small></div>
          <div><span>${escape(source(row.source))}</span><small>条件：${escape(condition(row.measurement_condition))}</small></div>
          <div class="health-history-actions"><button class="health-link" type="button" data-edit-id="${Number(row.id)}">修改</button>
          <button class="health-link" type="button" data-delete-id="${Number(row.id)}">删除</button></div>
        </li>`).join('')}
      </ul></details>`;
    }

    async function refresh() {
      if (!workspace) return;
      const version = ++requestVersion;
      status.textContent = '正在读取实测记录…';
      charts.replaceChildren();
      history.replaceChildren();
      try {
        const rows = await loadDefinitions();
        if (version !== requestVersion) return;
        const definition = rows.find(item => item.type === type) || rows[0];
        if (!definition) throw new Error('no definitions');
        if (!chooser.options.length) addOptions(chooser, rows);
        type = chooser.value = definition.type;
        chooser.disabled = recordButton.disabled = false;
        const result = await api.get(`/api/health/metrics/${encodeURIComponent(type)}/history?days=${period.value}`);
        if (version !== requestVersion) return;
        renderHistory(result.points || [], definition);
      } catch {
        if (version !== requestVersion) return;
        status.textContent = '实测记录暂时无法读取。';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'health-link';
        retry.textContent = '重试';
        retry.addEventListener('click', refresh, { once:true });
        status.append(' ', retry);
      }
    }

    chooser?.addEventListener('change', () => {
      type = chooser.value;
      onChanged?.(type);
      refresh();
    });
    period?.addEventListener('change', refresh);
    recordButton?.addEventListener('click', () => open());
    history?.addEventListener('click', async event => {
      const button = event.target.closest('[data-edit-id], [data-delete-id]');
      const row = button && renderedRows.find(item => item.id === Number(button.dataset.editId || button.dataset.deleteId));
      if (!row || saving) return;
      if (button.dataset.editId) {
        await open(row.type, button, row);
        return;
      }
      if (!window.confirm('确定删除 ' + date(row.recorded_at) + ' 的这条健康测量吗？')) return;
      saving = button.disabled = true;
      try {
        await api.delete('/api/health/metrics/' + row.id, { body: { revision: row.revision } });
        await Promise.allSettled([refresh(), onSaved?.({ deleted: true }, { type: row.type })]);
        status.textContent = '测量已删除。';
        recordButton.focus();
      } catch (error) {
        status.textContent = error.message || '删除失败，请刷新后重试。';
      } finally {
        saving = button.disabled = false;
      }
    });
    dialog.querySelector('[data-close-record]').addEventListener('click', () => { if (!saving) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
    fields.type.addEventListener('change', async () => {
      const rows = await loadDefinitions();
      updateForm(rows.find(row => row.type === fields.type.value), getDraft(fields.type.value));
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      const time = new Date(fields.time.value);
      if (!Number.isFinite(time.getTime()) || time.getTime() > Date.now() + 60000) {
        formStatus.textContent = '请选择有效且不晚于当前的测量时间。';
        fields.time.focus();
        return;
      }
      saving = submit.disabled = true;
      formStatus.textContent = '正在保存…';
      const rows = await loadDefinitions();
      const definition = rows.find(row => row.type === fields.type.value);
      const draft = editing ? null : getDraft(definition.type);
      try {
        const payload = {
          type: definition.type, unit: definition.unit || null, source: 'manual',
          value: fields.value.valueAsNumber,
          value2: fields.value2.disabled ? null : fields.value2.valueAsNumber,
          recorded_at: editing && fields.time.value === fields.time.dataset.prefilled ? editing.recorded_at : time.toISOString(),
          measurement_condition: editing && fields.condition.value === 'unknown' && !optionsByType[definition.type]?.includes(editing.measurement_condition)
            ? editing.measurement_condition : fields.condition.value,
          note: draft ? '由健康数据描述核对后录入' : undefined,
          measurement_context: draft ? { entry_mode:'text_review', parser_version:'health_text_v1', user_confirmed:true } : undefined,
        };
        const row = editing
          ? await api.patch('/api/health/metrics/' + editing.id, {
            revision: editing.revision, value: payload.value, value2: payload.value2, unit: payload.unit,
            recorded_at: payload.recorded_at, measurement_condition: payload.measurement_condition,
          })
          : await api.post('/api/health/metrics', { ...payload, subject_user_id: subject?.id });
        if (chooser) {
          type = chooser.value = definition.type;
          onChanged?.(type);
        }
        dialog.close();
        await Promise.allSettled([refresh(), onSaved?.(row, definition)]);
        if (status) status.textContent = row.duplicate ? '这次测量已记录。' : '测量已保存。';
        recordButton?.focus();
      } catch (error) {
        const invalid = ['invalid measurement', 'unsupported metric or invalid value'].includes(error.message);
        formStatus.textContent = invalid ? '请核对指标、数值、单位和测量时间。'
          : error.message || '保存失败，请检查数值和测量时间后重试。';
      } finally {
        saving = submit.disabled = false;
      }
    });

    return { open, refresh, loadDefinitions };
  }

  function workspaceMarkup() {
    return `<section class="health-panel health-history-panel" aria-label="历史测量与趋势">
      <header class="health-panel-heading"><h2>历史测量与趋势</h2>
        <button type="button" class="health-button health-button-primary" data-history-record disabled>记录数据</button></header>
      <div class="health-history-controls">
        <label>指标<select data-history-metric disabled></select></label>
        <label>时间范围<select data-history-period><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="365">近一年</option></select></label>
      </div>
      <p class="health-record-status" data-history-status role="status">正在读取实测记录…</p>
      <div class="health-history-charts" data-history-charts></div>
      <div data-history-rows></div>
    </section>`;
  }

  window.HealthRecords = { connect, workspaceMarkup, date, source, condition, valueText };
})();
