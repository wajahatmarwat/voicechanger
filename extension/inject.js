/**
 * AccentFlow Chrome Extension — Inject Script (Dual Mode)
 *
 * MODE 1 — Direct Stream Injection (ViciDial, simple apps):
 *   Overrides getUserMedia → returns AudioContext stream → TTS audio flows through it
 *   Works when the app passes getUserMedia stream directly to WebRTC
 *   → No VB-Cable or Stereo Mix needed ✅
 *
 * MODE 2 — Local Playback (WhatsApp, Google Meet, complex apps):
 *   TTS plays through system speakers
 *   User routes audio via Windows Stereo Mix or VB-Cable
 *
 * The extension tries Mode 1 first. If the app still uses the real mic
 * (detected when no conversion is heard), user can switch to Mode 2.
 */

(function () {
    'use strict';

    if (window.__accentflow_dual) return;
    window.__accentflow_dual = true;

    // ── State ─────────────────────────────────────────────
    let isActive   = false;
    let mode1Active = false; // true = getUserMedia was intercepted → don't echo locally
    let audioCtx   = null;
    let streamDest = null;
    let recognition = null;
    let settings   = { rate: 1.0, volume: 1.0, pitch: 1.0, gender: 'male' };
    let voices     = [];

    // ── Save original getUserMedia ─────────────────────────
    const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    // ── Load voices ────────────────────────────────────────
    function loadVoices() {
        const v = window.speechSynthesis.getVoices();
        if (v.length) voices = v;
    }
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();

    // ── Find best voice for gender ─────────────────────────
    function findVoice(gender) {
        if (!voices.length) voices = window.speechSynthesis.getVoices();
        const male   = ['David', 'Mark', 'Guy', 'James', 'Male', 'Ryan', 'Eric'];
        const female = ['Zira', 'Jenny', 'Aria', 'Ana', 'Female', 'Michelle', 'Susan'];
        const kws    = gender === 'male' ? male : female;
        for (const kw of kws) {
            const v = voices.find(v => v.lang.startsWith('en-US') && v.name.includes(kw));
            if (v) return v;
        }
        return voices.find(v => v.lang.startsWith('en-US')) ||
               voices.find(v => v.lang.startsWith('en'))    || null;
    }

    // ══════════════════════════════════════════════════════
    //  AudioContext Setup (created inside getUserMedia — user gesture chain ✅)
    // ══════════════════════════════════════════════════════
    function setupAudioContext() {
        if (audioCtx) return;
        try {
            audioCtx   = new AudioContext({ sampleRate: 48000 });
            streamDest = audioCtx.createMediaStreamDestination();

            // Near-silent oscillator keeps stream "alive" for WebRTC
            const osc  = audioCtx.createOscillator();
            const sg   = audioCtx.createGain();
            sg.gain.value = 0.00001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();
            console.log('[AccentFlow] ✅ AudioContext created inside getUserMedia');
        } catch (e) {
            console.error('[AccentFlow] AudioContext error:', e.message);
        }
    }

    // ══════════════════════════════════════════════════════
    //  MODE 1: getUserMedia Override
    //  ViciDial and simple apps use this stream directly for WebRTC
    //  → TTS audio in this stream → caller hears it ✅
    // ══════════════════════════════════════════════════════
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (!isActive || !constraints?.audio) {
            return _origGUM(constraints);
        }

        console.log('[AccentFlow] 🎤 getUserMedia intercepted (Mode 1 — Direct Injection)');
        mode1Active = true;

        try {
            // Get real mic (keeps permission valid + keeps stream object real)
            const realStream = await _origGUM({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: !!(constraints.video),
            });

            // Create AudioContext HERE — inside getUserMedia = user gesture chain ✅
            setupAudioContext();

            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            // Build fake mic stream: TTS audio track + real video (if any)
            const out = new MediaStream();
            streamDest.stream.getAudioTracks().forEach(t => out.addTrack(t));
            realStream.getVideoTracks().forEach(t => out.addTrack(t));

            // Keep real stream reference so mic permission stays granted
            window.__accentflow_realStream = realStream;

            console.log('[AccentFlow] ✅ Returning TTS stream — if caller hears nothing, enable Stereo Mix');
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');
            return out;

        } catch (err) {
            console.error('[AccentFlow] getUserMedia error:', err);
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic: ' + err.message }, '*');
            return _origGUM(constraints);
        }
    };

    // ══════════════════════════════════════════════════════
    //  TTS — Web SpeechSynthesis (plays locally + through stream)
    //  Plays through:
    //    1. audioCtx.destination → system speakers (MODE 2: Stereo Mix picks this up)
    //    2. streamDest           → fake mic stream  (MODE 1: ViciDial/simple apps)
    // ══════════════════════════════════════════════════════
    function speak(text) {
        if (!text?.trim() || !isActive) return;

        window.speechSynthesis.cancel();

        const utterance      = new SpeechSynthesisUtterance(text.trim());
        utterance.lang       = 'en-US';
        utterance.rate       = settings.rate   || 1.0;
        utterance.volume     = settings.volume || 1.0;
        utterance.pitch      = settings.pitch  || 1.0;

        const voice = findVoice(settings.gender || 'male');
        if (voice) utterance.voice = voice;

        utterance.onstart = () => window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
        utterance.onend   = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');

        if (!mode1Active) {
            window.speechSynthesis.speak(utterance);
        } else {
            // If Mode 1 is active, we rely on ACCENTFLOW_PLAY_AUDIO from background
            // to pipe the audio into the stream (bypassing CSP).
            // Fire speaking event manually since speechSynthesis won't run.
            window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
        }
    }

    // ── Pipe TTS audio into the fake mic stream (Mode 1 supplement) ──
    async function playAudioBuffer(audioDataArray) {
        if (!audioCtx || !streamDest) {
            window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
            return;
        }

        try {
            if (audioCtx.state === 'suspended') await audioCtx.resume();

            const uint8 = new Uint8Array(audioDataArray);
            const arrayBuf = uint8.buffer;

            audioCtx.decodeAudioData(arrayBuf, (decoded) => {
                const src  = audioCtx.createBufferSource();
                src.buffer = decoded;
                src.playbackRate.value = settings.rate || 1.0;

                const gain = audioCtx.createGain();
                gain.gain.value = settings.volume || 1.0;

                src.connect(gain);
                gain.connect(streamDest); // → fake mic stream → ViciDial WebRTC ✅

                src.onended = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                src.start(0);
            }, (err) => {
                console.error('[AccentFlow] Audio decode error:', err);
                window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
            });
        } catch (e) {
            console.error('[AccentFlow] Audio playback error:', e);
            window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        }
    }

    // ══════════════════════════════════════════════════════
    //  Speech Recognition (STT)
    // ══════════════════════════════════════════════════════
    function startSTT() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Use Google Chrome.' }, '*');
            return;
        }
        stopSTT();

        recognition = new SR();
        recognition.continuous     = true;
        recognition.interimResults = true;
        recognition.lang           = 'en-US';

        recognition.onresult = (e) => {
            let interim = '', final = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) final += t;
                else interim += t;
            }
            if (interim) window.postMessage({ type: 'ACCENTFLOW_INTERIM', text: interim }, '*');
            if (final?.trim()) {
                const clean = final.trim();
                window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: clean }, '*');
                speak(clean);
            }
        };

        recognition.onend = () => {
            if (isActive) setTimeout(() => {
                if (isActive) try { recognition.start(); } catch (_) {}
            }, 200);
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click lock → Allow mic.' }, '*');
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
                loadVoices();
                startSTT();
                console.log('[AccentFlow] ✅ Activated — Dual mode (Mode1: getUserMedia + Mode2: Speakers)');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;
            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                window.speechSynthesis.cancel();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; streamDest = null; }
                console.log('[AccentFlow] ⏹ Deactivated');
                break;
            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (e.data.settings) settings = { ...settings, ...e.data.settings };
                break;
            case 'ACCENTFLOW_PLAY_AUDIO':
                if (mode1Active && e.data.audioData) {
                    playAudioBuffer(e.data.audioData);
                }
                break;
        }
    });

    console.log('[AccentFlow] 🚀 Dual-mode inject loaded (getUserMedia injection + SpeechSynthesis)');
})();
