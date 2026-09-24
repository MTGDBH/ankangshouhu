(function () {
  'use strict';
  const P = window.Pro;
  const $ = id => document.getElementById(id);
  const panes = ['overview','butler','meds','trends','care','profile'];
  const requestedTab = new URLSearchParams(location.search).get('view');
  let user = null, data = null, currentTab = panes.includes(requestedTab) ? requestedTab : 'overview';
  function toast(message) { const node = $('toastContent'); if (node) { node.textContent = message; $('toastMessage')?.classList.remove('opacity-0','pointer-events-none'); setTimeout(() => $('toastMessage')?.classList.add('opacity-0','pointer-events-none'), 3000); } }
  function showError(error) { toast(error.message || '操作失败'); }
  function switchTab(tab) {
    currentTab = tab;
    panes.forEach(id => $('tab-'+id)?.classList.toggle('hidden', id !== tab));
    document.querySelectorAll('.nav-tab').forEach(node => node.classList.toggle('active', node.dataset.view === tab));
    if ($('mainHeaderTitle')) $('mainHeaderTitle').textContent = ({overview:'健康概览',butler:'智能管家',meds:'今日计划',trends:'档案与趋势',care:'亲情守护',profile:'个人中心'})[tab];
  }
  window.switchTab = switchTab;
  window.cycleFontSize = function () { const values = ['standard','large','xlarge']; const next = values[(values.indexOf(document.body.dataset.font || 'large')+1)%values.length]; document.body.classList.remove(...values.map(x=>'font-mode-'+x)); document.body.classList.add('font-mode-'+next); document.body.dataset.font=next; if ($('fontBadge')) $('fontBadge').textContent=({standard:'标',large:'大',xlarge:'特'})[next]; };
  window.handleVoiceButtonClick = function () { if (speechSynthesis.speaking) speechSynthesis.cancel(); else { const text=$('tab-'+currentTab)?.innerText || ''; const utterance=new SpeechSynthesisUtterance(text.slice(0,700)); utterance.lang='zh-CN'; utterance.rate=.85; speechSynthesis.speak(utterance); } };
  window.handleLogout = async function () { try { await P.post('/api/auth/logout',{}); location.reload(); } catch(error) { showError(error); } };
  function showLogin() {
    $('main-app')?.classList.add('hidden');
    $('view-login')?.classList.remove('hidden');
    $('view-login').innerHTML = `<div class="max-w-sm mx-auto px-6 pt-20 space-y-6"><div class="text-center"><div class="text-4xl mb-3">♡</div><h1 class="text-3xl font-black">长寿康 Pro</h1><p class="text-zinc-500 mt-2">使用已有账号安全登录</p></div><form id="pro-login" class="glass-card rounded-[28px] p-6 space-y-4"><label class="block text-sm font-bold">账号<input name="identifier" autocomplete="username" required class="mt-2 w-full rounded-2xl p-3 border border-zinc-200 bg-white" placeholder="姓名或手机号"></label><label class="block text-sm font-bold">密码<input name="password" type="password" autocomplete="current-password" required class="mt-2 w-full rounded-2xl p-3 border border-zinc-200 bg-white"></label><button class="w-full rounded-2xl bg-zinc-900 text-white font-black py-4">登录</button><p id="pro-login-error" class="text-red-600 text-sm" role="alert"></p></form><p class="text-center text-sm text-zinc-500">还没有账号？<a href="/register.html?next=%2Fmobile" class="underline">注册</a></p></div>`;
    $('pro-login').addEventListener('submit', async event => { event.preventDefault(); const form=new FormData(event.currentTarget); try { await P.post('/api/auth/login',{identifier:form.get('identifier'),password:form.get('password')}); await load(); } catch(error) { $('pro-login-error').textContent=error.message; } });
  }
  const line = (label, value) => `<div class="flex justify-between gap-4 py-3 border-b border-zinc-100 text-sm"><span class="text-zinc-500">${P.esc(label)}</span><strong class="text-right">${P.esc(value)}</strong></div>`;
  function render() {
    const m=data.metrics, s=data.summary, todos=data.todos, alerts=data.alerts;
    $('view-login')?.classList.add('hidden'); $('main-app')?.classList.remove('hidden');
    if ($('btnProfileEntry')) $('btnProfileEntry').textContent=user.name?.slice(0,1)||'我';
    if ($('currentDateStr')) $('currentDateStr').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
    $('tab-overview').innerHTML = P.card('今日健康摘要',`<p class="text-sm leading-relaxed">${P.esc(s.summary || '继续记录健康数据，可查看个人趋势。')}</p><p class="text-xs text-zinc-400 mt-3">最新数据来自健康服务 · ${P.esc(s.today)}</p>`) + `<div class="grid grid-cols-2 gap-3">${[['血压','bp'],['血糖','glucose'],['静息心率','hr'],['步数','steps']].map(([name,type])=>`<div class="glass-card rounded-[24px] p-4"><p class="text-xs text-zinc-500">${name}</p><p class="text-lg font-black mt-2">${P.esc(P.metric(m[type],type))}</p><p class="text-xs text-zinc-400 mt-2">${P.esc(P.date(m[type]?.recorded_at))}</p></div>`).join('')}</div>` + P.card('快捷操作',`<div class="flex flex-wrap gap-2">${P.btn('录入血压/血糖','measure')}${P.btn('查看趋势','trends',true)}${P.btn('查看提醒','care',true)}</div>`) + P.card('今日待办',todos.length ? todos.map(t=>line(t.title,t.completed?'已完成':t.time||'待完成')).join('') : '<p class="text-sm text-zinc-500">暂无待办</p>');
    $('tab-butler').innerHTML = P.card('智能健康管家',`<p class="text-xs text-zinc-500 mb-3">回答来源由后端标记；健康建议不能替代诊疗。</p><div id="pro-chat" class="space-y-3 max-h-80 overflow-y-auto mb-3"></div><form id="pro-chat-form" class="flex gap-2"><input name="message" required maxlength="1000" class="min-w-0 flex-1 rounded-xl p-3 border border-zinc-200" placeholder="输入健康问题"><button class="bg-zinc-900 text-white rounded-xl px-4 font-bold">发送</button></form>`);
    $('tab-meds').innerHTML = P.notice('用药计划尚未接入','原页面的药品清单和打卡仅为演示内容，当前后端未保存用药计划。') + P.card('今日可用计划',todos.length ? todos.map(t=>`<div class="flex items-center justify-between gap-3 border-b border-zinc-100 py-3"><span class="text-sm">${P.esc(t.title)} · ${P.esc(t.time||'')}</span>${!t.completed?P.btn('完成',`todo:${t.id}`):'<span class="text-emerald-700 text-sm">已完成</span>'}</div>`).join('') : '<p class="text-zinc-500 text-sm">暂无计划</p>');
    $('tab-trends').innerHTML = '<div id="pro-trends" class="space-y-4"><p class="text-sm text-zinc-500">正在读取测量记录…</p></div>';
    $('tab-care').innerHTML = P.card('提醒与家人授权',`<p class="text-xs text-zinc-500 mb-3">提醒来自服务端。授权码只交给指定家属或医生。</p><div class="space-y-2">${alerts.length?alerts.map(a=>`<div class="rounded-xl bg-white/70 p-3"><strong>${P.esc(a.title)}</strong><p class="text-sm text-zinc-600">${P.esc(a.message)}</p><p class="text-xs text-zinc-400">${P.esc(P.date(a.created_at))}</p></div>`).join(''):'<p class="text-sm text-zinc-500">暂无提醒</p>'}</div><div class="mt-4 flex gap-2 flex-wrap">${user.role==='senior'?P.btn('生成家属授权码','invite'):''}${P.btn('刷新提醒','refresh',true)}</div><p id="pro-invite-code" class="text-sm mt-3 font-bold"></p>`);
    $('tab-profile').innerHTML = P.card('个人资料',line('姓名',user.name)+line('角色',user.role==='senior'?'老人':user.role==='caregiver'?'家属':user.role==='doctor'?'医生':user.role)+line('年龄',user.age||'未填写')+`<div class="mt-4 flex gap-2 flex-wrap">${P.btn('切换字号','font')}${P.btn('退出登录','logout',true)}</div>`);
    $('tab-profile').innerHTML += P.card('更多健康服务', '<div class="grid gap-2 text-sm font-bold"><a class="rounded-xl bg-white/70 p-3" href="/profile.html?desktop=1">完善资料与账号安全 ›</a><a class="rounded-xl bg-white/70 p-3" href="/privacy.html?desktop=1">隐私和数据管理 ›</a><a class="rounded-xl bg-white/70 p-3" href="/assessment.html?desktop=1">查看健康评估 ›</a><a class="rounded-xl bg-white/70 p-3" href="/knowledge.html?desktop=1">健康知识 ›</a></div>');
    $('tab-overview').innerHTML += '<div id="pro-overview-chart"></div>';
    switchTab(currentTab);
    loadTrends();
    $('pro-chat-form').addEventListener('submit', async e => {e.preventDefault(); const input=e.target.elements.message, msg=input.value.trim(); if (!msg)return; input.value=''; const box=$('pro-chat'); const bubble=document.createElement('div'); bubble.className='rounded-xl bg-zinc-100 p-3 text-sm'; bubble.textContent='我：'+msg; box.append(bubble); try {const result=await P.post('/api/chat',{message:msg}); const answer=document.createElement('div'); answer.className='rounded-xl bg-white p-3 text-sm'; answer.textContent=`小康：${result.content||'暂无回复'}${result.llm?.call_status==='mock'?'（演示模式）':''}`; box.append(answer);}catch(error){showError(error);} });
  }
  async function loadTrends() {
    const box = $('pro-trends');
    if (!box) return;
    const types = [['bp', '血压', 'mmHg'], ['glucose', '血糖', 'mmol/L'], ['hr', '心率', 'bpm'], ['steps', '步数', '步'], ['sleep', '睡眠', '小时']];
    const results = await Promise.allSettled(types.map(([type]) => P.get(`/api/trend/${type}?days=90`)));
    if (!box.isConnected) return;
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
  document.addEventListener('click',async e=>{const action=e.target.closest('[data-pro-action]')?.dataset.proAction; if(!action)return; try {if(action==='measure'){const high=prompt('收缩压 mmHg（留空跳过）',''); const low=high?prompt('舒张压 mmHg',''):null; const glucose=prompt('血糖 mmol/L（留空跳过）',''); if(!high&&!glucose)return; if(high){if(!low)throw Error('请填写舒张压'); await P.post('/api/health/metrics',{type:'bp',value:Number(high),value2:Number(low),unit:'mmHg',source:'manual',measurement_condition:'unknown'});} if(glucose)await P.post('/api/health/metrics',{type:'glucose',value:Number(glucose),unit:'mmol/L',source:'manual',measurement_condition:'unknown'}); await load(); toast('测量已保存');} else if(action==='invite'){const result=await P.post('/api/care/invitations',{member_role:'caregiver'}); $('pro-invite-code').textContent=`家属授权码：${result.code}（7 天内使用）`; } else if(action.startsWith('todo:')){await P.patch('/api/todos/'+action.split(':')[1],{completed:true});await load();switchTab('meds');} else if(action==='refresh')await load(); else if(action==='logout')await window.handleLogout(); else if(action==='font')window.cycleFontSize(); else if(panes.includes(action))switchTab(action);}catch(error){showError(error);} });
  panes.forEach(id=>{$('tab-'+id).innerHTML=P.notice('正在连接健康服务','请稍候…');});
  load();
})();

