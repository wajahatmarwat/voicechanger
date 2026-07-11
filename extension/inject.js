/**
 * AccentFlow Chrome Extension — Inject Script v4
 * Runs in the page's MAIN world context
 *
 * GUARANTEED AUDIOCONTEXT FIX:
 * We listen for the FIRST click on the page after activation.
 * Clicking the Call button in WhatsApp/Meet IS that first click.
 * AudioContext is created inside a real DOM click event — always allowed.
 *
 * Also: replaced deprecated ScriptProcessorNode with OscillatorNode.
 */

(function () {
    'use strict';

    // Guard: don't inject twice
    if (window.__accentflow_injected) return;
    window.__accentflow_injected = true;

    // ── State ──────────────────────────────────────────────
    let isActive = false;
    let audioCtx = null;
    let streamDest = null;
    let keepAliveNode = null;
    let settings = { rate: 1.0, volume: 1.0 };
    let recognition = null;

    // ── Save original getUserMedia ─────────────────────────
    const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    // ── AudioContext Bootstrap ─────────────────────────────
    // Called from INSIDE a click event — guaranteed to be allowed
    function initAudioContext() {
        if (audioCtx) return; // already ready

        try {
            audioCtx = new AudioContext({ sampleRate: 48000 });
            streamDest = audioCtx.createMediaStreamDestination();

            // Keep stream alive with a near-silent oscillator (replaces deprecated ScriptProcessor)
            keepAliveNode = audioCtx.createOscillator();
            const muteGain = audioCtx.createGain();
            muteGain.gain.value = 0.00001; // essentially silent, just keeps stream alive
            keepAliveNode.connect(muteGain);
            muteGain.connect(streamDest);
            keepAliveNode.start();

            console.log('[AccentFlow] ✅ AudioContext created successfully');
            window.postMessage({ type: 'ACCENTFLOW_AUDIO_READY' }, '*');
        } catch (e) {
            console.error('[AccentFlow] AudioContext creation failed:', e);
        }
    }

    // ── Page Click Listener ────────────────────────────────
    // Runs once on the first user click after activation — guaranteed user gesture
    function attachClickListener() {
        const handler = () => {
            initAudioContext();
            // Keep trying to resume if suspended
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
        };
        // capture: true so we intercept clicks before WhatsApp/Meet handles them
        document.addEventListener('click', handler, { capture: true });
        document.addEventListener('touchend', handler, { capture: true, once: true });
    }

    // ── Override getUserMedia ───────────────────────────────
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (!isActive || !constraints || !constraints.audio) {
            return _origGUM(constraints);
        }

        console.log('[AccentFlow] 🎤 getUserMedia intercepted');

        // Try to init AudioContext here too — getUserMedia IS a user gesture chain
        if (!audioCtx) {
            initAudioContext();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            await audioCtx.resume().catch(() => {});
        }

        try {
            // Get REAL stream first — needed for valid WebRTC stream + permissions
            const realStream = await _origGUM({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: !!(constraints.video),
            });

            // Mute real audio — caller must NOT hear raw accent
            realStream.getAudioTracks().forEach(t => { t.enabled = false; });

            if (!audioCtx || !streamDest) {
                console.warn('[AccentFlow] AudioContext not ready — returning real stream as fallback');
                realStream.getAudioTracks().forEach(t => { t.enabled = true; });
                return realStream;
            }

            // Build output stream: TTS audio + real video (if any)
            const out = new MediaStream();
            streamDest.stream.getAudioTracks().forEach(t => out.addTrack(t));
            realStream.getVideoTracks().forEach(t => out.addTrack(t));

            console.log('[AccentFlow] ✅ Returning TTS stream to caller');
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');
            return out;

        } catch (err) {
            console.error('[AccentFlow] getUserMedia error:', err);
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic error: ' + err.message }, '*');
            return _origGUM(constraints);
        }
    };

    // ── Play TTS Audio ─────────────────────────────────────
    function playAudio(buffer) {
        if (!audioCtx || !streamDest) {
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: '⚠️ Please click the Call button in WhatsApp first, then speak.',
            }, '*');
            return;
        }

        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => decode(buffer)).catch(() => {});
        } else {
            decode(buffer);
        }
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
                gain.connect(streamDest);        // → goes to caller
                gain.connect(audioCtx.destination); // → plays locally in your ear

                src.onended = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                src.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                console.error('[AccentFlow] decode error:', err);
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Audio decode failed.' }, '*');
            }
        );
    }

    // ── Speech Recognition (STT) ───────────────────────────
    function startSTT() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Use Google Chrome for speech recognition.' }, '*');
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
            if (final) {
                const clean = final.trim();
                if (clean) window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: clean }, '*');
            }
        };

        recognition.onend = () => {
            if (isActive) setTimeout(() => { if (isActive) try { recognition.start(); } catch (e) {} }, 200);
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic permission denied. Click the lock icon → Allow microphone.' }, '*');
            }
        };

        try { recognition.start(); } catch (e) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    }

    // ── Message Listener ───────────────────────────────────
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;

        switch (e.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                // Attach click listener — AudioContext created on first click (user gesture ✅)
                attachClickListener();
                startSTT();
                console.log('[AccentFlow] ✅ Activated. Click Call button to initialize audio.');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                if (keepAliveNode) { try { keepAliveNode.stop(); } catch (_) {} keepAliveNode = null; }
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
                streamDest = null;
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

    console.log('[AccentFlow] 🚀 inject.js v4 loaded');

})();
