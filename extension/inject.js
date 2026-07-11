/**
 * AccentFlow Chrome Extension — Inject Script v3
 * Runs in the page's MAIN world context
 *
 * KEY FIX: AudioContext is created ONLY inside getUserMedia override,
 * which is always triggered by a real user gesture (click on call button).
 * This satisfies Chrome's autoplay policy.
 */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────
    let isActive = false;
    let audioContext = null;
    let mediaStreamDest = null;
    let audioContextReady = false;

    // Settings
    let settings = { rate: 1.0, volume: 1.0 };

    // Speech Recognition
    let recognition = null;

    // ── Save original getUserMedia ─────────────────────────
    const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
    );

    // ── Override getUserMedia ───────────────────────────────
    // This is called when user clicks "Call" in WhatsApp/Meet/ViciDial
    // → It IS a user gesture → AudioContext creation is allowed here
    navigator.mediaDevices.getUserMedia = async function (constraints) {

        // Pass through when not active
        if (!isActive || !constraints || !constraints.audio) {
            return _origGetUserMedia(constraints);
        }

        console.log('[AccentFlow] 🎤 getUserMedia intercepted');

        try {
            // Step 1: Get REAL mic stream first
            // This satisfies browser permissions + gives us a valid stream object
            const realStream = await _origGetUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                },
                video: !!(constraints.video),
            });

            // Step 2: Mute real audio — caller won't hear raw voice
            realStream.getAudioTracks().forEach(t => { t.enabled = false; });

            // Step 3: Create AudioContext HERE (inside user gesture context ✅)
            if (!audioContext) {
                audioContext = new AudioContext({ sampleRate: 48000 });
                mediaStreamDest = audioContext.createMediaStreamDestination();
                setupNoiseFill();
                audioContextReady = true;
                console.log('[AccentFlow] ✅ AudioContext created (user gesture context)');
            }

            // Ensure it's running
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // Step 4: Build output stream
            const outputStream = new MediaStream();

            // TTS audio goes to caller
            mediaStreamDest.stream.getAudioTracks().forEach(t => {
                outputStream.addTrack(t);
            });

            // Real video tracks if needed
            realStream.getVideoTracks().forEach(t => {
                outputStream.addTrack(t);
            });

            console.log('[AccentFlow] ✅ TTS stream ready for caller');
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');

            return outputStream;

        } catch (err) {
            console.error('[AccentFlow] Error in getUserMedia override:', err);
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Mic error: ' + err.message,
            }, '*');
            // Fallback to real mic
            return _origGetUserMedia(constraints);
        }
    };

    // ── Noise Fill (keeps stream alive) ───────────────────
    // Prevents WebRTC from thinking the stream is broken/dead
    function setupNoiseFill() {
        if (!audioContext || !mediaStreamDest) return;

        const bufferSize = 4096;
        // ScriptProcessor is deprecated but still the most compatible
        const noiseNode = audioContext.createScriptProcessor(bufferSize, 0, 1);
        noiseNode.onaudioprocess = (e) => {
            const out = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                out[i] = (Math.random() * 2 - 1) * 0.00005; // imperceptible
            }
        };
        noiseNode.connect(mediaStreamDest);
    }

    // ── Play TTS Audio Data ────────────────────────────────
    function playAudioData(audioArrayBuffer) {
        if (!audioContext || !mediaStreamDest) {
            console.warn('[AccentFlow] AudioContext not ready — make your call first, then speak');
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Please START your WhatsApp/ViciDial call first, then speak.',
            }, '*');
            return;
        }

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => decodeAndPlay(audioArrayBuffer));
        } else {
            decodeAndPlay(audioArrayBuffer);
        }
    }

    function decodeAndPlay(audioArrayBuffer) {
        audioContext.decodeAudioData(
            audioArrayBuffer,
            (decoded) => {
                const source = audioContext.createBufferSource();
                source.buffer = decoded;
                source.playbackRate.value = settings.rate || 1.0;

                const gain = audioContext.createGain();
                gain.gain.value = settings.volume || 1.0;

                // → caller hears TTS
                source.connect(gain);
                gain.connect(mediaStreamDest);

                // → you also hear your own converted voice locally
                gain.connect(audioContext.destination);

                source.onended = () => {
                    window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                };

                source.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                console.error('[AccentFlow] Decode error:', err);
                window.postMessage({
                    type: 'ACCENTFLOW_ERROR',
                    error: 'Audio decode failed: ' + err.message,
                }, '*');
            }
        );
    }

    // ── Speech Recognition ─────────────────────────────────
    function startSTT() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Speech recognition not supported. Please use Google Chrome.',
            }, '*');
            return;
        }

        stopSTT();

        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
            let interim = '';
            let final = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const t = event.results[i][0].transcript;
                if (event.results[i].isFinal) final += t;
                else interim += t;
            }
            if (interim) window.postMessage({ type: 'ACCENTFLOW_INTERIM', text: interim }, '*');
            if (final) {
                const clean = final.trim();
                if (clean) window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: clean }, '*');
            }
        };

        recognition.onend = () => {
            if (isActive) {
                setTimeout(() => {
                    if (isActive) try { recognition.start(); } catch (e) {}
                }, 200);
            }
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({
                    type: 'ACCENTFLOW_ERROR',
                    error: 'Microphone denied. Click the lock icon in Chrome address bar → Allow mic.',
                }, '*');
            }
        };

        try { recognition.start(); } catch (e) {}
    }

    function stopSTT() {
        if (recognition) {
            try { recognition.stop(); } catch (e) {}
            recognition = null;
        }
    }

    // ── Message Listener ───────────────────────────────────
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data?.type) return;

        switch (event.data.type) {

            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                // ⚠️ Do NOT create AudioContext here — not a user gesture!
                // AudioContext is created inside getUserMedia when user clicks Call
                startSTT();
                console.log('[AccentFlow] ✅ Activated. getUserMedia override ready. Make your call now.');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                audioContext = null;
                mediaStreamDest = null;
                audioContextReady = false;
                console.log('[AccentFlow] ⏹ Deactivated');
                break;

            case 'ACCENTFLOW_PLAY_AUDIO': {
                const uint8 = new Uint8Array(event.data.audioData);
                playAudioData(uint8.buffer);
                break;
            }

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (event.data.settings) settings = { ...settings, ...event.data.settings };
                break;
        }
    });

    console.log('[AccentFlow] 🚀 inject.js v3 loaded — getUserMedia override ready');

})();
