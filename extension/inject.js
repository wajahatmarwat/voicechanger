/**
 * AccentFlow Chrome Extension — Inject Script
 * Runs in the page's MAIN world context (has access to page APIs)
 * Overrides getUserMedia so ViciDial receives our TTS audio as mic input
 */

(function () {
    'use strict';

    // ── State ──────────────────────────────────────────────
    let isActive = false;
    let audioContext = null;
    let mediaStreamDest = null;
    let fakeStream = null;
    let recognition = null;
    let silentOscillator = null;
    let settings = { rate: 1.0, pitch: 1.0, volume: 1.0 };
    let pendingResolvers = []; // getUserMedia calls waiting for activation

    // ── Save original getUserMedia ─────────────────────────
    const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
    );

    // ── Audio Context Setup ────────────────────────────────
    function ensureAudioContext() {
        if (audioContext) return;

        audioContext = new AudioContext({ sampleRate: 48000 });
        mediaStreamDest = audioContext.createMediaStreamDestination();
        fakeStream = mediaStreamDest.stream;

        // Keep the stream alive with a silent oscillator
        silentOscillator = audioContext.createOscillator();
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        silentOscillator.connect(silentGain);
        silentGain.connect(mediaStreamDest);
        silentOscillator.start();
    }

    // ── Override getUserMedia ───────────────────────────────
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        // Pass through if AccentFlow is not active or no audio requested
        if (!isActive || !constraints || !constraints.audio) {
            return _origGetUserMedia(constraints);
        }

        console.log('[AccentFlow] 🎤 Intercepted getUserMedia — returning accent-converted stream');

        ensureAudioContext();

        // Resume AudioContext if suspended
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // If video is also requested, combine fake audio with real video
        if (constraints.video) {
            const videoStream = await _origGetUserMedia({ video: constraints.video });
            return new MediaStream([
                ...fakeStream.getAudioTracks(),
                ...videoStream.getVideoTracks(),
            ]);
        }

        return new MediaStream(fakeStream.getAudioTracks());
    };

    // ── Speech Recognition ─────────────────────────────────
    function startSTT() {
        const SpeechRecognition =
            window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            notifyError('SpeechRecognition API not available. Use Google Chrome.');
            return;
        }

        if (recognition) {
            try { recognition.stop(); } catch (e) { /* ignore */ }
        }

        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
            let interimText = '';
            let finalText = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalText += transcript;
                } else {
                    interimText += transcript;
                }
            }

            // Send interim for live display
            if (interimText) {
                window.postMessage({
                    type: 'ACCENTFLOW_INTERIM',
                    text: interimText,
                }, '*');
            }

            // Send final text for TTS conversion
            if (finalText) {
                const cleaned = cleanText(finalText);
                if (cleaned.length > 0) {
                    window.postMessage({
                        type: 'ACCENTFLOW_FINAL_TEXT',
                        text: cleaned,
                    }, '*');
                }
            }
        };

        recognition.onend = () => {
            if (isActive) {
                setTimeout(() => {
                    if (isActive && recognition) {
                        try {
                            recognition.start();
                        } catch (e) {
                            console.warn('[AccentFlow] STT restart failed:', e.message);
                        }
                    }
                }, 150);
            }
        };

        recognition.onerror = (event) => {
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            console.error('[AccentFlow] STT error:', event.error);
            notifyError('Speech recognition error: ' + event.error);
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
        let cleaned = text.trim();
        if (cleaned.length === 0) return '';

        // Capitalize first letter
        cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

        return cleaned;
    }

    // ── Play TTS Audio Data ────────────────────────────────
    function playAudioData(audioArrayBuffer) {
        if (!audioContext || !mediaStreamDest) {
            console.warn('[AccentFlow] AudioContext not ready');
            return;
        }

        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }

        // Decode the audio (MP3/WAV) into an AudioBuffer
        audioContext.decodeAudioData(
            audioArrayBuffer,
            (decodedBuffer) => {
                const source = audioContext.createBufferSource();
                source.buffer = decodedBuffer;

                // Apply playback rate
                source.playbackRate.value = settings.rate || 1.0;

                // Volume control
                const gainNode = audioContext.createGain();
                gainNode.gain.value = settings.volume || 1.0;

                // Connect: source → gain → mediaStreamDest (fake mic)
                source.connect(gainNode);
                gainNode.connect(mediaStreamDest);

                source.onended = () => {
                    window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                };

                source.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                console.error('[AccentFlow] Audio decode failed:', err);
                notifyError('Failed to decode TTS audio');
            }
        );
    }

    // ── Helpers ────────────────────────────────────────────
    function notifyError(msg) {
        window.postMessage({ type: 'ACCENTFLOW_ERROR', error: msg }, '*');
    }

    // ── Message Listener ───────────────────────────────────
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || !event.data.type) return;

        switch (event.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                ensureAudioContext();
                startSTT();
                console.log('[AccentFlow] ✅ Activated');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                console.log('[AccentFlow] ⏹ Deactivated');
                break;

            case 'ACCENTFLOW_PLAY_AUDIO': {
                // Receive audio data (as regular array) from content script
                const uint8 = new Uint8Array(event.data.audioData);
                playAudioData(uint8.buffer);
                break;
            }

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                settings = { ...settings, ...(event.data.settings || {}) };
                break;
        }
    });

    // ── Ready ──────────────────────────────────────────────
    console.log('[AccentFlow] 🚀 Inject script loaded — getUserMedia override ready');
})();
