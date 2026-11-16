// Small, dependency-free charts for authenticated Pro health data.
(function () {
  'use strict';
  const esc = value => window.Pro.esc(value);
  const names = { bp: '血压', glucose: '血糖', hr: '心率', spo2: '血氧', weight: '体重', sleep: '睡眠', steps: '步数', temp: '体温', resp: '呼吸频率', grip: '握力', bodyfat: '体脂率', waist: '腰围', uricacid: '尿酸', cholesterol: '胆固醇', hba1c: '糖化血红蛋白', egfr: 'eGFR', creatinine: '肌酐', urine_albumin: '尿白蛋白' };
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '时间未知' : parsed.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };
  const number = value => Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
  function smoothPath(points) {
    if (points.length < 2) return '';
    const slopes = points.slice(1).map((point, index) => {
      const previous = points[index];
      const distance = point.x - previous.x;
      return distance > 0 ? (point.y - previous.y) / distance : 0;
    });
    const tangents = points.map((_, index) => {
      if (index === 0) return slopes[0];
      if (index === points.length - 1) return slopes.at(-1);
      const before = slopes[index - 1], after = slopes[index];
      return before * after <= 0 ? 0 : Math.sign(before) * Math.min(Math.abs(before), Math.abs(after));
    });
    const clamp = (value, first, second) => Math.max(Math.min(first, second), Math.min(Math.max(first, second), value));
    return points.slice(1).reduce((path, point, index) => {
      const previous = points[index], distance = point.x - previous.x;
      if (distance <= 0) return `${path} L${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      const control1 = clamp(previous.y + tangents[index] * distance / 3, previous.y, point.y);
      const control2 = clamp(point.y - tangents[index + 1] * distance / 3, previous.y, point.y);
      return `${path} C${(previous.x + distance / 3).toFixed(1)},${control1.toFixed(1)} ${(point.x - distance / 3).toFixed(1)},${control2.toFixed(1)} ${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    }, `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`);
  }

  function line({ title, points = [], unit = '', secondary = false, note = '' }) {
    const safe = points.filter(row => row.value != null && row.value !== '' && Number.isFinite(Number(row.value)) && !Number.isNaN(Date.parse(row.recorded_at))).slice().sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
    const heading = `<div class="pro-chart-heading"><div><span class="pro-chart-kicker">测量趋势</span><h3>${esc(title)}</h3></div><span class="pro-chart-count">${safe.length} 次记录</span></div>`;
    if (!safe.length) return `<section class="pro-chart" data-pro-chart="line">${heading}<div class="pro-chart-empty">暂无可绘制的测量记录。录入后，这里会自动显示趋势。</div></section>`;
    if (safe.length === 1) return `<section class="pro-chart" data-pro-chart="line">${heading}<div class="pro-chart-empty">已有 1 次测量：${esc(number(Number(safe[0].value)))} ${esc(unit)}。再记录一次后即可形成曲线。</div></section>`;
    const series = [{ key: 'value', label: secondary ? '收缩压' : title, color: '#18181b' }];
    if (secondary && safe.some(row => row.value2 != null && row.value2 !== '' && Number.isFinite(Number(row.value2)))) series.push({ key: 'value2', label: '舒张压', color: '#8a8a94' });
    const values = series.flatMap(item => safe.filter(row => row[item.key] != null && row[item.key] !== '').map(row => Number(row[item.key])).filter(Number.isFinite));
    let low = Math.min(...values), high = Math.max(...values);
    const pad = Math.max((high - low) * .15, high < 20 ? .5 : 3);
    low = Math.max(0, low - pad); high += pad;
    const width = 600, left = 42, right = 20, top = 18, bottom = 174;
    const times = safe.map(row => Date.parse(row.recorded_at));
    const first = Math.min(...times), last = Math.max(...times);
    const x = (time, index) => first === last ? left + index * (width - left - right) / Math.max(1, safe.length - 1) : left + (time - first) / (last - first) * (width - left - right);
    const y = value => bottom - (value - low) / (high - low) * (bottom - top);
    const grid = [0, .5, 1].map(fraction => {
      const yy = top + fraction * (bottom - top);
      const label = number(high - fraction * (high - low));
      return `<line x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}" stroke="#e4e4e7" stroke-dasharray="4 5"/><text x="${left - 8}" y="${yy + 4}" text-anchor="end" class="pro-chart-axis">${esc(label)}</text>`;
    }).join('');
    const curves = series.map(item => {
      const valuesForSeries = safe.map((row, index) => ({ value: row[item.key] == null || row[item.key] === '' ? NaN : Number(row[item.key]), x: x(times[index], index) })).filter(row => Number.isFinite(row.value)).map(row => ({x:row.x,y:y(row.value)}));
      const path = smoothPath(valuesForSeries);
      return path ? `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>` : '';
    }).join('');
    const latest = safe.at(-1);
    const valueLabel = secondary && latest.value2 != null && latest.value2 !== '' && Number.isFinite(Number(latest.value2)) ? `${number(Number(latest.value))}/${number(Number(latest.value2))}` : number(Number(latest.value));
    return `<section class="pro-chart" data-pro-chart="line">${heading}<div class="pro-chart-figure"><svg viewBox="0 0 600 205" role="img" aria-label="${esc(title)}最近 ${safe.length} 次测量趋势">${grid}${curves}<text x="${left}" y="198" class="pro-chart-axis">${esc(date(safe[0].recorded_at))}</text><text x="${width - right}" y="198" text-anchor="end" class="pro-chart-axis">${esc(date(latest.recorded_at))}</text></svg></div><div class="pro-chart-footer"><span>最新 <strong>${esc(valueLabel)} ${esc(unit)}</strong></span><span>${esc(date(latest.recorded_at))}</span></div>${secondary ? '<p class="pro-chart-legend"><i></i>收缩压 <i class="secondary"></i>舒张压</p>' : ''}${note ? `<p class="pro-chart-note">${esc(note)}</p>` : ''}</section>`;
  }

  function bars({ title, counts = [], total = 0 }) {
    const rows = counts.filter(row => Number(row.count) > 0).slice().sort((a, b) => Number(b.count) - Number(a.count));
    const heading = `<div class="pro-chart-heading"><div><span class="pro-chart-kicker">最近 30 天</span><h3>${esc(title)}</h3></div><span class="pro-chart-count">${Number(total) || rows.reduce((sum, row) => sum + Number(row.count), 0)} 条</span></div>`;
    if (!rows.length) return `<section class="pro-chart" data-pro-chart="bars">${heading}<div class="pro-chart-empty">暂无近 30 天记录。长辈新增测量后，这里会更新。</div></section>`;
    const max = Math.max(...rows.map(row => Number(row.count)));
    return `<section class="pro-chart" data-pro-chart="bars">${heading}<div class="pro-bars">${rows.map(row => `<div class="pro-bar-row"><span>${esc(names[row.type] || row.type)}</span><div class="pro-bar-track"><div style="width:${Math.max(4, Number(row.count) / max * 100)}%"></div></div><strong>${Number(row.count)}</strong></div>`).join('')}</div><p class="pro-chart-note">图中统计记录次数，不展示未授权的历史测量数值。</p></section>`;
  }

  window.ProCharts = { line, bars };
})();
