import express from 'express';
import { localVoiceStatus, synthesizeLocalVoice } from '../services/localVoiceService.js';
import { localAsrStatus, transcribeLocalAudio } from '../services/localAsrService.js';

const router = express.Router();
const VOICES = new Set(['zf_001', 'zf_002', 'zm_009']);

router.get('/status', (_req, res) => res.json(localVoiceStatus()));
router.get('/input-status', (_req, res) => res.json(localAsrStatus()));

router.post('/transcribe', express.raw({ type: 'audio/wav', limit: '1mb' }), async (req, res) => {
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length < 6400 || audio.length > 650_000) {
    return res.status(400).json({ error: '录音格式或时长无效', code: 'VOICE_AUDIO_INVALID' });
  }
  if (!localAsrStatus().available) {
    return res.status(503).json({ error: '本机语音识别尚未安装', code: 'ASR_UNAVAILABLE' });
  }
  try {
    const text = await transcribeLocalAudio(audio);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ text });
  } catch (error) {
    const noSpeech = error.code === 'NO_SPEECH';
    const busy = error.code === 'ASR_BUSY';
    res.status(noSpeech ? 422 : busy ? 429 : 503).json({
      error: noSpeech || busy ? error.message : '本机语音识别失败，请稍后重试',
      code: noSpeech ? 'NO_SPEECH' : busy ? 'ASR_BUSY' : 'ASR_FAILED',
    });
  }
});

router.post('/speech', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
  const voice = typeof req.body?.voice === 'string' ? req.body.voice : 'zf_001';
  if (!text || Array.from(text).length > 180 || !VOICES.has(voice)) {
    return res.status(400).json({ error: '朗读内容或音色无效', code: 'VOICE_INPUT_INVALID' });
  }
  if (!localVoiceStatus().available) {
    return res.status(503).json({ error: '本机自然语音尚未安装', code: 'VOICE_UNAVAILABLE' });
  }
  try {
    const audio = await synthesizeLocalVoice(text, voice);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'audio/wav');
    res.send(audio);
  } catch (error) {
    const busy = error.message.includes('任务较多');
    res.status(busy ? 429 : 503).json({ error: busy ? error.message : '本机语音合成失败，请稍后重试', code: busy ? 'VOICE_BUSY' : 'VOICE_FAILED' });
  }
});

export default router;
