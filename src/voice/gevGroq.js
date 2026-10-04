/**
 * gevGroq.js — Groq + ElevenLabs voice pipeline for God's Eye View.
 *
 * Pipeline:
 *   1. MediaRecorder captures mic audio as WebM/Opus
 *   2. POST /api/groq/transcribe  → Groq Whisper STT → transcript text
 *   3. POST /api/groq/command     → Groq LLM tool-call → map actions + reply
 *   4. POST /api/elevenlabs/tts   → ElevenLabs TTS → spoken response
 *
 * Usage:
 *   - Click MIC button to start listening
 *   - Click again (or hold Space) to stop and process
 */

import { createGevActionRunner } from './gevActions.js';

const GROQ_TRANSCRIBE_URL = '/api/groq/transcribe';
const GROQ_COMMAND_URL    = '/api/groq/command';
const ELEVENLABS_TTS_URL  = '/api/elevenlabs/tts';

// ─── UI helpers ──────────────────────────────────────────────────────────────

function getUiRefs() {
  const root = document.getElementById('gev-voice-control');
  if (!root) return null;
  return {
    root,
    button:      root.querySelector('#gev-voice-button'),
    buttonLabel: root.querySelector('.gev-mic-label'),
    status:      root.querySelector('#gev-voice-status'),
    detail:      root.querySelector('#gev-voice-detail'),
    errorDetail: root.querySelector('#gev-voice-error-detail'),
    tierButton:  root.querySelector('#gev-voice-tier'),
    costValue:   root.querySelector('#gev-voice-cost-value'),
  };
}

