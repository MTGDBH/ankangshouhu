import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MODEL_DIR = path.join(ROOT, 'ml', 'models', 'tts');
const SCRIPT = path.join(ROOT, 'server', 'scripts', 'local_voice_worker.py');
const PYTHON = process.env.LOCAL_TTS_PYTHON || path.join(MODEL_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const MODEL = path.join(MODEL_DIR, 'kokoro-v1.1-zh.fp16.onnx');
const VOICES = path.join(MODEL_DIR, 'voices-v1.1-zh.bin');
const MAX_RESPONSE_CHARS = 12_000_000;
const TIMEOUT_MS = 50_000;

let worker = null;
let sequence = 0;
const pending = new Map();

export function localVoiceStatus() {
  return { available: [PYTHON, SCRIPT, MODEL, VOICES].every(existsSync), engine: 'kokoro-onnx', offline: true };
}

function rejectPending(message) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  if (!localVoiceStatus().available) throw new Error('本机自然语音尚未安装');
  const child = spawn(PYTHON, [SCRIPT], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  worker = child;
  let closed = false;
  const closeWorker = message => {
    if (closed) return;
    closed = true;
    if (worker === child) worker = null;
    rejectPending(message);
  };
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > MAX_RESPONSE_CHARS) {
      child.kill();
      return;
    }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const request = pending.get(String(response.id));
      if (!request) continue;
      pending.delete(String(response.id));
      clearTimeout(request.timer);
      if (response.error || !response.audio) request.reject(new Error('本机语音合成失败'));
      else request.resolve(Buffer.from(response.audio, 'base64'));
    }
  });
  child.once('error', () => closeWorker('无法启动本机语音服务'));
  child.once('close', () => closeWorker('本机语音服务已停止'));
  return child;
}

export function synthesizeLocalVoice(text, voice) {
  if (pending.size >= 2) return Promise.reject(new Error('朗读任务较多，请稍后重试'));
  let child;
  try { child = ensureWorker(); } catch (error) { return Promise.reject(error); }
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, text, voice })}\n`, error => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error('本机语音服务暂时不可用'));
    });
  });
}
