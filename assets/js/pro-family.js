(function () {
  'use strict';
  const P=window.Pro, V=window.ProVoiceSummary, $=id=>document.getElementById(id);
  const views=['overview','ai-agent','medication','trends','safety','records'];
  let user=null, subjects=[], selected=null, currentView='overview';
  const voiceChoices=new Set(['zf_001','zf_002','zm_009']);
  let voiceAudio=null, voiceRequest=null, voiceUrl=null;
  function setVoiceLabel(label,pressed=false){if($('familyVoiceLabel'))$('familyVoiceLabel').textContent=label;$('familyVoiceActionBtn')?.setAttribute('aria-pressed',String(pressed));}
  function stopVoice(){voiceRequest?.abort();voiceRequest=null;if(voiceAudio){voiceAudio.pause();voiceAudio.src='';voiceAudio=null;}if(voiceUrl){URL.revokeObjectURL(voiceUrl);voiceUrl=null;}setVoiceLabel('朗读重点');}
  async function speakVoice(text){
    stopVoice();
    const excerpt=V.excerpt(text);
    if(!excerpt){toast('当前页面没有可朗读内容');return;}
    const controller=new AbortController();voiceRequest=controller;setVoiceLabel('准备中',true);
    try{
      const saved=localStorage.getItem('pro-local-voice');
      const voice=voiceChoices.has(saved)?saved:'zf_001';
      const response=await fetch('/api/voice/speech',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({text:excerpt,voice})});
      if(!response.ok)throw Error('本机自然语音暂时不可用');
      const blob=await response.blob();if(controller.signal.aborted)return;
      voiceRequest=null;voiceUrl=URL.createObjectURL(blob);
      const audio=new Audio(voiceUrl);voiceAudio=audio;
      audio.onended=()=>{if(voiceAudio===audio)stopVoice();};
      audio.onerror=()=>{if(voiceAudio===audio){stopVoice();toast('音频播放失败');}};
      await audio.play();setVoiceLabel('停止',true);
    }catch(error){if(controller.signal.aborted)return;console.warn('[family-local-voice]',error.name,error.message);stopVoice();toast('本机语音暂不可用，请稍后重试');}
  }
  window.handleFamilyVoiceButtonClick=function(){
    if(voiceRequest||voiceAudio){stopVoice();return;}
    const answers=$('pro-family-chat')?.querySelectorAll('.pro-family-answer');
    const answer=answers?.length?answers[answers.length-1].textContent.replace(/^小康：/,''):'';
    speakVoice(V.summarizeFamily(currentView,selected,answer));
  };
  function toast(message){if($('toastMsg'))$('toastMsg').textContent=message;const node=$('toast');node?.classList.remove('opacity-0','pointer-events-none');setTimeout(()=>node?.classList.add('opacity-0','pointer-events-none'),3000);}
  function errorMessage(error){toast(error.message||'操作失败');}
  function switchView(view){if(currentView!==view)stopVoice();currentView=view;views.forEach(id=>{ $('view-'+id)?.classList.toggle('hidden',id!==view);$('nav-'+id)?.classList.toggle('tab-active',id===view); });}
  window.switchView=switchView;
  window.openModal=function(id){if(id==='addElderlyModal')bindSenior();else toast('此操作尚未接入服务');};
  window.closeModal=function(id){$(id)?.classList.add('hidden');};
  window.refreshElderlyData=async function(){await load();toast('已从服务端刷新');};
  window.openRemoteCallModal=function(){sendReminder();};
  async function bindSenior(){const code=prompt('请输入长辈本人生成的 10 位家属授权码');if(!code)return;try{await P.post('/api/care/accept',{code:code.trim()});await load();toast('已获得长辈授权');}catch(error){errorMessage(error);}}
  async function sendReminder(){if(!selected)return;const value=prompt(`给 ${selected.senior.name} 发送提醒（会存入长辈通知）`,'请记得按计划完成今天的健康任务');if(!value)return;try{await P.post(`/api/care/seniors/${selected.senior.id}/reminders`,{message:value});toast('提醒已记录在长辈通知中');}catch(error){errorMessage(error);}}
  function renderList(){const box=$('elderlyListContainer');box.replaceChildren();$('elderlyCount').textContent=subjects.length;subjects.forEach(card=>{const button=document.createElement('button');button.type='button';button.className=`w-full p-3 rounded-2xl text-left text-sm ${selected?.senior.id===card.senior.id?'bg-white shadow-apple-card':'hover:bg-white/60'}`;button.textContent=`${card.senior.name} · ${card.senior.age||'年龄未填'}岁`;button.addEventListener('click',()=>{selected=card;renderList();render();});box.append(button);});if(!subjects.length)box.innerHTML='<p class="text-xs text-zinc-500 p-3">尚无已授权长辈。请先取得长辈授权码。</p>';}
  const list=(rows,render)=>rows?.length?rows.map(render).join(''):'<p class="text-sm text-zinc-500">暂无记录</p>';
  const metricRow=row=>`<div class="rounded-xl bg-white/70 p-4"><strong>${P.esc(({bp:'血压',glucose:'血糖',hr:'心率',spo2:'血氧'})[row.type]||row.type)}</strong><p class="text-xl font-black mt-1">${P.esc(P.metric(row,row.type))}</p><p class="text-xs text-zinc-400">${P.esc(P.date(row.recorded_at))}</p></div>`;
  function renderDashboard(c) {
    const name = c.senior.name;
    const metrics = c.recent_health || [];
    const alertRows = c.severe_alerts || [];
    const retestRows = c.overdue_retests || [];
    const plans = c.active_interventions || [];
    const executions = c.recent_execution || [];
    const count = Number(c.data_points_30d) || 0;
    const metricName = {bp:'血压',glucose:'血糖',hr:'心率',spo2:'血氧',weight:'体重',sleep:'睡眠',steps:'步数'};
    const metricTiles = metrics.length ? `<div class="pro-metric-grid">${metrics.map(row => `<div class="pro-metric-tile"><span>${P.esc(metricName[row.type] || row.type)}</span><strong>${P.esc(P.metric(row,row.type))}</strong><small>最近测量 · ${P.esc(P.date(row.recorded_at))}</small></div>`).join('')}</div>` : '<div class="pro-family-empty">授权范围内暂无近期体征记录。</div>';
    const hero = (title, detail, stats) => `<section class="pro-family-hero"><div><span class="pro-chart-kicker">长寿康 FAMILY PRO</span><h2>${P.esc(title)}</h2><p>${P.esc(detail)}</p></div><div class="pro-hero-stats">${stats.map(([value,label])=>`<div><strong>${P.esc(value)}</strong><span>${P.esc(label)}</span></div>`).join('')}</div></section>`;
    const section = (title, content) => `<section class="pro-section"><h3>${P.esc(title)}</h3>${content}</section>`;
    const empty = message => `<div class="pro-family-empty">${P.esc(message)}</div>`;
    const alerts = alertRows.length ? alertRows.map(row => `<div class="pro-alert-item"><strong>${P.esc(row.title)}</strong><small>${P.esc(P.date(row.created_at))}</small></div>`).join('') : empty('当前没有待处理的严重预警。');
    const retests = retestRows.length ? retestRows.map(row => `<div class="pro-alert-item"><strong>${P.esc(metricName[row.metric_type] || row.metric_type)}复测</strong><small>到期 ${P.esc(P.date(row.due_at))}</small></div>`).join('') : empty('当前没有到期的复测安排。');
    const chart = window.ProCharts.bars({ title: '指标记录分布', counts: c.metric_counts_30d || [], total: count });
    const latestAt = metrics.map(row => Date.parse(row.recorded_at)).filter(Number.isFinite).sort((a,b)=>b-a)[0];
    const freshness = latestAt ? `最近一次测量：${new Date(latestAt).toLocaleDateString('zh-CN')}` : '暂无近期测量';
    $('deviceBatteryStatus').textContent = `近 30 天 ${count} 条记录`;
    $('lastSyncTime').textContent = new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
    $('view-overview').innerHTML = hero(`${name}的健康概览`, freshness, [[count,'近 30 天记录'],[metrics.length,'有数据指标'],[alertRows.length + retestRows.length,'待关注事项']])
      + `<div class="pro-family-grid">${section('最新体征',metricTiles)}${chart}</div>`
      + `<div class="pro-status-grid">${section('严重预警',alerts)}${section('复测安排',retests)}</div>`;
    $('view-trends').innerHTML = hero('健康数据概况', '根据长辈授予的摘要权限展示。图表统计记录次数。', [[count,'近 30 天记录'],[c.metric_counts_30d?.length || 0,'记录类别']])
      + `<div class="pro-family-grid">${chart}${section('最新指标快照',metricTiles)}</div>`
      + section('数据权限说明', '<p class="text-sm text-zinc-500 leading-relaxed">家属账号可查看授权的近期摘要和记录分布。完整测量数值曲线需要对应的趋势权限；这里不会用演示数据补画。</p>');
    $('view-medication').innerHTML = hero('改善计划与执行', '显示后端已保存的计划和执行记录。', [[plans.length,'进行中计划'],[executions.length,'最近执行']])
      + `<div class="pro-family-grid">${section('进行中的计划',plans.length ? plans.map(row => `<div class="pro-alert-item"><strong>${P.esc(row.title)}</strong><small>状态：${P.esc(row.status)}</small></div>`).join('') : empty('暂无已授权的改善计划。'))}${section('最近执行',executions.length ? executions.map(row => `<div class="pro-alert-item"><strong>${P.esc(row.title)}</strong><small>${row.performed?'已执行':'未执行'} · ${P.esc(P.date(row.performed_at))}</small></div>`).join('') : empty('暂无已保存的执行记录。'))}</div>`;
    $('view-safety').innerHTML = hero('提醒与复测', '严重预警和到期复测来自授权范围内的后端记录。', [[alertRows.length,'严重预警'],[retestRows.length,'到期复测']])
      + `<div class="pro-status-grid">${section('需要关注的预警',alerts)}${section('待处理复测',retests)}</div>`;
    $('view-records').innerHTML = hero('健康记录', '查看已授权的近期测量摘要和记录构成。', [[count,'近 30 天记录'],[metrics.length,'有数据指标']])
      + `<div class="pro-family-grid">${section('最新测量',metricTiles)}${chart}</div>`;
  }
  function render(){stopVoice();if(!selected){$('currentElderlyTitle').textContent='尚未绑定长辈';$('currentStatusBadge').textContent='等待授权';$('deviceBatteryStatus').textContent='暂无设备状态';views.forEach(id=>$('view-'+id).innerHTML=P.notice('等待长辈授权','请在长辈端生成家属授权码，再点击左侧“绑定新长辈”。'));switchView(currentView);return;}
    const c=selected, name=c.senior.name, caps=c.capabilities||{}, metrics=c.recent_health||[];
    $('currentElderlyTitle').textContent=name;$('currentStatusBadge').textContent=c.authorization?.effective_status==='active'?'授权有效':'授权已失效';$('deviceBatteryStatus').textContent='设备电量暂无接口';$('lastSyncTime').textContent='服务端数据';
    $('view-overview').innerHTML=P.card(`${name} · 健康摘要`, `<p class="text-sm text-zinc-600">最近 30 天记录 ${P.esc(c.data_points_30d??'—')} 条。${c.data_missing?.length?'尚缺 '+P.esc(c.data_missing.join('、'))+' 数据。':''}</p><div class="grid grid-cols-2 gap-3 mt-4">${list(metrics,metricRow)}</div><div class="mt-4">${caps.remind_execution?P.btn('发送执行提醒','remind'):''}</div>`)+P.card('需要关注',`<div class="grid grid-cols-2 gap-3"><div><strong>严重预警</strong>${list(c.severe_alerts,a=>`<p class="text-sm py-2">${P.esc(a.title)} · ${P.esc(P.date(a.created_at))}</p>`)}</div><div><strong>待复测</strong>${list(c.overdue_retests,r=>`<p class="text-sm py-2">${P.esc(r.metric_type)} · ${P.esc(P.date(r.due_at))}</p>`)}</div></div>`);
    $('view-trends').innerHTML=P.card('最近测量',`<p class="text-xs text-zinc-500 mb-3">当前家属授权仅提供近期摘要。完整趋势需医生角色及相应授权。</p><div class="grid grid-cols-2 lg:grid-cols-4 gap-3">${list(metrics,metricRow)}</div>`);
    $('view-safety').innerHTML=P.card('严重预警',list(c.severe_alerts,a=>`<div class="rounded-xl bg-red-50 p-3 my-2"><strong>${P.esc(a.title)}</strong><p class="text-xs text-zinc-500">${P.esc(P.date(a.created_at))}</p></div>`))+P.card('复测安排',list(c.overdue_retests,r=>`<div class="rounded-xl bg-white p-3 my-2">${P.esc(r.metric_type)} · ${P.esc(r.status)} · ${P.esc(P.date(r.due_at))}</div>`));
    $('view-medication').innerHTML=P.notice('药品库存与配送尚未接入','原页面的药品、服药打卡和下单数据为视觉演示；目前可查看后端已保存的改善计划执行情况。')+P.card('改善计划',list(c.active_interventions,i=>`<div class="rounded-xl bg-white p-3 my-2"><strong>${P.esc(i.title)}</strong><p class="text-xs text-zinc-500">状态：${P.esc(i.status)}</p></div>`))+P.card('最近执行',list(c.recent_execution,i=>`<p class="text-sm border-b py-2">${P.esc(i.title)} · ${i.performed?'已执行':'未执行'} · ${P.esc(P.date(i.performed_at))}</p>`));
    $('view-records').innerHTML=P.notice('门诊与体检文件尚未接入','原页面中的医院、报告和影像均为演示内容。当前版本只显示后端已记录的健康指标与授权摘要。')+P.card('已授权数据',`<div class="grid grid-cols-2 gap-3">${list(metrics,metricRow)}</div>`);
    $('view-ai-agent').innerHTML=caps.use_agent?P.card(`${name} · 智能健康管家`,`<p class="text-xs text-zinc-500 mb-3">回答由原后端生成，并按当前授权范围读取长辈数据。</p><div id="pro-family-chat" class="space-y-2 max-h-80 overflow-y-auto mb-3"></div><form id="pro-family-chat-form" class="flex gap-2"><input name="message" required maxlength="1000" class="flex-1 rounded-xl border p-3" placeholder="输入健康问题"><button class="bg-zinc-900 text-white px-5 rounded-xl">发送</button></form>`):P.notice('智能管家未授权','请让长辈授予“使用智能管家”权限。');
    renderDashboard(c);
    $('pro-family-chat-form')?.addEventListener('submit',async e=>{e.preventDefault();const field=e.target.elements.message,msg=field.value.trim();if(!msg)return;field.value='';const box=$('pro-family-chat');const q=document.createElement('p');q.className='bg-zinc-100 rounded-xl p-3 text-sm';q.textContent='我：'+msg;box.append(q);try{const result=await P.post('/api/chat',{message:msg,subject_user_id:c.senior.id});const a=document.createElement('p');a.className='pro-family-answer bg-white rounded-xl p-3 text-sm';a.textContent='小康：'+(result.content||'暂无回复');box.append(a);}catch(error){errorMessage(error);}});
    switchView(currentView);
  }
  async function load(){try{user=await P.get('/api/auth/me');if(user.role==='senior'){location.replace('/mobile');return;}if(!['caregiver','doctor'].includes(user.role))throw Error('该页面仅供家属或医生账号使用');const response=await P.get('/api/care/subjects');subjects=response.items||[];selected=subjects.find(x=>x.senior.id===selected?.senior.id)||subjects[0]||null;const footer=document.querySelector('aside > div:last-child');if(footer)footer.innerHTML=`<div><p class="text-xs font-bold">${P.esc(user.name)}</p><p class="text-xs text-zinc-500">${user.role==='doctor'?'医生':'家属'}账号</p></div><button data-pro-action="logout" class="text-xs underline">退出</button>`;renderList();render();}catch(error){if(error.status===401){location.replace('/login.html?next=%2Ffamily');return;}views.forEach(id=>$('view-'+id).innerHTML=P.notice('连接失败',error.message));}}
  document.addEventListener('click',async e=>{const action=e.target.closest('[data-pro-action]')?.dataset.proAction;if(!action)return;if(action==='remind')sendReminder();else if(action==='logout'){try{await P.post('/api/auth/logout',{});location.replace('/login.html?next=%2Ffamily');}catch(error){errorMessage(error);}}});
  views.forEach(id=>$('view-'+id).innerHTML=P.notice('正在连接健康服务','请稍候…'));
  load();
})();
