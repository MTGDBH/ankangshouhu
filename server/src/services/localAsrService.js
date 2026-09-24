import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ASR_DIR = path.join(ROOT, 'ml', 'models', 'asr');
const PYTHON = process.env.LOCAL_ASR_PYTHON || path.join(ASR_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SCRIPT = path.join(ROOT, 'server', 'scripts', 'local_asr_worker.py');
const MODEL = path.join(ASR_DIR, 'model.int8.onnx');
const TOKENS = path.join(ASR_DIR, 'tokens.txt');

let worker = null;
let pending = null;
let sequence = 0;

export function localAsrStatus() {
  return { available: [PYTHON, SCRIPT, MODEL, TOKENS].every(existsSync), engine: 'sherpa-onnx/SenseVoice', offline: true };
}

function ensureWorker() {
  if (worker) return worker;
  if (!localAsrStatus().available) throw new Error('本机语音识别尚未安装');
  const child = spawn(PYTHON, [SCRIPT], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  worker = child;
  let output = '';
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (worker === child) worker = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('本机语音识别服务已停止'));
      pending = null;
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 100_000) { child.kill(); return; }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      if (!pending || response.id !== pending.id) continue;
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      if (response.error === 'no_speech') current.reject(Object.assign(new Error('没有识别到说话声，请重试'), { code: 'NO_SPEECH' }));
      else if (response.error || !response.text) current.reject(new Error('本机语音识别失败'));
      else current.resolve(response.text);
    }
  });
  child.once('error', close);
  child.once('close', close);
  return child;
}

export function transcribeLocalAudio(audio) {
  if (pending) return Promise.reject(Object.assign(new Error('正在识别上一段录音'), { code: 'ASR_BUSY' }));
  let child;
  try { child = ensureWorker(); } catch (error) { return Promise.reject(error); }
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 45_000);
    pending = { id, resolve, reject, timer };
    child.stdin.write(`${JSON.stringify({ id, audio: audio.toString('base64') })}\n`, error => {
      if (!error || !pending || pending.id !== id) return;
      clearTimeout(timer);
      pending = null;
      reject(new Error('无法发送录音到本机识别服务'));
    });
  });
}
