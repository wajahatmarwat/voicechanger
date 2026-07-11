/**
 * AccentFlow Chrome Extension — Inject Script v2
 * Runs in the page's MAIN world context
 *
 * APPROACH:
 *  1. Always intercept getUserMedia early (override installed immediately)
 *  2. When AccentFlow is NOT active → pass through to real getUserMedia
 *  3. When AccentFlow IS active:
 *     a. Get the REAL mic stream (satisfies browser permissions & WebRTC)
 *     b. Mute the real audio track (caller won't hear raw voice)
 *     c. Route TTS audio through AudioContext → MediaStreamDestination
 *     d. Return a combined stream with TTS audio (and real video if needed)
 *  4. SpeechRecognition uses its own internal mic capture (unaffected)
 */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────
    let isActive = false;
    let audioContext = null;
    let mediaStreamDest = null;
    let realMicStream = null;          // the actual mic stream (muted to caller)
    let isMicReady = false;

    // Settings
    let settings = { rate: 1.0, volume: 1.0 };

    // Speech Recognition
    let recognition = null;

    // ── Save original getUserMedia ─────────────────────────
    const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
    );

    // ── Override getUserMedia ───────────────────────────────
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        // Always pass through when not active
        if (!isActive || !constraints || !constraints.audio) {
            return _origGetUserMedia(constraints);
        }

        console.log('[AccentFlow] 🎤 getUserMedia intercepted — routing to TTS stream');

        try {
            // Step 1: Get real mic stream (needed for permission + valid stream object)
            const realStream = await _origGetUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 48000,
                },
                video: constraints.video || false,
            });

            // Step 2: Store real stream for STT if needed
            realMicStream = realStream;

            // Step 3: Mute the real audio tracks so caller does NOT hear raw voice
            realStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });

            // Step 4: Set up AudioContext if not ready
            ensureAudioContext();

            // Resume if suspended (browser requires user gesture)
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // Step 5: Build the output stream
            const outputStream = new MediaStream();

            // Add TTS audio track (this is what the caller hears)
            mediaStreamDest.stream.getAudioTracks().forEach(track => {
                outputStream.addTrack(track);
            });

            // Add real video tracks if video was requested
            realStream.getVideoTracks().forEach(track => {
                outputStream.addTrack(track);
            });

            isMicReady = true;
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');
            console.log('[AccentFlow] ✅ Returning TTS stream to caller');

            return outputStream;

        } catch (err) {
            console.error('[AccentFlow] getUserMedia override error:', err);
            // On failure, fall back to real getUserMedia
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Mic access failed: ' + err.message,
            }, '*');
            return _origGetUserMedia(constraints);
        }
    };

    // ── AudioContext Setup ─────────────────────────────────
    function ensureAudioContext() {
        if (audioContext) return;

        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000,
        });
        mediaStreamDest = audioContext.createMediaStreamDestination();

        // Keep stream alive with a very low-level noise floor
        // (prevents WebRTC from thinking the stream is broken)
        const bufferSize = 4096;
        const noiseNode = audioContext.createScriptProcessor(bufferSize, 0, 1);
        noiseNode.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                // Imperceptible background noise (prevents silent-stream detection)
                output[i] = (Math.random() * 2 - 1) * 0.0001;
            }
        };
        noiseNode.connect(mediaStreamDest);
    }

    // ── Play TTS Audio ─────────────────────────────────────
    function playAudioData(audioArrayBuffer) {
        if (!audioContext || !mediaStreamDest) {
            console.warn('[AccentFlow] AudioContext not ready for playback');
            return;
        }

        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        audioContext.decodeAudioData(
            audioArrayBuffer,
            (decoded) => {
                const source = audioContext.createBufferSource();
                source.buffer = decoded;
                source.playbackRate.value = settings.rate || 1.0;

                const gain = audioContext.createGain();
                gain.gain.value = settings.volume || 1.0;

                // Route: TTS source → gain → mediaStreamDest (sent to caller)
                source.connect(gain);
                gain.connect(mediaStreamDest);

                // ALSO play locally so user can hear their own converted voice
                gain.connect(audioContext.destination);

                source.onended = () => {
                    window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                };

                source.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                console.error('[AccentFlow] Audio decode error:', err);
                window.postMessage({
                    type: 'ACCENTFLOW_ERROR',
                    error: 'Failed to decode TTS audio.',
                }, '*');
            }
        );
    }

    // ── Speech Recognition (STT) ───────────────────────────
    function startSTT() {
        const SpeechRecognition =
            window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Speech recognition not available. Use Google Chrome.',
            }, '*');
            return;
        }

        stopSTT();

        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
            let interim = '';
            let final = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const t = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    final += t;
                } else {
                    interim += t;
                }
            }

            if (interim) {
                window.postMessage({ type: 'ACCENTFLOW_INTERIM', text: interim }, '*');
            }

            if (final) {
                const cleaned = cleanText(final);
                if (cleaned.length > 0) {
                    window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: cleaned }, '*');
                }
            }
        };

        recognition.onend = () => {
            // Auto-restart
            if (isActive) {
                setTimeout(() => {
                    if (isActive) {
                        try { recognition.start(); } catch (e) { /* ignore */ }
                    }
                }, 200);
            }
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            console.error('[AccentFlow STT] Error:', e.error);
            if (e.error === 'not-allowed') {
                window.postMessage({
                    type: 'ACCENTFLOW_ERROR',
                    error: 'Microphone permission denied. Click the lock icon in Chrome address bar and allow microphone.',
                }, '*');
            }
        };

        try {
            recognition.start();
            console.log('[AccentFlow] 🎙️ STT started');
        } catch (e) {
            console.error('[AccentFlow] STT start failed:', e);
        }
    }

    function stopSTT() {
        if (recognition) {
            try { recognition.stop(); } catch (e) { /* ignore */ }
            recognition = null;
        }
    }

    // ── Text Cleanup ───────────────────────────────────────
    function cleanText(text) {
        let t = text.trim();
        if (!t) return '';
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    // ── Message Listener ───────────────────────────────────
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data?.type) return;

        switch (event.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                ensureAudioContext();
                startSTT();
                console.log('[AccentFlow] ✅ Activated — getUserMedia override active');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                isMicReady = false;
                stopSTT();
                if (audioContext) {
                    audioContext.suspend();
                }
                console.log('[AccentFlow] ⏹ Deactivated');
                break;

            case 'ACCENTFLOW_PLAY_AUDIO': {
                const uint8 = new Uint8Array(event.data.audioData);
                playAudioData(uint8.buffer);
                break;
            }

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (event.data.settings) {
                    settings = { ...settings, ...event.data.settings };
                }
                break;
        }
    });

    console.log('[AccentFlow] 🚀 inject.js loaded — getUserMedia override ready');

    // Notify that inject.js is in place
    window.postMessage({ type: 'ACCENTFLOW_INJECT_READY' }, '*');

})();
