import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://localhost:3001';
const readiness = await fetch(base + '/api/health').then(response => response.json());
assert.equal(readiness.mode, 'llm', '请在服务端配置模型凭据并启动隔离测试实例');

const registered = await fetch(base + '/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'V1-model-test-' + Date.now(), password: 'Test-only-123456', role: 'senior' }),
});
assert.equal(registered.status, 201);
const cookie = registered.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const response = await fetch(base + '/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ message: '请用一句话解释什么是规律作息。' }),
});
assert.equal(response.status, 200);
const result = await response.json();
const outcome = {
  provider: result.llm?.provider, model: result.llm?.model,
  call_status: result.llm?.call_status, fallback_reason: result.llm?.fallback_reason,
  output_length: result.content?.length || 0,
};
console.log(JSON.stringify(outcome));
assert.equal(outcome.call_status, 'success', '真实模型未成功返回，不能用规则降级作为通过依据');
assert(outcome.output_length > 0);
