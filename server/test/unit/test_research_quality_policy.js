import assert from 'node:assert/strict';
import { decideResearchCase, assessQuality, researchRisk } from '../../src/ai/qualityPolicy.js';
import { auditDataset, generateDataset } from '../../../research/v2/dataset.mjs';

const cases = generateDataset();
const check = auditDataset(cases);
assert.equal(check.violations.length, 0);
assert.deepEqual(check.counts, { train: 63, validation: 42, test: 84 });
const input = id => cases.find(row => row.id === id);
const calibration = ['missing','unit_error','conflict','unknown_source','mixed_conditions','stale'];
for (const label of calibration) {
  const row = input('validation-' + label + '-0');
  const plan = decideResearchCase(row);
  assert(plan.quality?.issues.includes(label), label);
  assert.notEqual(plan.decision, 'answer', label);
  assert(plan.quality.features.freshness >= 0 && plan.quality.features.freshness <= 1);
}
const general = decideResearchCase({ question:'血压计的测量条件一般怎么登记？', events:[], asOf:'2026-10-01T12:00:00Z' });
assert.deepEqual(general.tools, ['retrieve_knowledge']);
assert.equal(general.quality, null);
const complete = input('validation-regular-1');
const valid = decideResearchCase(complete);
assert.equal(valid.decision, 'answer');
assert.deepEqual(valid.tools, ['get_metric_trend']);
const mixed = input('validation-conflict-0');
const quality = assessQuality({ ...mixed, task:'trend', metric:mixed.events[0].type, days:30 });
assert(quality.evidence_ids.length < mixed.events.length);
assert.equal(decideResearchCase(complete, { risk:false }).decision, 'answer');
assert.equal(researchRisk('没有胸痛，我想看记录'), 'routine');
assert.equal(decideResearchCase({ question:'我现在有胸痛，可以先查看吗？', events:[], asOf:complete.asOf }).decision, 'escalate');
assert.equal(decideResearchCase({ question:'想知道是否能自己减量吃药', events:[], asOf:complete.asOf }).decision, 'limit');
console.log('V2 research policy PASS: dimension labels, independent sample splits, evidence boundaries, emergency and medication gate');
