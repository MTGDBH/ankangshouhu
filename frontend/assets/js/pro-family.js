(function () {
  'use strict';

  const P = window.Pro;
  const V = window.ProVoiceSummary;
  const $ = id => document.getElementById(id);
  const metricNames = { bp: '血压', glucose: '血糖', hr: '心率', spo2: '血氧', weight: '体重', sleep: '睡眠', steps: '步数' };
  const sourceNames = { self_report: '本人记录', caregiver_report: '家属代录', device: '设备记录', system: '系统记录', imported: '导入记录' };
  const planStatus = { active: '执行中', evaluating: '等待评价' };
  const intakeSource = { self: '本人填写', caregiver: '家属代填', doctor: '医生录入' };
  const viewButtons = [...document.querySelectorAll('[data-family-view]')];
  let selected = null;
  let subjects = [];
  let currentView = 'overview';
  let loading = false;
  let dialogAction = null;
  let dialogSaving = false;
  let intakeReceipt = null;
  let voiceAudio = null;
  let voiceRequest = null;
  let voiceUrl = null;
  const measurements = window.HealthRecords.connect(null, {
    api: P, getSubject: () => selected?.senior,
    onSaved: row => status(row.duplicate ? '这次测量已记录。' : '测量已保存 · 来源 家属代录'),
  });

  function status(message, failed = false) {
    $('family-status').textContent = message;
    $('family-status').classList.toggle('is-error', failed);
  }

  function setVoiceLabel(label, pressed = false) {
    $('familyVoiceLabel').textContent = label;
    $('familyVoiceActionBtn').setAttribute('aria-pressed', String(pressed));
  }

  function stopVoice() {
    voiceRequest?.abort();
    voiceRequest = null;
    if (voiceAudio) {
      voiceAudio.pause();
      voiceAudio.src = '';
      voiceAudio = null;
    }
    if (voiceUrl) {
      URL.revokeObjectURL(voiceUrl);
      voiceUrl = null;
    }
    setVoiceLabel('朗读重点');
  }

  async function speakVoice() {
    if (voiceRequest || voiceAudio) return stopVoice();
    const answer = $('pro-family-chat')?.querySelector('.pro-family-answer:last-of-type')?.textContent || '';
    const excerpt = V.excerpt(V.summarizeFamily(currentView, selected, answer.replace(/^小康：/, '')));
    if (!excerpt) return status('当前页面没有可朗读内容。');
    const controller = new AbortController();
    voiceRequest = controller;
    setVoiceLabel('准备中', true);
    try {
      const saved = localStorage.getItem('pro-local-voice');
      const voice = ['zf_001', 'zf_002', 'zm_009'].includes(saved) ? saved : 'zf_001';
      const response = await fetch('/api/voice/speech', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: excerpt, voice }),
      });
      if (!response.ok) throw new Error('本机语音暂不可用，请稍后重试。');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      voiceUrl = URL.createObjectURL(blob);
      const audio = new Audio(voiceUrl);
      voiceAudio = audio;
      audio.onended = () => { if (voiceAudio === audio) stopVoice(); };
      audio.onerror = () => {
        if (voiceAudio === audio) {
          stopVoice();
          status('音频播放失败，请稍后重试。', true);
        }
      };
      await audio.play();
      if (voiceAudio === audio) setVoiceLabel('停止朗读', true);
    } catch {
      if (controller.signal.aborted) return;
      stopVoice();
      status('本机语音暂不可用，请稍后重试。', true);
    }
  }

  const link = (label, url, primary = false) => '<a class="health-button health-button-' + (primary ? 'primary' : 'secondary') + '" href="' + P.esc(url) + '">' + P.esc(label) + '</a>';
  const actionButton = (label, action) => '<button class="health-button health-button-secondary" type="button" data-pro-action="' + action + '">' + P.esc(label) + '</button>';
  const section = (title, body) => '<section class="health-panel"><h3>' + P.esc(title) + '</h3>' + body + '</section>';
  const grid = (...panels) => '<div class="family-grid">' + panels.join('') + '</div>';
  const note = message => '<p class="family-secondary">' + P.esc(message) + '</p>';
  const item = (title, description) => '<li><strong>' + P.esc(title) + '</strong><small>' + P.esc(description) + '</small></li>';

  function records(rows, allowed, empty, render) {
    if (!allowed) return note('当前授权不包含此项。');
    return rows?.length ? '<ul class="family-list">' + rows.map(render).join('') + '</ul>' : note(empty);
  }

  function switchView(view) {
    if (currentView !== view) stopVoice();
    currentView = view;
    viewButtons.forEach(button => {
      const key = button.dataset.familyView;
      $('view-' + key).hidden = key !== view;
      if (key === view) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    if (view === 'records') loadIntakeSource();
  }

  async function loadIntakeSource() {
    const host = $('family-intake-source');
    if (!host || !selected?.capabilities?.view_summary) return;
    host.textContent = '正在读取最近的问卷记录…';
    try {
      const result = await P.get('/api/prediction/intake/latest?subject_user_id=' + encodeURIComponent(selected.senior.id));
      const intake = result.intake;
      if (!host.isConnected) return;
      if (!intake) {
        host.textContent = '暂无已保存的问卷。';
        return;
      }
      const state = intake.status === 'completed' ? '已完成' : '填写中';
      host.textContent = '最近问卷 · ' + state + ' · ' + (intakeSource[intake.respondent_role] || '来源未标注') + ' · ' + P.date(intake.recorded_at);
    } catch {
      if (host.isConnected) host.textContent = '暂时无法读取问卷记录。请刷新后重试。';
    }
  }

  function render() {
    stopVoice();
    $('family-tools').hidden = !selected;
    $('family-empty').hidden = Boolean(selected);
    $('family-content').hidden = !selected;
    if (!selected) return;

    const { senior, authorization, capabilities: caps } = selected;
    const query = 'subject_user_id=' + encodeURIComponent(senior.id);
    const planLink = caps.view_interventions ? link('打开改善计划', '/intervention.html?' + query) : '';
    const trendLink = caps.view_trends ? link('查看完整趋势', '/prediction.html?tab=trend&desktop=1&' + query) : '';
    $('currentElderlyTitle').textContent = senior.name;
    $('currentStatusBadge').textContent = '授权有效至 ' + (authorization.expires_at ? P.date(authorization.expires_at) : '长期有效');
    $('family-scopes').innerHTML = authorization.scope_labels.map(label => '<li>' + P.esc(label) + '</li>').join('');
    $('family-quick-actions').innerHTML = [
      caps.record_intake ? actionButton('协助录入', 'intake') : '',
      caps.record_measurements ? actionButton('协助录入测量', 'measurement') : '',
      planLink, caps.remind_execution ? actionButton('发送执行提醒', 'remind') : '', trendLink,
    ].join('');
    const receipt = $('family-intake-receipt');
    receipt.hidden = intakeReceipt?.subject !== senior.id;
    receipt.textContent = receipt.hidden ? '' : '问卷已保存 · 来源 ' + intakeReceipt.source + ' · 记录编号 ' + intakeReceipt.id;

    const metrics = caps.view_summary
      ? selected.recent_health?.length
        ? '<div class="family-metrics">' + selected.recent_health.map(row => '<div><span>' + P.esc(metricNames[row.type] || row.type) + '</span><strong>' + P.esc(P.metric(row, row.type)) + '</strong><small>' + P.esc(P.date(row.recorded_at)) + '</small></div>').join('') + '</div>'
        : note('目前没有近期体征记录。')
      : note('当前授权不包含近期健康摘要。');
    const alertRows = records(selected.severe_alerts, caps.view_alerts, '没有待处理的严重预警。', row => item(row.title, P.date(row.created_at)));
    const retests = records(selected.overdue_retests, caps.view_retest, '目前没有到期的复测。', row => item((metricNames[row.metric_type] || row.metric_type) + '复测', '到期 ' + P.date(row.due_at)));
    const plans = records(selected.active_interventions, caps.view_interventions, '暂无进行中的改善计划。', row => item(row.title, planStatus[row.status] || '状态待核实'));
    const executions = records(selected.recent_execution, caps.view_adherence, '暂无执行记录。', row => item(row.title,
      (row.performed ? '已执行' : '未执行') + ' · ' + P.date(row.performed_at) + ' · ' + (sourceNames[row.data_source] || '来源未标注')));
    const distribution = caps.view_summary
      ? window.ProCharts.bars({ title: '近 30 天各指标记录次数', counts: selected.metric_counts_30d || [], total: selected.data_points_30d })
      : section('记录分布', note('当前授权不包含记录分布。'));

    $('view-overview').innerHTML = grid(section('近期测量', metrics), section('到期复测', retests), section('严重预警', alertRows), distribution);
    $('view-medication').innerHTML = grid(section('进行中的计划', plans + planLink), section('最近执行', executions));
    $('view-safety').innerHTML = grid(section('严重预警', alertRows), section('到期复测', retests));
    $('view-trends').innerHTML = grid(distribution, section('完整趋势', trendLink || note('当前授权不包含完整趋势。')));
    $('view-records').innerHTML = grid(section('近期测量', metrics), section('健康问卷',
      (caps.view_summary ? '<p id="family-intake-source" class="family-secondary" role="status"></p>' : note('当前授权不包含查看已保存的问卷。')) +
      (caps.record_intake ? actionButton('协助录入', 'intake') + link('打开完整问卷', '/prediction.html?tab=intake&' + query) : note('当前授权不包含代填问卷。'))));
    $('view-ai-agent').innerHTML = section('智能管家', caps.use_agent
      ? note('回答依据长辈已授权的数据。') + '<div id="pro-family-chat" class="family-chat-log" role="log" aria-live="polite"></div><form id="pro-family-chat-form" class="family-chat"><label>健康问题<input name="message" required maxlength="1000"></label><button class="health-button health-button-primary">发送</button></form>'
      : note('请长辈授予使用智能管家的权限。'));
    $('pro-family-chat-form')?.addEventListener('submit', sendQuestion);
    switchView(currentView);
  }

  async function sendQuestion(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const field = form.elements.message;
    const text = field.value.trim();
    if (!text || form.querySelector('button').disabled) return;
    const button = form.querySelector('button');
    const box = $('pro-family-chat');
    const subject = selected.senior.id;
    const question = document.createElement('p');
    question.textContent = '我：' + text;
    box.append(question);
    const answer = document.createElement('p');
    answer.textContent = '正在获取回复…';
    box.append(answer);
    button.disabled = true;
    try {
      const result = await P.post('/api/chat', { message: text, subject_user_id: subject });
      field.value = '';
      answer.className = 'pro-family-answer';
      answer.textContent = '小康：' + (result.content || '暂无回复');
      if (result.llm?.call_status === 'fallback') {
        const source = document.createElement('small');
        source.className = 'family-secondary';
        source.textContent = '模型暂不可用，使用本地结果。';
        answer.after(source);
      }
    } catch (error) {
      answer.textContent = error.message + '。请核对授权后重试。';
    } finally {
      button.disabled = false;
      box.scrollTop = box.scrollHeight;
    }
  }

  async function load(preferredId = selected?.senior.id, message = '') {
    if (loading) return;
    loading = true;
    $('family-content').hidden = true;
    $('family-empty').hidden = true;
    $('family-tools').hidden = true;
    status('正在读取照护授权…');
    try {
      const data = await P.get('/api/care/subjects');
      subjects = data.items || [];
      selected = subjects.find(card => card.senior.id === preferredId) || subjects[0] || null;
      $('family-subject').replaceChildren(...subjects.map(card => new Option(card.senior.name, card.senior.id)));
      if (selected) $('family-subject').value = selected.senior.id;
      render();
      status(message || (selected ? '已读取 ' + subjects.length + ' 位长辈的授权。' : ''));
    } catch (error) {
      stopVoice();
      if (error.status === 401) return location.replace('/login.html?next=%2Ffamily');
      status(error.message + '。请重新加载。', true);
      $('family-status').append(' ', actionButtonNode());
    } finally {
      loading = false;
    }
  }

  function actionButtonNode() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'health-button health-button-secondary';
    button.dataset.proAction = 'refresh';
    button.textContent = '重试';
    return button;
  }

  function openDialog(action) {
    const dialog = $('family-dialog');
    const titles = { bind: '接受照护授权', remind: '发送执行提醒', intake: '协助录入健康问卷' };
    const fields = {
      bind: '<p>请输入长辈提供的一次性授权码。权限和有效期由长辈设定。</p><label>授权码<input name="code" required autocomplete="one-time-code" pattern="[A-Fa-f0-9]{10}" maxlength="10"></label>',
      remind: '<label>提醒内容<textarea name="message" rows="3" required maxlength="200">请记得按计划完成今天的健康任务。</textarea></label>',
      intake: '<p>请根据长辈本人提供的信息填写。系统会保留代录人和录入角色。</p><label>自评健康<select name="health" required><option value="">请选择</option><option value="5">很好</option><option value="4">较好</option><option value="3">一般</option><option value="2">较差</option><option value="1">很差</option></select></label><label>近一年是否跌倒<select name="fall" required><option value="">请选择</option><option value="0">否</option><option value="1">是</option></select></label><label class="family-check"><input name="confirmed" type="checkbox" required>我确认这是长辈本人提供的信息</label>',
    };
    if (loading || dialog.open) return;
    dialogAction = { action, subject: selected?.senior.id };
    $('family-dialog-title').textContent = titles[action] + (action !== 'bind' ? ' · ' + selected.senior.name : '');
    $('family-dialog-fields').innerHTML = fields[action];
    $('family-dialog-error').hidden = true;
    dialog.showModal();
  }

  async function saveDialog(event) {
    event.preventDefault();
    if (dialogSaving || !dialogAction) return;
    const { action, subject } = dialogAction;
    const values = new FormData(event.currentTarget);
    const submit = $('family-dialog-submit');
    dialogSaving = true;
    submit.disabled = true;
    $('family-dialog-error').hidden = true;
    try {
      if (action === 'bind') {
        const data = await P.post('/api/care/accept', { code: values.get('code').trim() });
        $('family-dialog').close();
        await load(data.senior_id, '授权已接受。');
      } else if (action === 'remind') {
        await P.post('/api/care/seniors/' + subject + '/reminders', { message: values.get('message').trim() });
        $('family-dialog').close();
        status('提醒已写入长辈通知。');
      } else {
        const data = await P.post('/api/prediction/intakes', { subject_user_id: subject, answers: {
          self_rated_health: Number(values.get('health')), fall_recent: Number(values.get('fall')),
        } });
        intakeReceipt = { subject, source: data.respondent_role === 'caregiver' ? '家属代填' : '协助录入', id: data.intake_id };
        $('family-dialog').close();
        render();
        $('family-quick-actions').querySelector('[data-pro-action="intake"]')?.focus();
      }
    } catch (error) {
      $('family-dialog-error').textContent = error.message + '。请核对后重试。';
      $('family-dialog-error').hidden = false;
    } finally {
      submit.disabled = false;
      dialogSaving = false;
    }
  }

  $('family-subject').addEventListener('change', event => load(Number(event.target.value)));
  $('familyVoiceActionBtn').addEventListener('click', speakVoice);
  $('family-dialog-form').addEventListener('submit', saveDialog);
  $('family-dialog').addEventListener('cancel', event => { if (dialogSaving) event.preventDefault(); });
  viewButtons.forEach(button => button.addEventListener('click', () => switchView(button.dataset.familyView)));
  document.addEventListener('click', async event => {
    const action = event.target.closest('[data-pro-action]')?.dataset.proAction;
    if (['bind', 'remind', 'intake'].includes(action)) openDialog(action);
    if (action === 'measurement' && selected?.capabilities.record_measurements) measurements.open();
    if (action === 'refresh') load();
    if (action === 'close' && !dialogSaving) $('family-dialog').close();
    if (action === 'logout') {
      try {
        await P.post('/api/auth/logout', {});
        location.replace('/login.html?next=%2Ffamily');
      } catch (error) { status(error.message, true); }
    }
  });

  async function init() {
    try {
      const user = await P.get('/api/auth/me');
      if (user.role === 'senior') return location.replace('/mobile');
      if (!['caregiver', 'doctor'].includes(user.role)) throw new Error('此页面供家属和医生使用。');
      $('family-account').textContent = user.name + (user.role === 'doctor' ? ' · 医生' : ' · 家属');
      await load();
    } catch (error) {
      if (error.status === 401) return location.replace('/login.html?next=%2Ffamily');
      status(error.message, true);
    }
  }

  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  init();
})();
