// Shared client for the Pro pages. All health data comes from authenticated APIs.
(function () {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      ...options,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  const get = url => request(url);
  const post = (url, body) => request(url, {method:'POST', body});
  const patch = (url, body) => request(url, {method:'PATCH', body});
  const date = value => value ? new Date(value).toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '暂无';
  const metric = (row, type) => !row ? '暂无记录' : type === 'bp' ? `${row.value}/${row.value2} mmHg` : `${row.value} ${row.unit || (type === 'glucose' ? 'mmol/L' : type === 'hr' ? '次/分' : '')}`;
  const notice = (title, detail) => `<div class="glass-card rounded-[26px] p-6 text-zinc-800"><h3 class="text-lg font-black mb-2">${esc(title)}</h3><p class="text-sm leading-relaxed text-zinc-500">${esc(detail)}</p></div>`;
  const card = (title, body, extra = '') => `<section class="glass-card rounded-[26px] p-5 ${extra}"><h3 class="text-base font-black text-zinc-900 mb-3">${esc(title)}</h3>${body}</section>`;
  const btn = (label, action, secondary = false) => `<button type="button" data-pro-action="${esc(action)}" class="px-4 py-2.5 rounded-xl ${secondary ? 'bg-zinc-100 text-zinc-800' : 'bg-zinc-900 text-white'} font-bold text-sm">${esc(label)}</button>`;
  window.Pro = {esc, request, get, post, patch, date, metric, notice, card, btn};
})();
