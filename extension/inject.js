/**
 * AccentFlow Chrome Extension — Inject Script (Final/Stable)
 *
 * APPROACH: Local TTS playback only. NO WebRTC interception.
 *
 * Why no WebRTC interception?
 * - Apps like WhatsApp/Meet have complex internal WebRTC pipelines
 * - Intercepting addTransceiver/addTrack breaks SDP negotiation → calls stuck "connecting"
 * - Intercepting getUserMedia breaks voice message recording
 *
 * HOW TO ROUTE AUDIO TO CALLER:
 * This extension converts your speech to American-accent TTS and plays it through
 * your computer speakers. Use one of these to route it to WhatsApp/ViciDial:
 *
 * OPTION A (Recommended — No extra software):
 *   Windows Stereo Mix: Sound Settings → Recording → Enable "Stereo Mix"
 *   → Set WhatsApp microphone to "Stereo Mix"
 *
 * OPTION B (Most reliable):
 *   VB-Audio Cable: free download from vb-audio.com
 *   → Set Chrome audio output to "CABLE Input"
 *   → Set WhatsApp microphone to "CABLE Output"
 */

(function () {
    'use strict';

    if (window.__accentflow_stable) return;
    window.__accentflow_stable = true;

    // ── State ─────────────────────────────────────────────
    let isActive = false;
    let audioCtx = null;
    let settings = { rate: 1.0, volume: 1.0 };
    let recognition = null;

    // ── AudioContext (created on first page click) ─────────
    function initAudio() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            return;
        }
        try {
            audioCtx = new AudioContext({ sampleRate: 48000 });
            console.log('[AccentFlow] ✅ AudioContext ready');
        } catch (e) {
            console.error('[AccentFlow] AudioContext error:', e.message);
        }
    }

    function attachClickListener() {
        document.addEventListener('click', initAudio, { capture: true });
        document.addEventListener('touchend', initAudio, { capture: true });
    }

    // ── TTS Playback (through local speakers) ─────────────
    function playAudio(buffer) {
        if (!audioCtx) {
            // Try to create on play (may fail if no gesture, but worth trying)
            try { audioCtx = new AudioContext(); } catch (e) { return; }
        }
        const go = () => decode(buffer);
        audioCtx.state === 'suspended' ? audioCtx.resume().then(go).catch(() => {}) : go();
    }

    function decode(buffer) {
        audioCtx.decodeAudioData(buffer,
            (decoded) => {
                const src = audioCtx.createBufferSource();
                src.buffer = decoded;
                src.playbackRate.value = settings.rate;

                const gain = audioCtx.createGain();
                gain.gain.value = settings.volume;

                src.connect(gain);
                gain.connect(audioCtx.destination); // → plays through system speakers
                // Stereo Mix / VB-Cable captures this and sends to WhatsApp as mic input

                src.onended = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                src.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Decode failed: ' + err.message }, '*');
            }
        );
    }

    // ── Speech Recognition ────────────────────────────────
    function startSTT() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Use Google Chrome.' }, '*');
            return;
        }
        stopSTT();
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (e) => {
            let interim = '', final = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) final += t;
                else interim += t;
            }
            if (interim) window.postMessage({ type: 'ACCENTFLOW_INTERIM', text: interim }, '*');
            if (final?.trim()) window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: final.trim() }, '*');
        };

        recognition.onend = () => {
            if (isActive) setTimeout(() => { if (isActive) try { recognition.start(); } catch (_) {} }, 200);
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click lock icon → Allow.' }, '*');
            }
        };
        try { recognition.start(); } catch (_) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
    }

    // ── Message Listener ──────────────────────────────────
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;
        switch (e.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                attachClickListener();
                startSTT();
                console.log('[AccentFlow] ✅ Activated — STT running, TTS plays via speakers');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;
            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
                console.log('[AccentFlow] ⏹ Deactivated');
                break;
            case 'ACCENTFLOW_PLAY_AUDIO':
                playAudio(new Uint8Array(e.data.audioData).buffer);
                break;
            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (e.data.settings) settings = { ...settings, ...e.data.settings };
                break;
        }
    });

    console.log('[AccentFlow] 🚀 Stable inject.js loaded — STT + local TTS (no WebRTC intercept)');
})();
