import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mobile = fs.readFileSync(new URL('../../../mobile.html', import.meta.url), 'utf8');
const family = fs.readFileSync(new URL('../../../family.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../../assets/js/pro-voice-summary.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(script, context);
const { summarize, summarizeFamily } = context.window.ProVoiceSummary;

assert.match(mobile, /pro-voice-summary\.js"><\/script>\s*<script src="assets\/js\/pro-mobile\.js"/);
assert.match(family, /pro-voice-summary\.js"><\/script>\s*<script src="assets\/js\/pro-family\.js"/);
assert.match(family, /id="familyVoiceActionBtn"/);
const state = {
  summary: { summary: '最近测量资料已更新。' },
  metrics: {
    bp: { value: 132, value2: 81, recorded_at: '2026-09-20T08:00:00Z' },
    glucose: { value: 6.1, recorded_at: '2026-09-21T08:00:00Z' },
  },
  todos: [{ title: '测量血压', time: '08:00', completed: false }, { title: '散步', completed: true }],
  alerts: [{ title: '血压提醒', message: '请留意最近的血压记录。' }],
  answer: '建议记录血压变化。若有明显不适，请及时就医。',
  trends: { bp: [{ value: 132, value2: 81, recorded_at: '2026-09-20T08:00:00Z' }] },
  user: { name: '张阿姨' },
  activeAuthorizations: 1,
};
const expected = {
  overview: /血压：收缩压132，舒张压81/,
  butler: /建议记录血压变化/,
  meds: /待办：08:00，测量血压/,
  trends: /血压有1次记录/,
  care: /血压提醒/,
  profile: /张阿姨/,
  account: /当前有1人获得有效授权/,
};
for (const [tab, pattern] of Object.entries(expected)) {
  const spoken = summarize(tab, state);
  assert.match(spoken, pattern, `${tab} should speak its main content`);
  assert.ok(Array.from(spoken).length <= 180, `${tab} speech exceeds local TTS limit`);
}
assert.doesNotMatch(summarize('meds', state), /散步/, 'completed tasks should not be read');
assert.doesNotMatch(summarize('butler', state), /测量血压|血压提醒/, 'butler should read the answer only');
assert.doesNotMatch(summarize('account', { ...state, password: 'secret', confirmationText: 'DELETE' }), /secret|DELETE/);
assert.match(summarize('trends', { ...state, trends: null }), /正在加载/);
assert.match(summarize('care', { ...state, alerts: [] }), /没有待处理提醒/);
const familyCard = {
  senior: { name: '张奶奶' }, capabilities: { use_agent: true }, data_points_30d: 38,
  recent_health: [{ type: 'bp', value: 141, value2: 83, recorded_at: '2026-08-29T08:00:00Z' }],
  severe_alerts: [{ title: '需要关注的预警' }], overdue_retests: [],
  active_interventions: [{ title: '散步计划' }], recent_execution: [{ title: '散步', performed: false }],
};
const familyExpected = {
  overview: /需要关注的预警/,
  'ai-agent': /建议记录血压变化/,
  medication: /散步计划/,
  trends: /血压：收缩压141/,
  safety: /需要关注的预警/,
  records: /最近三十天有38条测量记录/,
};
for (const [view, pattern] of Object.entries(familyExpected)) {
  const spoken = summarizeFamily(view, familyCard, state.answer);
  assert.match(spoken, pattern, `${view} should speak its key family content`);
  assert.ok(Array.from(spoken).length <= 180, `${view} speech exceeds local TTS limit`);
}
assert.doesNotMatch(summarizeFamily('ai-agent', { ...familyCard, capabilities: { use_agent: false } }, state.answer), /建议记录/);
assert.match(summarizeFamily('overview', null), /尚未绑定长辈/);
console.log('Mobile and family voice summaries: PASS');
