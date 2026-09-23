// 风险资料闭环测试：保存档案后，模型输入完整度应提升。
// 自包含：自行注册账号，只依赖 run-tests.mjs 提供的隔离临时库，不依赖任何预置演示账号。
const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const name = `风险资料回归${Date.now()}`;
async function req(path, options = {}) {
  const r = await fetch(base + path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const text = await r.text();
  const body = JSON.parse(text);
  if (!r.ok) throw new Error(`${r.status}: ${body.error || text}`);
  return { body, headers: r.headers };
}
const login = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, age: 76, gender: 'female', password: '123456' }) });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const auth = { Cookie: cookie };
try {
  await req('/api/profile/me', { method: 'PUT', headers: auth, body: JSON.stringify({ education_level: 4, smoking_status: 0, cigarettes_per_day: 0, drinking_status: 0, drinking_frequency: 0, exercise_level: 120, self_rated_health: 4, chronic_diabetes: 0, chronic_heart: 0, chronic_stroke: 0, dyslipidemia: 0, lung_disease: 0 }) });
  const risk = (await req('/api/prediction/disease/hypertension', { headers: auth })).body;
  if (!risk.success || risk.data_completeness?.missing_count >= 21 || risk.data_completeness?.level === 'low') throw new Error('risk completeness did not improve');
  console.log(JSON.stringify({ pass: true, after_missing: risk.data_completeness.missing_count, completeness: risk.data_completeness.ratio }));
} finally {
  // 本文件只在隔离临时库中运行，进程结束即整库删除，无需恢复档案。
}
