(function () {
  'use strict';
  const P = window.Pro;
  const VoiceSummary = window.ProVoiceSummary;
  const $ = id => document.getElementById(id);
  const panes = ['overview','butler','risk','trends','care','profile','account','knowledge'];
  const DISEASE_NAMES = { hypertension: '高血压', diabetes: '糖尿病', heart_disease: '冠心病', stroke: '脑卒中' };
  const GATE_LABELS = {
    participant_disjoint: '受试者不重叠', auc: 'AUC 达标', auc_ci: 'AUC 置信区间',
    brier_skill: 'Brier 技能分', calibration_slope: '校准斜率', calibration_ece: '校准误差',
    subgroup_fairness: '亚组公平性', artifact_binding: '产物绑定',
  };
  const RISK_STATUS = {
    existing_diagnosis: ['已确诊 · 进入管理', 'is-manage'],
    limited: ['证据有限', 'is-limited'],
    available: ['可评估', 'is-ok'],
    ok: ['可评估', 'is-ok'],
    insufficient_data: ['资料不足', 'is-limited'],
    unavailable: ['暂不可用', 'is-limited'],
  };
  const KNOWLEDGE_PROMPTS = ['老年人高血压饮食注意', '跌倒风险如何预防', '多重用药要注意什么', '认知下降早期信号'];
  const FOLLOWUP_STATUS = { scheduled: '待复测', pending: '待复测', pending_result_confirmation: '待确认结果', completed: '已完成', cancelled: '已取消', overdue: '已逾期' };
  const METRIC_NAMES = { bp: '血压', glucose: '血糖', hr: '心率', weight: '体重', sleep: '睡眠', steps: '步数', spo2: '血氧', waist: '腰围', grip: '握力' };
  let knowledgeQuery = null, riskLoading = false;
  const requestedTab = new URLSearchParams(location.search).get('view');
  let user = null, data = null, currentTab = panes.includes(requestedTab) ? requestedTab : 'overview';
  const voiceChoices = new Set(['zf_001', 'zf_002', 'zm_009']);
  let voiceAudio = null, voiceRequest = null, voiceUrl = null;
  let trendVoicePoints = null, activeAuthorizationCount = null;
  let micSession = null, micRequest = null, micStarting = false, micEpoch = 0, asrAvailable = null;
  function toast(message) { const node = $('toastContent'); if (node) { node.textContent = message; $('toastMessage')?.classList.remove('opacity-0','pointer-events-none'); setTimeout(() => $('toastMessage')?.classList.add('opacity-0','pointer-events-none'), 3000); } }
  function showError(error) { toast(error.message || '操作失败'); }
  function setVoiceLabel(label, pressed = false) {
    if ($('voiceLabel')) $('voiceLabel').textContent = label;
    $('voiceActionBtn')?.setAttribute('aria-pressed', String(pressed));
  }
  function stopReading() {
    voiceRequest?.abort(); voiceRequest = null;
    if (voiceAudio) { voiceAudio.pause(); voiceAudio.src = ''; voiceAudio = null; }
    if (voiceUrl) { URL.revokeObjectURL(voiceUrl); voiceUrl = null; }
    setVoiceLabel('朗读');
  }
  async function readText(text) {
    stopReading();
    const excerpt = VoiceSummary.excerpt(text);
    if (!excerpt) { toast('当前页面没有可朗读内容'); return; }
    const controller = new AbortController();
    voiceRequest = controller;
    setVoiceLabel('准备中', true);
    try {
      const selected = localStorage.getItem('pro-local-voice');
      const voice = voiceChoices.has(selected) ? selected : 'zf_001';
      const response = await fetch('/api/voice/speech', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: excerpt, voice }),
      });
      if (!response.ok) throw new Error('本机自然语音暂时不可用');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      voiceRequest = null;
      voiceUrl = URL.createObjectURL(blob);
      const audio = new Audio(voiceUrl);
      voiceAudio = audio;
      audio.onended = () => { if (voiceAudio === audio) stopReading(); };
      audio.onerror = () => { if (voiceAudio === audio) { stopReading(); toast('音频播放失败'); } };
      await audio.play();
      setVoiceLabel('停止', true);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn('[local-voice]', error.name, error.message);
      stopReading();
      toast('本机语音暂不可用，请稍后重试');
    }
  }
  function setMicState(label, message, pressed = false) {
    const button = $('pro-mic-button');
    if (button) {
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(pressed));
      button.innerHTML = `<i class="fa-solid ${pressed ? 'fa-stop' : 'fa-microphone'}" aria-hidden="true"></i>`;
      button.disabled = micStarting || !!micRequest || asrAvailable !== true;
    }
    if ($('pro-mic-status')) $('pro-mic-status').textContent = message;
  }
  function releaseMic(session) {
    clearTimeout(session.timer);
    session.processor.onaudioprocess = null;
    session.processor.disconnect();
    session.source.disconnect();
    session.stream.getTracks().forEach(track => track.stop());
    session.context.close().catch(() => {});
    if (micSession === session) micSession = null;
  }
  function cancelMic() {
    micEpoch++;
    if (micSession) releaseMic(micSession);
    micRequest?.abort(); micRequest = null;
    setMicState('开始语音输入', '点击麦克风开始说话，说完再点一次停止。');
  }
  function wavFromChunks(chunks, sampleRate) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const source = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length; }
    const count = Math.min(20 * 16000, Math.floor(total * 16000 / sampleRate));
    const buffer = new ArrayBuffer(44 + count * 2);
    const view = new DataView(buffer);
    const ascii = (position, value) => { for (let i = 0; i < value.length; i++) view.setUint8(position + i, value.charCodeAt(i)); };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * sampleRate / 16000);
      const end = Math.min(total, Math.max(start + 1, Math.floor((i + 1) * sampleRate / 16000)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += source[j];
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }
  async function finishMic() {
    const session = micSession;
    if (!session) return;
    releaseMic(session);
    const audio = wavFromChunks(session.chunks, session.context.sampleRate);
    if (audio.size < 6444) { setMicState('开始语音输入', '录音太短，请再试一次。'); return; }
    const controller = new AbortController();
    micRequest = controller;
    setMicState('识别中', '正在本机识别，请稍候。');
    try {
      const response = await fetch('/api/voice/transcribe', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'audio/wav' }, body: audio,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '语音识别失败');
      if (controller.signal.aborted) return;
      const input = $('pro-chat-form')?.elements.message;
      if (!input) return;
      input.value = [input.value.trim(), result.text].filter(Boolean).join(' ').slice(0, 1000);
      input.focus();
      setMicState('开始语音输入', '已填入识别文字，请核对后点发送。');
    } catch (error) {
      if (!controller.signal.aborted) setMicState('开始语音输入', error.message || '语音识别失败，请重试。');
    } finally {
      if (micRequest === controller) micRequest = null;
      setMicState('开始语音输入', $('pro-mic-status')?.textContent || '点击麦克风开始说话。');
    }
  }
  async function toggleMic() {
    if (micSession) { await finishMic(); return; }
    if (micStarting || micRequest) return;
    if (asrAvailable !== true) { setMicState('开始语音输入', '本机语音识别尚未就绪。'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setMicState('开始语音输入', '当前浏览器不支持麦克风录音。'); return;
    }
    micStarting = true;
    const epoch = micEpoch;
    setMicState('正在请求麦克风', '请允许浏览器使用麦克风。');
    let stream, context;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      context = new AudioContext();
      await context.resume();
      if (epoch !== micEpoch) {
        stream.getTracks().forEach(track => track.stop());
        await context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const session = { stream, context, source, processor, chunks: [], timer: null };
      processor.onaudioprocess = event => session.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(processor); processor.connect(context.destination);
      micSession = session;
      session.timer = setTimeout(() => finishMic(), 20_000);
      setMicState('停止录音并识别', '正在录音，最长 20 秒；说完点方形按钮。', true);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      context?.close().catch(() => {});
      setMicState('开始语音输入', error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器中允许后重试。' : '无法开始录音，请检查麦克风。');
    } finally {
      micStarting = false;
      setMicState(micSession ? '停止录音并识别' : '开始语音输入', $('pro-mic-status')?.textContent || '', !!micSession);
    }
  }
  async function checkMicAvailability() {
    try {
      const response = await fetch('/api/voice/input-status', { credentials: 'same-origin' });
      const status = response.ok ? await response.json() : null;
      asrAvailable = status?.available === true;
    } catch { asrAvailable = false; }
    if (!micSession && !micRequest) {
      setMicState('开始语音输入', asrAvailable
        ? '点击麦克风开始说话，说完再点一次停止。识别文字会填入输入框。'
        : '本机语音识别未安装，请先运行安装脚本。');
    }
  }
  function renderAccount() {
    $('tab-account').innerHTML = `<div class="pt-1">${P.btn('← 返回个人中心','profile',true)}</div>`
      + P.card('账号安全', `<p class="text-sm text-zinc-500 mb-3">当前账号：${P.esc(user.name)}</p><details class="rounded-xl bg-white/70 p-3"><summary class="font-bold cursor-pointer">修改登录密码</summary><form id="pro-password-form" class="space-y-3 mt-4"><label class="block text-sm font-bold">当前密码<input name="old_password" type="password" autocomplete="current-password" required class="w-full mt-2 rounded-xl border border-zinc-200 bg-white p-3"></label><label class="block text-sm font-bold">新密码<input name="new_password" type="password" autocomplete="new-password" minlength="6" required class="w-full mt-2 rounded-xl border border-zinc-200 bg-white p-3"></label><label class="block text-sm font-bold">再次输入新密码<input name="confirm_password" type="password" autocomplete="new-password" minlength="6" required class="w-full mt-2 rounded-xl border border-zinc-200 bg-white p-3"></label><button class="rounded-xl bg-zinc-900 text-white px-4 py-3 font-bold" type="submit">保存新密码</button><p id="pro-password-status" class="text-sm" role="status"></p></form></details>`)
      + P.card('隐私管理', `<p class="text-sm text-zinc-500 mb-3">查看授权、访问记录，或导出自己的数据。</p><div id="pro-privacy-content" class="text-sm text-zinc-500">正在读取隐私信息…</div><div class="mt-4">${P.btn('导出我的数据','account-export',true)}</div><p id="pro-export-status" class="text-sm text-zinc-500 mt-2" role="status"></p><details class="mt-4 rounded-xl bg-white/70 p-3"><summary class="font-bold cursor-pointer text-red-700">注销账号</summary><p class="text-sm text-zinc-600 mt-3 mb-3">账号和健康记录删除后无法恢复。操作前会显示删除范围，并再次验证密码。</p>${P.btn('查看删除范围','account-delete-start',true)}<div id="pro-delete-area" class="mt-3"></div></details>`);
    $('pro-password-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const status = $('pro-password-status');
      const oldPassword = form.elements.old_password.value;
      const newPassword = form.elements.new_password.value;
      if (newPassword !== form.elements.confirm_password.value) { status.textContent = '两次输入的新密码不一致'; return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      status.textContent = '正在保存…';
      try {
        const result = await P.post('/api/profile/password', { old_password: oldPassword, new_password: newPassword });
        form.reset();
        status.textContent = result.message || '密码已更新';
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  async function loadAccountPrivacy() {
    const box = $('pro-privacy-content');
    if (!box) return;
    activeAuthorizationCount = null;
    box.textContent = '正在读取隐私信息…';
    try {
      const [authorizationResult, accessResult] = await Promise.all([
        P.get('/api/privacy/authorizations'),
        P.get('/api/privacy/access-records?limit=5'),
      ]);
      if (!box.isConnected) return;
      const active = (authorizationResult.items || []).filter(item => item.status === 'active');
      activeAuthorizationCount = active.length;
      const access = accessResult.items || [];
      box.innerHTML = `<p class="rounded-xl bg-white/70 p-3 text-zinc-700">当前有效授权：<strong>${active.length} 人</strong></p>`
        + `<details class="rounded-xl bg-white/70 p-3 mt-2"><summary class="font-bold cursor-pointer">家属与医生授权（${active.length}）</summary><div class="mt-3 space-y-3">${active.length ? active.map(item => `<div class="border-t border-zinc-100 pt-3"><strong>${P.esc(item.recipient_name || '授权成员')}</strong><p class="text-zinc-500">${P.esc(item.member_role === 'doctor' ? '医生' : '家属')} · ${P.esc((item.scopes || []).join('、') || '未设置范围')}</p><button type="button" class="text-red-700 font-bold mt-2" data-pro-action="account-revoke:${Number(item.id)}">撤回授权</button></div>`).join('') : '<p>目前没有有效授权。</p>'}</div></details>`
        + `<details class="rounded-xl bg-white/70 p-3 mt-2"><summary class="font-bold cursor-pointer">最近访问记录</summary><div class="mt-3 space-y-2">${access.length ? access.map(item => `<div class="border-t border-zinc-100 pt-2"><strong>${P.esc(item.actor_name || item.action || item.event_type || '系统事件')}</strong><p class="text-zinc-500">${P.esc(P.date(item.created_at))}</p></div>`).join('') : '<p>暂无访问记录。</p>'}</div></details>`;
    } catch (error) { box.textContent = `隐私信息读取失败：${error.message}`; }
  }
  async function exportAccountData() {
    const status = $('pro-export-status');
    status.textContent = '正在准备数据…';
    try {
      const response = await fetch('/api/privacy/exports', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'json' }),
      });
      if (!response.ok) throw new Error((await response.json()).error || '导出失败');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `xiaokang-personal-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = '数据已导出。';
    } catch (error) { status.textContent = error.message; }
  }
  async function startAccountDeletion() {
    const area = $('pro-delete-area');
    area.textContent = '正在读取删除范围…';
    try {
      const request = await P.post('/api/privacy/deletion-requests', {});
      area.innerHTML = `<p class="text-sm text-zinc-600 mb-2">将删除：${(request.categories || []).map(P.esc).join('、')}</p><form id="pro-delete-form" class="space-y-3"><label class="block text-sm font-bold">输入“${P.esc(request.confirmation_text)}”<input name="confirmation_text" required autocomplete="off" class="w-full mt-2 rounded-xl border border-zinc-200 bg-white p-3"></label><label class="block text-sm font-bold">当前密码<input name="password" type="password" autocomplete="current-password" required class="w-full mt-2 rounded-xl border border-zinc-200 bg-white p-3"></label><label class="flex gap-2 text-sm"><input name="understood" type="checkbox" required>我明白删除后无法恢复</label><button type="submit" class="rounded-xl bg-red-700 text-white px-4 py-3 font-bold">确认永久删除</button><p id="pro-delete-status" role="status" class="text-sm"></p></form>`;
      $('pro-delete-form').addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const status = $('pro-delete-status');
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        status.textContent = '正在处理…';
        try {
          await P.post(`/api/privacy/deletion-requests/${encodeURIComponent(request.id)}/confirm`, {
            confirmation_text: form.elements.confirmation_text.value,
            password: form.elements.password.value,
          });
          location.replace('/login.html?account_deleted=1');
        } catch (error) { status.textContent = error.message; button.disabled = false; }
      });
    } catch (error) { area.textContent = error.message; }
  }
  /* ------------------------------------------------------------------
     慢病风险评估：直接消费 /api/prediction/discovery/overview
     重点不是给一个概率数字，而是把「模型是否通过验证门槛」讲清楚。
     ------------------------------------------------------------------ */
  function riskItem(key, v) {
    const name = DISEASE_NAMES[key] || key;
    const [label, badge] = RISK_STATUS[v.status] || [v.status || '未知', 'is-limited'];
    const level = ({ low: '低', medium: '中', high: '高' })[v.risk_level] || null;
    const missing = (v.missing_features || []).filter(Boolean);
    const gate = v.gate_result || null;
    const checks = (gate && gate.checks) || {};
    const passed = Object.values(checks).filter(Boolean).length;
    const total = Object.keys(checks).length;
    const m = (gate && gate.metrics) || {};
    const metricsLine = [
      gate && gate.evaluated_model ? `评估模型 ${gate.evaluated_model}` : '',
      gate && gate.deployed_model ? `上线模型 ${gate.deployed_model}` : '',
      m.roc_auc != null ? `AUC ${Number(m.roc_auc).toFixed(3)}` : '',
      m.brier != null ? `Brier ${Number(m.brier).toFixed(3)}` : '',
    ].filter(Boolean).join(' · ');
    const gateHtml = gate ? `<details class="risk-gate"><summary>证据门禁 ${passed}/${total} 项通过</summary>
        <ul class="gate-grid">${Object.entries(checks).map(([k, ok]) => `<li class="${ok ? 'is-ok' : 'is-no'}"><span>${ok ? '✓' : '✕'}</span>${P.esc(GATE_LABELS[k] || k)}</li>`).join('')}</ul>
        ${gate.reason_code ? `<p class="gate-note">未放行原因：${P.esc(gate.reason_code)}</p>` : ''}
        ${metricsLine ? `<p class="gate-metrics">${P.esc(metricsLine)}</p>` : ''}
        ${gate.evaluation_run_id ? `<p class="gate-note">评估批次 ${P.esc(gate.evaluation_run_id)}</p>` : ''}
      </details>` : '';
    const desc = v.disclaimer || (v.existing_diagnosis ? '已确诊疾病不再计算新发风险，转入日常管理。' : '');
    return `<div class="risk-item">
      <div class="risk-item-head"><span class="risk-name">${P.esc(name)}</span><span class="risk-badge ${badge}">${P.esc(label)}</span></div>
      ${desc ? `<p class="risk-desc">${P.esc(desc)}</p>` : ''}
      <div class="risk-meta">
        ${level ? `<span>风险等级 <b>${level}</b></span>` : ''}
        ${v.horizon_years ? `<span>窗口 <b>${v.horizon_years} 年</b></span>` : ''}
        <span>${missing.length ? `缺失 <b>${P.esc(missing.join('、'))}</b>` : '特征 <b>完整</b>'}</span>
      </div>
      ${gateHtml}
    </div>`;
  }
  async function renderRisk() {
    const box = $('tab-risk');
    if (!box || riskLoading) return;
    riskLoading = true;
    box.innerHTML = P.notice('正在筛查', '正在读取四类慢病风险与证据门禁…');
    try {
      const d = await P.get('/api/prediction/discovery/overview');
      if (!box.isConnected) return;
      const s = d.summary || {};
      const tone = s.severity === 'critical' ? 'is-critical' : s.severity === 'warning' ? 'is-warning' : 'is-stable';
      const kicker = ({ critical: '需要立即处理', warning: '建议留意', stable: '状态平稳' })[s.severity] || '筛查结果';
      const cards = ['hypertension', 'diabetes', 'heart_disease', 'stroke']
        .filter(k => d.diseases && d.diseases[k]).map(k => riskItem(k, d.diseases[k]));
      const seenEvents = new Set();
      const events = (d.events || []).filter(ev => {
        const key = ev.event_key || ev.title || '';
        if (seenEvents.has(key)) return false;
        seenEvents.add(key);
        return true;
      }).slice(0, 3);
      box.innerHTML = `<div class="risk-hero ${tone}">
          <span class="risk-hero-kicker">${kicker}</span>
          <h3>${P.esc(s.current || '暂无结论')}</h3>
          ${s.change ? `<p>${P.esc(s.change)}</p>` : ''}
          ${s.action ? `<div class="risk-hero-action">建议：${P.esc(s.action)}</div>` : ''}
        </div>`
        + `<div class="risk-grid">${cards.join('')}</div>`
        + (events.length ? P.card('需要关注的发现', events.map(ev => `<div class="rounded-xl bg-white/70 p-3"><strong>${P.esc(ev.title)}</strong><p class="text-sm text-zinc-600 mt-1">${P.esc(ev.message || '')}</p><p class="text-xs text-zinc-400 mt-1">${P.esc(ev.action || '')}</p></div>`).join('<div class="h-2"></div>')) : '')
        + `<p class="risk-disclaimer">${P.esc(d.disclaimer || '风险筛查用于提示和复测，不是诊断。')}</p>`;
    } catch (error) {
      if (box.isConnected) box.innerHTML = P.notice('风险筛查暂时不可用', error.message) + `<div>${P.btn('重新评估', 'risk')}</div>`;
    } finally { riskLoading = false; }
  }

  /* ------------------------------------------------------------------
     知识证据：直接消费 /api/knowledge/graph/query（GraphRAG）
     把证据等级、关系路径、医学门禁拦截数量都摆出来。
     ------------------------------------------------------------------ */
  function knowledgeBody(r) {
    const gate = r.medical_gate || {};
    const conf = r.confidence || {};
    const unc = r.uncertainty || {};
    const stat = `<div class="evi-stat">
        <div><span>证据条数</span><strong>${(r.results || []).length}</strong></div>
        <div><span>置信度</span><strong>${Math.round(Number(conf.score || 0) * 100)}%</strong></div>
        <div><span>门禁拦截</span><strong>${gate.blocked_edge_count != null ? Number(gate.blocked_edge_count) : '—'}</strong></div>
      </div>`;
    const gateBar = gate.blocked_edge_count != null
      ? `<div class="evi-gate"><span>!</span><div><strong>医学门禁拦截 ${Number(gate.blocked_edge_count)} 条关系</strong><br>${P.esc(gate.policy || '')}</div></div>` : '';
    const cards = (r.results || []).slice(0, 4).map(item => `<div class="evi-card">
        <div class="evi-head"><h4>${P.esc(item.section || '证据片段')}</h4><span class="evi-level">${P.esc(item.source_version || '未标注')}</span></div>
        <p class="evi-text">${P.esc(item.text || '')}</p>
        <div class="evi-foot"><span>来源 <code>${P.esc(item.source_id || '—')}</code></span><span>检索于 ${P.esc(item.retrieved_at || '—')}</span></div>
      </div>`).join('');
    const paths = (r.graph_paths || []).slice(0, 3).map(p => {
      const labels = p.node_labels || p.nodes || [];
      const edge = ((p.edges || [])[0] || {});
      return `<div class="evi-path"><b>${P.esc(labels[0] || '')}</b><i>→</i><b>${P.esc(labels[1] || '')}</b>${edge.type ? `<small>${P.esc(edge.type)}${edge.strength ? ` · ${P.esc(edge.strength)}` : ''}</small>` : ''}</div>`;
    }).join('');
    const reasons = (unc.reasons || []).slice(0, 3);
    return stat + gateBar
      + (cards ? `<div>${cards}</div>` : P.notice('没有匹配证据', '换一个说法或关键词再试一次。'))
      + (paths ? P.card('关系路径', paths) : '')
      + `<details class="ans-basis"><summary>不确定性与来源说明</summary>
          <p>索引版本 ${P.esc(r.index_version || '—')} · 检索模式 ${P.esc(r.graph_mode || '—')}</p>
          <p>不确定性：${P.esc(unc.level || '未知')}${reasons.length ? ` · ${P.esc(reasons.join('；'))}` : ''}</p>
          <ul>${(r.citations || []).slice(0, 4).map(c => `<li>${P.esc(c.citation || c.source_id || '')}</li>`).join('')}</ul>
          <p>${P.esc(r.disclaimer || '知识检索用于解释和健康教育，不替代医生诊断。')}</p>
        </details>`;
  }
  async function renderKnowledge(q = '') {
    const box = $('tab-knowledge');
    if (!box) return;
    const effective = (q || '').trim() || KNOWLEDGE_PROMPTS[0];
    knowledgeQuery = effective;
    box.innerHTML = `<form class="evi-search" id="pro-knowledge-form">
        <input name="q" value="${P.esc(effective)}" placeholder="输入健康问题" aria-label="知识检索关键词">
        <button type="submit">检索</button>
      </form>
      <div class="evi-chips">${KNOWLEDGE_PROMPTS.filter(p => p !== effective).map(p => `<button type="button" data-knowledge-prompt="${P.esc(p)}">${P.esc(p)}</button>`).join('')}</div>
      <div id="pro-knowledge-body">${P.notice('正在检索', '正在查询可追溯证据…')}</div>`;
    $('pro-knowledge-form').addEventListener('submit', event => {
      event.preventDefault();
      renderKnowledge(event.currentTarget.elements.q.value || '');
    });
    const body = $('pro-knowledge-body');
    try {
      const r = await P.get(`/api/knowledge/graph/query?q=${encodeURIComponent(effective)}&top_k=4`);
      if (body && body.isConnected) body.innerHTML = knowledgeBody(r);
    } catch (error) {
      if (body && body.isConnected) body.innerHTML = P.notice('知识检索暂时不可用', error.message || '请稍后重试');
    }
  }

  /* ------------------------------------------------------------------
     智能体回答的补充块：回答依据 + 关联证据 + 待确认行动
     ------------------------------------------------------------------ */
  function actionCard(p) {
    const type = p.action_type || 'create_todo';
    const when = new Date(Date.now() + 3 * 864e5);
    const pad = n => String(n).padStart(2, '0');
    const local = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T08:00`;
    return `<div class="act-card" data-act-type="${P.esc(type)}" data-act-title="${P.esc(p.title || '')}" data-act-desc="${P.esc(p.desc || '')}">
      <span class="act-kicker">待确认行动</span>
      <strong>${P.esc(p.title || '健康行动')}</strong>
      ${p.desc ? `<p class="act-desc">${P.esc(p.desc)}</p>` : ''}
      ${type === 'schedule_recheck' ? `<input class="act-when" type="datetime-local" value="${local}" aria-label="复测时间">` : ''}
      <div class="act-controls"><button type="button" data-act="confirm">确认执行</button><button type="button" data-act="dismiss">暂不安排</button></div>
      <p class="act-status" role="status">确认后才会写入，系统不会自动打电话或发短信。</p>
    </div>`;
  }
  function answerExtras(result) {
    let html = '';
    const conf = result.confidence;
    if (conf) {
      const basis = conf.type === 'data' ? `数据依据 · ${conf.score} 分` : '一般健康知识';
      const items = (result.evidence && result.evidence.items || []).slice(0, 3)
        .map(it => `<li>${P.esc(it.metric || '')} ${P.esc(it.latest_value ?? '')}${it.unit ? ` ${P.esc(it.unit)}` : ''}</li>`).join('');
      html += `<details class="ans-basis"><summary>查看回答依据</summary><p>${P.esc(basis)}${conf.reasoning ? `：${P.esc(conf.reasoning)}` : ''}</p>${items ? `<ul>${items}</ul>` : ''}<p>依据充分程度不代表患病概率，也不能替代医生诊断。</p></details>`;
    }
    const g = result.graph_evidence_snapshot;
    if (g && (g.results || []).length) {
      const top = g.results.slice(0, 3).map(r => `<li>${P.esc(r.section || r.source_id || '证据片段')}</li>`).join('');
      html += `<details class="ans-basis"><summary>关联证据（GraphRAG · ${P.esc(g.index_version || '')}）</summary><ul>${top}</ul><p>关系与来源可追溯，未通过医学门禁的关系不会进入回答。</p></details>`;
    }
    const previews = (result.action_previews && result.action_previews.length ? result.action_previews : result.plan) || [];
    previews.filter(p => p && p.requires_confirmation).forEach(p => { html += actionCard(p); });
    return html;
  }
  async function handleActionCard(btn) {
    const card = btn.closest('.act-card');
    if (!card || card.dataset.busy === '1') return;
    const status = card.querySelector('.act-status');
    if (btn.dataset.act === 'dismiss') {
      card.classList.add('is-cancelled');
      card.querySelector('.act-controls')?.remove();
      if (status) status.textContent = '已跳过，没有创建任何记录。';
      return;
    }
    const type = card.dataset.actType || 'create_todo';
    const title = card.dataset.actTitle || '健康行动';
    const desc = card.dataset.actDesc || '';
    const body = { action_type: type, title, desc, kind: /用药|药物|就医|医生|家属|通知/.test(title + desc) ? 'sensitive' : 'agent' };
    if (type === 'schedule_recheck') {
      const metric = /血压/.test(title) ? 'bp' : /血糖/.test(title) ? 'glucose' : /心率|脉搏/.test(title) ? 'hr' : /体重/.test(title) ? 'weight' : /睡眠/.test(title) ? 'sleep' : null;
      if (!metric) { if (status) status.textContent = '这项复测没有明确指标，请换个说法，例如「三天后复测血压」。'; return; }
      const when = card.querySelector('.act-when')?.value;
      if (!when || Date.parse(when) <= Date.now()) { if (status) status.textContent = '请选择一个将来的复测时间。'; return; }
      body.metric_type = metric;
      body.due_at = new Date(when).toISOString();
    }
    card.dataset.busy = '1';
    const buttons = card.querySelectorAll('.act-controls button');
    buttons.forEach(b => { b.disabled = true; });
    if (status) status.textContent = '正在提交…';
    try {
      const created = await P.post('/api/actions', body);
      if (!created.requires_confirmation || !created.request || !created.request.id) throw new Error('服务端没有返回待确认行动');
      if (!created.confirmation || !created.confirmation.one_time_token) throw new Error('确认卡已失效，请重新发起');
      await P.post(`/api/actions/${created.request.id}/confirm`, { confirmation_token: created.confirmation.one_time_token });
      card.classList.add('is-done');
      card.querySelector('.act-controls')?.remove();
      const doneText = type === 'schedule_recheck'
        ? '已确认，复测安排已加入「守护」页的复测随访。'
        : type === 'create_todo'
          ? '已确认，待办已加入「概览」页。'
          : '已确认并记录。';
      if (status) status.textContent = doneText;
      toast('行动已确认');
    } catch (error) {
      card.dataset.busy = '';
      buttons.forEach(b => { b.disabled = false; });
      if (status) status.textContent = error.message || '提交失败，请重试';
    }
  }

  /* 复测随访闭环：行动确认后落到这里，可看到基线与到期时间 */
  async function loadFollowups() {
    const box = $('pro-followups');
    if (!box) return;
    try {
      const d = await P.get('/api/actions/followups');
      const items = (d.items || []).filter(f => f.status !== 'cancelled').slice(0, 4);
      if (!items.length) { box.innerHTML = '<p class="text-sm text-zinc-500">暂无待复测安排。在「管家」里确认一次复测行动后，这里会出现随访记录。</p>'; return; }
      if (!box.isConnected) return;
      box.innerHTML = items.map(f => {
        const c = f.comparison || {};
        const base = c.baseline ? `${c.baseline.value}${c.baseline.value2 != null ? '/' + c.baseline.value2 : ''} ${c.baseline.unit || ''}`.trim() : '—';
        return `<div class="rounded-xl bg-white/70 p-3">
          <div class="flex items-center justify-between gap-2"><strong>${P.esc(c.label || METRIC_NAMES[f.metric_type] || f.metric_type || '指标')} 复测</strong><span class="text-xs text-zinc-500">${P.esc(FOLLOWUP_STATUS[f.status] || f.status)}</span></div>
          <p class="text-sm text-zinc-600 mt-1">基线 ${P.esc(base)}</p>
          <p class="text-xs text-zinc-400 mt-1">到期 ${P.esc(P.date(f.due_at))}</p>
        </div>`;
      }).join('<div class="h-2"></div>');
    } catch {
      if (box.isConnected) box.innerHTML = '<p class="text-sm text-zinc-500">复测安排读取失败。</p>';
    }
  }

  function switchTab(tab) {
    const changed = currentTab !== tab;
    if (changed) stopReading();
    if (currentTab === 'butler' && tab !== 'butler') cancelMic();
    currentTab = tab;
    panes.forEach(id => $('tab-'+id)?.classList.toggle('hidden', id !== tab));
    if (changed) {
      if ($('mainScrollArea')) $('mainScrollArea').scrollTop = 0;
      window.scrollTo(0, 0);
    }
    document.querySelectorAll('.nav-tab').forEach(node => {
      const selected = node.dataset.view === tab;
      node.classList.toggle('active', selected);
      if (selected) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    if ($('mainHeaderTitle')) $('mainHeaderTitle').textContent = ({overview:'健康概览',butler:'智能管家',risk:'风险评估',trends:'档案与趋势',care:'亲情守护',profile:'个人中心',account:'账号与隐私',knowledge:'知识证据'})[tab];
    if (tab === 'account') loadAccountPrivacy();
    if (tab === 'risk') renderRisk();
    if (tab === 'knowledge') renderKnowledge(knowledgeQuery || '');
    if (tab === 'care') loadFollowups();
  }
  window.switchTab = switchTab;
  const FONT_MODES = ['standard', 'large', 'xlarge'];
  const FONT_BADGES = { standard: '标', large: '大', xlarge: '特' };
  function applyFontMode(mode) {
    const next = FONT_MODES.includes(mode) ? mode : 'large';
    document.body.classList.remove(...FONT_MODES.map(x => 'font-mode-' + x));
    document.body.classList.add('font-mode-' + next);
    document.body.dataset.font = next;
    document.documentElement.dataset.font = next;
    if ($('fontBadge')) $('fontBadge').textContent = FONT_BADGES[next];
    try { localStorage.setItem('pro-font-mode', next); } catch {}
  }
  window.cycleFontSize = function () {
    const current = document.documentElement.dataset.font || document.body.dataset.font || 'large';
    applyFontMode(FONT_MODES[(FONT_MODES.indexOf(current) + 1) % FONT_MODES.length]);
  };
  window.handleVoiceButtonClick = function () {
    if (voiceRequest || voiceAudio) stopReading();
    else {
      const answers = $('pro-chat')?.querySelectorAll('.pro-answer');
      const answer = answers?.length ? answers[answers.length - 1].textContent : '';
      readText(VoiceSummary.summarize(currentTab, {
        summary: data?.summary, metrics: data?.metrics, todos: data?.todos, alerts: data?.alerts,
        answer, trends: trendVoicePoints, user, activeAuthorizations: activeAuthorizationCount,
      }));
    }
  };
  window.handleLogout = async function () { try { await P.post('/api/auth/logout',{}); location.reload(); } catch(error) { showError(error); } };
  function showLogin() {
    $('main-app')?.classList.add('hidden');
    $('view-login')?.classList.remove('hidden');
    $('view-login').innerHTML = `<div class="max-w-sm mx-auto space-y-6"><div class="text-center"><div class="text-4xl mb-3">♡</div><h1 class="text-3xl font-black">长寿康 Pro</h1><p class="text-zinc-500 mt-2">使用已有账号安全登录</p></div><form id="pro-login" class="glass-card rounded-[28px] p-6 space-y-4"><label class="block text-sm font-bold">账号<input name="identifier" autocomplete="username" required class="mt-2 w-full rounded-2xl p-3 border border-zinc-200 bg-white" placeholder="姓名或手机号"></label><label class="block text-sm font-bold">密码<input name="password" type="password" autocomplete="current-password" required class="mt-2 w-full rounded-2xl p-3 border border-zinc-200 bg-white"></label><button class="w-full rounded-2xl bg-zinc-900 text-white font-black py-4">登录</button><p id="pro-login-error" class="text-red-600 text-sm" role="alert"></p></form><p class="text-center text-sm text-zinc-500">还没有账号？<a href="/register.html?next=%2Fmobile" class="underline">注册</a></p></div>`;
    $('pro-login').addEventListener('submit', async event => { event.preventDefault(); const form=new FormData(event.currentTarget); try { await P.post('/api/auth/login',{identifier:form.get('identifier'),password:form.get('password')}); await load(); } catch(error) { $('pro-login-error').textContent=error.message; } });
  }
  const line = (label, value) => `<div class="flex justify-between gap-4 py-3 border-b border-zinc-100 text-sm"><span class="text-zinc-500">${P.esc(label)}</span><strong class="text-right">${P.esc(value)}</strong></div>`;
  function render() {
    cancelMic();
    activeAuthorizationCount = null;
    trendVoicePoints = null;
    const m=data.metrics, s=data.summary, todos=data.todos, alerts=data.alerts;
    $('view-login')?.classList.add('hidden'); $('main-app')?.classList.remove('hidden');
    if ($('btnProfileEntry')) $('btnProfileEntry').textContent=user.name?.slice(0,1)||'我';
    if ($('currentDateStr')) $('currentDateStr').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
    $('tab-overview').innerHTML = P.card('今日健康摘要',`<p class="text-sm leading-relaxed">${P.esc(s.summary || '继续记录健康数据，可查看个人趋势。')}</p><p class="text-xs text-zinc-400 mt-3">最新数据来自健康服务 · ${P.esc(s.today)}</p>`) + `<div class="metric-grid">${[['血压','bp'],['血糖','glucose'],['静息心率','hr'],['步数','steps']].map(([name,type])=>`<div class="glass-card rounded-[24px] p-4"><p class="text-xs text-zinc-500">${name}</p><p class="metric-value font-black mt-2">${P.esc(P.metric(m[type],type))}</p><p class="text-xs text-zinc-400 mt-2">${P.esc(P.date(m[type]?.recorded_at))}</p></div>`).join('')}</div>` + P.card('快捷操作',`<div class="flex flex-wrap gap-2">${P.btn('录入血压/血糖','measure')}${P.btn('风险评估','risk')}${P.btn('知识证据','knowledge',true)}${P.btn('查看趋势','trends',true)}${P.btn('查看提醒','care',true)}</div>`) + P.card('今日待办',todos.length ? todos.map(t=>line(t.title,t.completed?'已完成':t.time||'待完成')).join('') : '<p class="text-sm text-zinc-500">暂无待办</p>');
    $('tab-butler').innerHTML = P.card('智能健康管家',`<p class="text-xs text-zinc-500 mb-3">回答来源由后端标记；健康建议不能替代诊疗。</p><div id="pro-chat" class="space-y-3 overflow-y-auto mb-3" style="max-height:clamp(200px,40dvh,420px)"></div><form id="pro-chat-form" class="flex gap-2"><input name="message" required maxlength="1000" class="min-w-0 flex-1 rounded-xl p-3 border border-zinc-200" placeholder="输入健康问题" aria-label="健康问题"><button id="pro-mic-button" type="button" class="rounded-xl border border-zinc-300 bg-white px-3 text-zinc-800 font-bold" aria-label="开始语音输入" title="开始语音输入" aria-pressed="false"><i class="fa-solid fa-microphone" aria-hidden="true"></i></button><button type="submit" class="bg-zinc-900 text-white rounded-xl px-4 font-bold">发送</button></form><p id="pro-mic-status" role="status" class="mt-2 text-xs text-zinc-500">点击麦克风开始说话，说完再点一次停止。识别文字会填入输入框。</p><div class="mt-3">${P.btn('知识证据 · GraphRAG','knowledge',true)}</div>`);
    $('pro-mic-button').addEventListener('click', toggleMic);
    checkMicAvailability();
    $('tab-trends').innerHTML = '<div id="pro-trends" class="space-y-4"><p class="text-sm text-zinc-500">正在读取测量记录…</p></div>';
    $('tab-care').innerHTML = P.card('提醒与家人授权',`<p class="text-xs text-zinc-500 mb-3">提醒来自服务端。授权码只交给指定家属或医生。</p><div class="space-y-2">${alerts.length?alerts.map(a=>`<div class="rounded-xl bg-white/70 p-3"><strong>${P.esc(a.title)}</strong><p class="text-sm text-zinc-600">${P.esc(a.message)}</p><p class="text-xs text-zinc-400">${P.esc(P.date(a.created_at))}</p></div>`).join(''):'<p class="text-sm text-zinc-500">暂无提醒</p>'}</div><div class="mt-4 flex gap-2 flex-wrap">${user.role==='senior'?P.btn('生成家属授权码','invite'):''}${P.btn('刷新提醒','refresh',true)}</div><p id="pro-invite-code" class="text-sm mt-3 font-bold"></p>`) + P.card('复测随访','<div id="pro-followups" class="space-y-2"><p class="text-sm text-zinc-500">正在读取…</p></div>');
    $('tab-profile').innerHTML = P.card('个人资料',line('姓名',user.name)+line('角色',user.role==='senior'?'老人':user.role==='caregiver'?'家属':user.role==='doctor'?'医生':user.role)+line('年龄',user.age||'未填写')+`<div class="mt-4 flex gap-2 flex-wrap">${P.btn('切换字号','font')}${P.btn('退出登录','logout',true)}</div>`);
    $('tab-profile').innerHTML += P.card('本机朗读音色', `<p class="text-xs text-zinc-500 mb-3">自然语音在本机生成，朗读文字不会发送给在线语音服务。</p><label class="block text-sm font-bold">选择音色<select id="pro-local-voice" class="mt-2 w-full rounded-xl border border-zinc-200 bg-white p-3"><option value="zf_001">女声 1</option><option value="zf_002">女声 2</option><option value="zm_009">男声</option></select></label><div class="mt-3">${P.btn('试听音色','voice-preview')}</div>`);
    if ($('pro-local-voice')) $('pro-local-voice').value = voiceChoices.has(localStorage.getItem('pro-local-voice')) ? localStorage.getItem('pro-local-voice') : 'zf_001';
    $('tab-profile').innerHTML += P.card('账号安全与隐私管理', `<p class="text-sm text-zinc-500 mb-3">管理密码、授权和个人数据。</p>${P.btn('进入管理','account',true)}`);
    renderAccount();
    $('tab-overview').innerHTML += '<div id="pro-overview-chart"></div>';
    switchTab(currentTab);
    loadTrends();
    $('pro-chat-form').addEventListener('submit', async e => {
      e.preventDefault();
      const input = e.target.elements.message, msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      const box = $('pro-chat');
      const question = document.createElement('div');
      question.className = 'rounded-xl bg-zinc-100 p-3 text-base';
      question.textContent = `我：${msg}`;
      box.append(question);
      const answer = document.createElement('div');
      answer.className = 'rounded-xl bg-white p-4';
      const name = document.createElement('strong');
      name.className = 'text-sm text-zinc-500';
      name.textContent = '小康';
      const content = document.createElement('p');
      content.className = 'pro-answer mt-2';
      content.textContent = '正在整理回答…';
      answer.append(name, content);
      box.append(answer);
      box.scrollTop = box.scrollHeight;
      try {
        const result = await P.post('/api/chat', { message: msg });
        content.textContent = `${result.content || '暂无回复'}${result.llm?.call_status === 'mock' ? '（演示模式）' : ''}`;
        answer.insertAdjacentHTML('beforeend', answerExtras(result));
      } catch (error) {
        content.textContent = '暂时无法回答，请稍后再试。';
        showError(error);
      }
      box.scrollTop = box.scrollHeight;
    });
  }
  async function loadTrends() {
    const box = $('pro-trends');
    if (!box) return;
    trendVoicePoints = null;
    const types = [['bp', '血压', 'mmHg'], ['glucose', '血糖', 'mmol/L'], ['hr', '心率', 'bpm'], ['steps', '步数', '步'], ['sleep', '睡眠', '小时']];
    const results = await Promise.allSettled(types.map(([type]) => P.get(`/api/trend/${type}?days=90`)));
    if (!box.isConnected) return;
    trendVoicePoints = Object.fromEntries(types.map(([type], index) => [type, results[index].status === 'fulfilled' ? results[index].value.points || [] : []]));
    const charts = results.map((result, index) => {
      const [type, title, unit] = types[index];
      if (result.status !== 'fulfilled') return P.notice(`${title}读取失败`, result.reason?.message || '请稍后重试');
      return window.ProCharts.line({ title, points: result.value.points || [], unit, secondary: type === 'bp' });
    });
    box.innerHTML = '<p class="text-xs text-zinc-500 leading-relaxed">曲线根据最近 90 天的已保存测量绘制；没有记录的指标会明确标出。</p>' + charts.join('');
    const preview = $('pro-overview-chart');
    if (preview?.isConnected) {
      const first = results.find(result => result.status === 'fulfilled' && result.value.points?.length);
      preview.innerHTML = first ? window.ProCharts.line({ title: first.value.meta?.name || '健康趋势', points: first.value.points, unit: first.value.meta?.unit || '', secondary: first.value.type === 'bp' }) : P.notice('趋势预览', '保存一次健康测量后，趋势图会在这里出现。');
    }
  }
  async function load() { try { user=await P.get('/api/auth/me'); if(user.role!=='senior'){location.replace('/family');return;} const results=await Promise.all([P.get('/api/health/summary'),P.get('/api/health/metrics'),P.get('/api/todos/today'),P.get('/api/alerts?status=pending')]); data={summary:results[0],metrics:results[1],todos:results[2],alerts:results[3].items||[]}; render(); } catch(error) { if(error.status===401)showLogin(); else {$('view-login').innerHTML=P.notice('连接失败',error.message)+`<div class="p-6">${P.btn('重试','refresh')}</div>`;} } }
  document.addEventListener('click', event => {
    const actBtn = event.target.closest('[data-act]');
    if (actBtn) { handleActionCard(actBtn); return; }
    const promptBtn = event.target.closest('[data-knowledge-prompt]');
    if (promptBtn) renderKnowledge(promptBtn.dataset.knowledgePrompt || '');
  });
  document.addEventListener('change', e => { if (e.target.id === 'pro-local-voice' && voiceChoices.has(e.target.value)) localStorage.setItem('pro-local-voice', e.target.value); });
  document.addEventListener('click',async e=>{const action=e.target.closest('[data-pro-action]')?.dataset.proAction; if(!action)return; try {if(action==='measure'){const high=prompt('收缩压 mmHg（留空跳过）',''); const low=high?prompt('舒张压 mmHg',''):null; const glucose=prompt('血糖 mmol/L（留空跳过）',''); if(!high&&!glucose)return; if(high){if(!low)throw Error('请填写舒张压'); await P.post('/api/health/metrics',{type:'bp',value:Number(high),value2:Number(low),unit:'mmHg',source:'manual',measurement_condition:'unknown'});} if(glucose)await P.post('/api/health/metrics',{type:'glucose',value:Number(glucose),unit:'mmol/L',source:'manual',measurement_condition:'unknown'}); await load(); toast('测量已保存');} else if(action==='invite'){const result=await P.post('/api/care/invitations',{member_role:'caregiver'}); $('pro-invite-code').textContent=`家属授权码：${result.code}（7 天内使用）`; } else if(action.startsWith('todo:')){await P.patch('/api/todos/'+action.split(':')[1],{completed:true});await load();switchTab('overview');} else if(action==='refresh')await load(); else if(action==='logout')await window.handleLogout(); else if(action==='font')window.cycleFontSize(); else if(action==='voice-preview')readText('您好，我是小康。祝您今天心情愉快。'); else if(action==='account-export')await exportAccountData(); else if(action==='account-delete-start')await startAccountDeletion(); else if(action.startsWith('account-revoke:')) { if (confirm('撤回后，对方将无法继续查看您的健康数据。确定撤回吗？')) { await P.post(`/api/care/relationships/${Number(action.split(':')[1])}/revoke`,{reason:'用户从账号与隐私页面撤回'}); await loadAccountPrivacy(); } } else if(panes.includes(action))switchTab(action);}catch(error){showError(error);} });
  applyFontMode(document.documentElement.dataset.font || 'large');
  panes.forEach(id=>{$('tab-'+id).innerHTML=P.notice('正在连接健康服务','请稍候…');});
  load();
})();