function setUiText(ui, status, detail) {
  if (!ui) return;
  if (ui.root)   ui.root.dataset.status = status;
  if (ui.status) ui.status.textContent  = status.toUpperCase();
  if (ui.detail) { ui.detail.textContent = detail; ui.detail.title = detail; }
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class GevGroqController {
  constructor({ runner, ui }) {
    this.runner = runner;
    this.ui     = ui;
    this.status = 'idle';

    this.stream        = null;
    this.recorder      = null;
    this.audioChunks   = [];
    this.playbackEl    = null;
    this.spaceKeyHeld  = false;

    this.buttonHandler        = null;
    this.tierHandler          = null;
    this.shortcutKeyDownHandler = null;
    this.shortcutKeyUpHandler   = null;
    this.annotationEventUnsubscribe = null;

    this._applyUiBranding();
  }

  _applyUiBranding() {
    if (this.ui?.tierButton) {
      this.ui.tierButton.textContent = 'GRQ';
      this.ui.tierButton.title = 'Groq + ElevenLabs — free voice mode';
    }
    if (this.ui?.costValue) {
      this.ui.costValue.textContent    = 'FREE';
      this.ui.costValue.dataset.level  = 'ok';
      this.ui.costValue.title          = 'Groq Whisper + ElevenLabs — no cost';
    }
    setUiText(this.ui, 'idle', 'GROQ VOICE — click MIC or hold Space');
  }

  // ── Public API (matches GevRealtimeController) ───────────────────────────

  isActive() {
    return this.status !== 'idle' && this.status !== 'error';
  }

  /** Called when mic button is clicked or Space pressed */
  async start({ pushToTalk = false } = {}) {
    if (this.status === 'recording') {
      // Second click while recording → send
      this._commitRecording();
      return;
    }
    if (this.isActive()) return;

    setUiText(this.ui, 'connecting', 'Requesting microphone…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
    } catch (err) {
      this._setError(`Mic error: ${err.message}`);
      return;
    }

    this._startRecording();
  }

  stop({ removeUi = false } = {}) {
    this._cancelRecording();
    this._releaseStream();
    this._stopPlayback();
    this.status = 'idle';
    setUiText(this.ui, 'idle', 'Voice off');
    if (removeUi) this.ui?.root?.remove();
  }

  notifyMapEvent()  {}
  syncCostUi()      {}
  toggleVoiceTier() {}

  bindPushToTalkShortcut() {
    if (this.shortcutKeyDownHandler) return;

    this.shortcutKeyDownHandler = (e) => {
      if (e.code !== 'Space') return;
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName)) return;
      e.preventDefault();
      if (this.spaceKeyHeld) return;
      this.spaceKeyHeld = true;

      if (this.status === 'idle' || this.status === 'error') {
        this.start({ pushToTalk: true });
      }
    };

    this.shortcutKeyUpHandler = (e) => {
      if (e.code !== 'Space') return;
      this.spaceKeyHeld = false;
      if (this.status === 'recording') this._commitRecording();
    };

    document.addEventListener('keydown', this.shortcutKeyDownHandler);
    document.addEventListener('keyup',   this.shortcutKeyUpHandler);
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  _startRecording() {
    this.audioChunks = [];
    const mime = this._pickMime();

    try {
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : {});
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }

    this.recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) this.audioChunks.push(e.data);
    };
    this.recorder.onstop = () => this._onRecordingStop();
    this.recorder.start(100);

    this.status = 'recording';
    setUiText(this.ui, 'recording', '🔴 Recording… click MIC again to send');
    if (this.ui?.root) this.ui.root.dataset.speaker = 'user';
  }

  _commitRecording() {
    if (this.recorder?.state === 'recording') {
      this.recorder.stop(); // triggers onstop → _onRecordingStop
    }
  }

  _cancelRecording() {
    this.audioChunks = [];
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* no-op */ }
    }
    this.recorder = null;
  }

  _releaseStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  _pickMime() {
    const candidates = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4',''];
    return candidates.find((m) => !m || MediaRecorder.isTypeSupported(m)) || '';
  }

  // ── Processing pipeline ───────────────────────────────────────────────────

  async _onRecordingStop() {
    if (this.audioChunks.length === 0) {
      this._returnToIdle('Nothing recorded');
      return;
    }

    const mimeType = this.recorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.audioChunks, { type: mimeType });
    this.audioChunks = [];
    this.recorder = null;
    this._releaseStream();

    // Guard: must be at least 0.5 KB of audio
    if (blob.size < 512) {
      this._returnToIdle('Too short — try again');
      return;
    }

    // Step 1 — Transcribe
    setUiText(this.ui, 'processing', '🎙️ Transcribing…');
    const transcript = await this._transcribe(blob, mimeType);
    if (!transcript) {
      this._returnToIdle('Could not hear anything — try again');
      return;
    }

    console.log('[GevGroq] Heard:', transcript);
    setUiText(this.ui, 'processing', `Heard: "${transcript}"`);

    // Step 2 — Dispatch command
    setUiText(this.ui, 'processing', '🧠 Processing…');
    const { reply, toolCalls } = await this._dispatch(transcript);
    console.log('[GevGroq] Reply:', reply, '| Tools:', toolCalls);

    // Step 3 — Execute map tools
    if (toolCalls.length > 0) {
      setUiText(this.ui, 'executing', `▶ ${toolCalls.map((c) => c.name).join(', ')}`);
      for (const call of toolCalls) {
        try {
          await this.runner(call.name, call.arguments || {}, {});
        } catch (err) {
          console.warn('[GevGroq] Tool error:', call.name, err.message);
        }
      }
    }

    // Step 4 — Speak reply (if any)
    if (reply && reply.trim()) {
      await this._speak(reply.trim());
    } else {
      this._returnToIdle('Done');
    }
  }

  // ── Groq Whisper STT ──────────────────────────────────────────────────────

  async _transcribe(blob, mimeType) {
    try {
      const ext = mimeType.includes('ogg') ? 'ogg'
                : mimeType.includes('mp4') ? 'mp4'
                : 'webm';
      const form = new FormData();
      form.append('audio', blob, `recording.${ext}`);

      const resp = await fetch(GROQ_TRANSCRIBE_URL, { method: 'POST', body: form });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error('[GevGroq] Transcribe error:', err);
        return '';
      }
      const data = await resp.json();
      return (data.text || '').trim();
    } catch (err) {
      console.error('[GevGroq] Transcribe fetch failed:', err.message);
      return '';
    }
  }

  // ── Groq LLM dispatch ─────────────────────────────────────────────────────

  async _dispatch(text) {
    try {
      const resp = await fetch(GROQ_COMMAND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        console.error('[GevGroq] Command error:', resp.status);
        return { reply: '', toolCalls: [] };
      }
      const data = await resp.json();
      return {
        reply:     data.reply     || '',
        toolCalls: data.toolCalls || [],
      };
    } catch (err) {
      console.error('[GevGroq] Command fetch failed:', err.message);
      return { reply: '', toolCalls: [] };
    }
  }

  // ── ElevenLabs TTS ────────────────────────────────────────────────────────

  async _speak(text) {
    setUiText(this.ui, 'speaking', `🔊 ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`);
    if (this.ui?.root) this.ui.root.dataset.speaker = 'ai';

    try {
      const resp = await fetch(ELEVENLABS_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) throw new Error(`TTS ${resp.status}`);

      const audioBlob = await resp.blob();
      const url = URL.createObjectURL(audioBlob);
      this._stopPlayback();
      this.playbackEl = new Audio(url);
      await new Promise((resolve) => {
        this.playbackEl.onended = resolve;
        this.playbackEl.onerror = resolve;
        this.playbackEl.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
      this.playbackEl = null;
    } catch (err) {
      console.warn('[GevGroq] TTS failed:', err.message);
    }

    this._returnToIdle('');
  }

  _stopPlayback() {
    if (this.playbackEl) {
      this.playbackEl.pause();
      this.playbackEl.src = '';
      this.playbackEl = null;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _returnToIdle(msg = '') {
    this.status = 'idle';
    if (this.ui?.root) this.ui.root.dataset.speaker = 'idle';
    setUiText(this.ui, 'idle', msg || 'GROQ VOICE — click MIC or hold Space');
  }

  _setError(msg) {
    this.status = 'error';
    setUiText(this.ui, 'error', msg);
    if (this.ui?.errorDetail) this.ui.errorDetail.textContent = msg;
    if (this.ui?.root) this.ui.root.classList.remove('error-dismissed');
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function initGevGroqVoice({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  annotations   = null,
}) {
  // Tear down any existing voice controller
  if (window.__gevVoiceCommands?.stop) {
    window.__gevVoiceCommands.stop({ removeUi: false });
  }

  const runner = createGevActionRunner({ viewer, styleManager, dataManager, sceneDirector, annotations });
  const ui     = getUiRefs();
  const controller = new GevGroqController({ runner, ui });

  if (annotations?.onOutlineEvent) {
    controller.annotationEventUnsubscribe = annotations.onOutlineEvent((evt) =>
      controller.notifyMapEvent({ type: 'map_annotation_outline', ...evt })
    );
  }

  // Mic button: toggle recording
  controller.buttonHandler = () => {
    if (controller.status === 'idle' || controller.status === 'error') {
      controller.start({ pushToTalk: false });
    } else if (controller.status === 'recording') {
      controller._commitRecording();
    } else {
      controller.stop();
    }
  };

  if (ui?.button) ui.button.addEventListener('click', controller.buttonHandler);

  controller.bindPushToTalkShortcut();
  window.__gevVoiceCommands = controller;
  return controller;
}
