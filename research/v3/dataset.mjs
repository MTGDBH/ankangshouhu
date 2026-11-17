import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

export const DATASET_VERSION = 'temporal-memory-synthetic.v1';
const dataDir = new URL('./data/', import.meta.url);
const DAY = 86_400_000;
const phases = {
  validation: { year: 2025, month: 4, tones: ['请调出', '我想了解', '麻烦核对', '给我读读', '帮我回顾', '请帮忙比较'] },
  test: { year: 2026, month: 10, tones: ['回头看一下', '翻一下', '请列出来', '帮我找找', '我想再看看', '能帮我核实吗'] },
};
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const start = (year, month, day) => Date.UTC(year, month - 1, day, -8);
const title = { bp: '血压', glucose: '血糖', weight: '体重', hr: '心率' };
const metricList = Object.keys(title);

export function buildDataset() {
  const cases = [];
  for (const [split, phase] of Object.entries(phases)) {
    for (let variant = 0; variant < phase.tones.length; variant++) {
      const { year, month } = phase;
      const metric = metricList[variant % metricList.length];
      const other = metricList[(variant + 1) % metricList.length];
      const label = title[metric];
      const previous = { from: start(year, month - 1, 1), to: start(year, month, 1) };
      const current = { from: start(year, month, 1), to: start(year, month + 1, 1) };
      const now = start(year, month, 23) + variant * 3_600_000;
      const make = (id, text, time, more = {}) => ({
        id, key: id, revision: 1, kind: 'event', metric, text, at: time, quality: 0.75, source: 'manual', ...more,
      });
      const add = (family, { query, windows = [], location = windows, kinds, items, gold, historical = !!windows.length, suggestion, status = 'answer' }) => {
        const id = [split, family, variant + 1].join('-');
        const localId = code => id + '/' + code;
        const annotated = items.map(item => ({ ...item, id: localId(item.id), key: localId(item.key), refs: [localId('ref-' + item.id)] }));
        cases.push({ id, split, family, subject_id: id + '/subject', household_id: id + '/household',
          template_id: split + '/' + family + '/' + variant, query: phase.tones[variant] + query + '。', now,
          metric: kinds?.includes('profile') ? null : metric, windows, location, kinds, historical, items: annotated, gold: gold.map(localId),
          expected_decision: status, ...(suggestion ? { expected_suggestion: suggestion } : {}) });
      };
      const readings = label + ' 读数 测量 记录';
      const trend = label + ' 趋势 变化 比较 走势';
      const feedback = label + ' 计划反馈 调整建议 执行反馈';
      const prefer = '档案记忆 已确认的偏好 提醒设置';
      const prior = previous.from + (10 + variant) * DAY;
      const recent = now - (1 + variant) * DAY;
      const outOfDate = now - (46 + variant) * DAY;

      add('past-month', { query: '上月的' + label + '趋势', windows: [previous], kinds: ['trend'],
        items: [make('manual', trend, previous.from, { kind: 'trend', end: previous.to, source: 'device' }),
          make('today', '上月 ' + trend, current.from, { kind: 'trend', end: current.to, quality: 1 }),
          make('unrelated', '上月趋势 ' + title[other], previous.from, { metric: other, kind: 'trend', end: previous.to })], gold: ['manual'] });
      add('two-months', { query: '上月和本月的' + label + '变化', windows: [previous, current], kinds: ['trend'],
        items: [make('first', trend, previous.from, { kind: 'trend', end: previous.to }),
          make('second', trend, current.from, { kind: 'trend', end: current.to }),
          make('wrong-metric', '上月和本月 ' + trend, previous.from, { metric: other, kind: 'trend', end: previous.to }),
          make('wrong-source', '上月和本月 ' + trend, current.from, { kind: 'event' })], gold: ['first', 'second'] });
      const precise = { from: start(year, month, 15), to: start(year, month, 16) };
      add('time-boundary', { query: year + '年' + month + '月15日的' + label + '测量记录', windows: [precise], kinds: ['event'],
        items: [make('next', readings, precise.to, { quality: 0.99 }), make('earlier', readings, precise.from - 1000),
          make('inside', readings, precise.from + 1000)], gold: ['inside'] });
      add('current-expiry', { query: '当前仍有效的' + label + '测量记录', kinds: ['event'],
        items: [make('old', label + ' 当前仍有效的测量记录', outOfDate, { quality: 1, source: 'device' }),
          make('recent', readings, recent, { quality: 0.52 }), make('future', readings, now + DAY, { quality: 1 })], gold: ['recent'] });
      add('decay', { query: '现在的' + label + '测量记录', kinds: ['event'],
        items: [make('aa', readings, now - 29 * DAY), make('bb', readings, now - 22 * DAY),
          make('cc', readings, now - 17 * DAY), make('zz', readings, now - DAY)], gold: ['zz'] });
      add('source-quality', { query: '本月' + label + '趋势记录', windows: [current], kinds: ['trend'],
        items: [make('aa-unreliable', '本月' + trend + '记录', current.from, { kind: 'trend', end: current.to, quality: 0.19, source: 'unknown' }),
          make('zz-checked', trend, current.from, { kind: 'trend', end: current.to, quality: 0.96, source: 'device' })], gold: ['zz-checked'] });
      add('conflict', { query: '本月的' + label + '记录', windows: [current], kinds: ['event'],
        items: [make('collision', '本月的' + readings, recent, { status: 'conflict', quality: 0.98 }),
          make('old-record', readings, prior)], gold: [], status: 'clarify_conflict' });
      add('conflict-with-independent', { query: '本月的' + label + '记录', windows: [current], kinds: ['event'],
        items: [make('collision', '本月的' + readings, recent, { status: 'conflict', quality: 0.98 }),
          make('independent', readings, recent - DAY, { quality: 0.64 })], gold: [], status: 'clarify_conflict' });
      add('expired-profile', { query: '已确认的偏好和档案记忆', kinds: ['profile'],
        items: [make('expired', prefer, outOfDate, { kind: 'profile', metric: null, expires: now - DAY }),
          make('candidate', prefer, now - DAY, { kind: 'profile', metric: null, status: 'removed' })], gold: [], status: 'abstain' });
      add('correction', { query: '本月的' + label + '记录', windows: [current], kinds: ['event'],
        items: [make('a-wrong', '本月的' + readings, recent, { key: 'same', status: 'superseded', quality: 1 }),
          make('z-fixed', readings, recent, { key: 'same', revision: 2, quality: 0.7 })], gold: ['z-fixed'] });
      add('retained-history', { query: '上月的' + label + '测量记录', windows: [previous], kinds: ['event'],
        items: [make('at-the-time', readings, prior, { key: 'time_series' }),
          make('later-event', readings, recent, { key: 'time_series', revision: 2 })], gold: ['at-the-time'] });
      add('missing-time', { query: '以前的' + label + '历史记录', kinds: ['event'],
        items: [make('seen', readings, recent)], gold: [], status: 'clarify_time' });
      add('feedback-schedule', { query: '根据上次计划反馈给出' + label + '调整建议', kinds: ['feedback'],
        items: [make('wrong-old', feedback, now - 160 * DAY, { kind: 'feedback', quality: 1, recorded: 4, skips: 0, matchedOutcome: true }),
          make('new', feedback, recent, { kind: 'feedback', recorded: 3, skips: 2, burden: 'schedule' })],
        gold: ['new'], suggestion: 'review_schedule' });
      add('feedback-discomfort', { query: '根据上次计划反馈给出' + label + '调整建议', kinds: ['feedback'],
        items: [make('active', feedback, recent, { kind: 'feedback', recorded: 2, skips: 1, burden: 'discomfort' }),
          make('general', readings, recent, { kind: 'event', quality: 1 })], gold: ['active'], suggestion: 'review_discomfort' });
      add('feedback-recheck', { query: '根据上次计划反馈给出' + label + '调整建议', kinds: ['feedback'],
        items: [make('active', feedback, recent, { kind: 'feedback', recorded: 6, skips: 0 })], gold: ['active'], suggestion: 'await_recheck' });
      add('feedback-maintain', { query: '根据上次计划反馈给出' + label + '调整建议', kinds: ['feedback'],
        items: [make('active', feedback, recent, { kind: 'feedback', recorded: 6, skips: 0, matchedOutcome: true })], gold: ['active'], suggestion: 'review_with_user' });
      add('feedback-missing', { query: '根据上次计划反馈给出' + label + '调整建议', kinds: ['feedback'],
        items: [make('active', feedback, recent, { kind: 'feedback', recorded: 0, skips: 0 })], gold: ['active'], suggestion: 'collect_feedback' });
    }
  }
  return cases;
}

function audit(cases) {
  const unique = field => new Set(cases.map(row => row[field])).size === cases.length;
  const fromValidation = new Set(cases.filter(row => row.split === 'validation').map(row => row.query));
  const test = cases.filter(row => row.split === 'test');
  const exactQueryOverlap = test.filter(row => fromValidation.has(row.query)).length;
  if (!['id', 'subject_id', 'household_id', 'template_id'].every(unique) || exactQueryOverlap) throw new Error('Cross-split identity or query reuse');
  return { version: DATASET_VERSION, counts: { validation: cases.length - test.length, test: test.length }, digest: sha(cases), exact_query_overlap: exactQueryOverlap };
}

const data = buildDataset();
const manifest = audit(data);
mkdirSync(dataDir, { recursive: true });
writeFileSync(new URL('cases.jsonl', dataDir), data.map(row => JSON.stringify(row)).join('\n') + '\n');
writeFileSync(new URL('splits.json', dataDir), JSON.stringify({ ...manifest, validation: data.filter(row => row.split === 'validation').map(row => row.id),
  test: data.filter(row => row.split === 'test').map(row => row.id) }, null, 2) + '\n');
console.log(JSON.stringify(manifest));
