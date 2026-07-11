/**
 * AccentFlow Chrome Extension — Inject Script v5
 *
 * TWO-LEVEL INTERCEPTION (the only reliable approach):
 *  1. getUserMedia override — intercept mic stream early
 *  2. RTCPeerConnection.addTrack override — intercept at WebRTC level
 *     This is the KEY fix: even if WhatsApp processes the stream through
 *     its own audio pipeline, we replace the track right before it goes
 *     to the network. The caller then hears our TTS audio.
 *
 * AudioContext created on first page click (user gesture guarantee).
 */

(function () {
    'use strict';

    if (window.__accentflow_v5) return;
    window.__accentflow_v5 = true;

    // ── State ──────────────────────────────────────────────
    let isActive = false;
    let audioCtx = null;
    let streamDest = null;
    let settings = { rate: 1.0, volume: 1.0 };
    let recognition = null;
    let interceptedSenders = []; // track all RTCPeerConnection senders we replaced

    // ── Save originals FIRST (before any page code runs) ──
    const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const _origAddTrack = RTCPeerConnection.prototype.addTrack;
    const _origAddStream = RTCPeerConnection.prototype.addStream; // legacy

    // ══════════════════════════════════════════════════════
    //  LEVEL 1: getUserMedia Override
    // ══════════════════════════════════════════════════════
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (!isActive || !constraints?.audio) {
            return _origGUM(constraints);
        }
        console.log('[AccentFlow] getUserMedia intercepted');
        try {
            const realStream = await _origGUM({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: !!(constraints.video),
            });
            // Mute real audio — don't let raw voice through
            realStream.getAudioTracks().forEach(t => { t.enabled = false; });

            if (!audioCtx || !streamDest) {
                // AudioContext not ready yet — pass the real (muted) stream
                // Level 2 (addTrack) will swap the track when WebRTC uses it
                console.warn('[AccentFlow] AudioContext not ready yet — relying on addTrack intercept');
                return realStream;
            }

            const out = new MediaStream();
            streamDest.stream.getAudioTracks().forEach(t => out.addTrack(t));
            realStream.getVideoTracks().forEach(t => out.addTrack(t));
            return out;

        } catch (err) {
            console.error('[AccentFlow] getUserMedia error:', err);
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic error: ' + err.message }, '*');
            return _origGUM(constraints);
        }
    };

    // ══════════════════════════════════════════════════════
    //  LEVEL 2: RTCPeerConnection.addTrack Override
    //  This fires right before audio goes to the network.
    //  Regardless of how WhatsApp processed the stream,
    //  we swap the audio track here with our TTS stream.
    // ══════════════════════════════════════════════════════
    RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
        if (isActive && track.kind === 'audio' && audioCtx && streamDest) {
            const ttsTrack = streamDest.stream.getAudioTracks()[0];
            if (ttsTrack) {
                console.log('[AccentFlow] ✅ RTCPeerConnection.addTrack intercepted — swapping audio track to TTS');
                const sender = _origAddTrack.call(this, ttsTrack, ...streams);
                interceptedSenders.push({ pc: this, sender });
                return sender;
            }
        }
        return _origAddTrack.call(this, track, ...streams);
    };

    // Also intercept legacy addStream
    if (_origAddStream) {
        RTCPeerConnection.prototype.addStream = function (stream) {
            if (isActive && audioCtx && streamDest) {
                const newStream = new MediaStream();
                stream.getAudioTracks().forEach(() => {
                    const ttsTrack = streamDest.stream.getAudioTracks()[0];
                    if (ttsTrack) newStream.addTrack(ttsTrack);
                });
                stream.getVideoTracks().forEach(t => newStream.addTrack(t));
                console.log('[AccentFlow] ✅ addStream intercepted — swapped audio to TTS');
                return _origAddStream.call(this, newStream);
            }
            return _origAddStream.call(this, stream);
        };
    }

    // ══════════════════════════════════════════════════════
    //  AudioContext Init (must be inside a real user gesture)
    // ══════════════════════════════════════════════════════
    function initAudio() {
        if (audioCtx) return;
        try {
            audioCtx = new AudioContext({ sampleRate: 48000 });
            streamDest = audioCtx.createMediaStreamDestination();

            // Keep-alive: near-silent oscillator so WebRTC doesn't think stream is dead
            const osc = audioCtx.createOscillator();
            const silenceGain = audioCtx.createGain();
            silenceGain.gain.value = 0.00001;
            osc.connect(silenceGain);
            silenceGain.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] ✅ AudioContext + StreamDest ready');
            window.postMessage({ type: 'ACCENTFLOW_AUDIO_READY' }, '*');
        } catch (e) {
            console.error('[AccentFlow] AudioContext init error:', e);
        }
    }

    function attachClickListener() {
        const handler = (evt) => {
            initAudio();
            if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
        };
        // capture:true — fires BEFORE WhatsApp's own click handlers
        document.addEventListener('click', handler, { capture: true });
        document.addEventListener('touchend', handler, { capture: true, once: true });
    }

    // ══════════════════════════════════════════════════════
    //  TTS Playback
    // ══════════════════════════════════════════════════════
    function playAudio(buffer) {
        if (!audioCtx || !streamDest) {
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Click the Call button in WhatsApp first, then speak.',
            }, '*');
            return;
        }
        const resume = audioCtx.state === 'suspended'
            ? audioCtx.resume()
            : Promise.resolve();
        resume.then(() => decode(buffer)).catch(() => {});
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
                gain.connect(streamDest);           // ← goes to caller via WebRTC ✅
                gain.connect(audioCtx.destination); // ← you hear it locally too ✅

                src.onended = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                src.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Audio decode failed: ' + err.message }, '*');
            }
        );
    }

    // ══════════════════════════════════════════════════════
    //  Speech Recognition (STT)
    // ══════════════════════════════════════════════════════
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
            if (final?.trim()) window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: final.trim() }, '*');
        };

        recognition.onend = () => {
            if (isActive) setTimeout(() => { if (isActive) try { recognition.start(); } catch (_) {} }, 200);
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click lock icon in address bar → Allow microphone.' }, '*');
            }
        };

        try { recognition.start(); } catch (_) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
    }

    // ══════════════════════════════════════════════════════
    //  Message Listener (from content.js)
    // ══════════════════════════════════════════════════════
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;
        switch (e.data.type) {

            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                attachClickListener(); // AudioContext on next click (guaranteed gesture)
                startSTT();
                console.log('[AccentFlow] ✅ Activated — click Call button to init audio');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                interceptedSenders = [];
                stopSTT();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; streamDest = null; }
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

    console.log('[AccentFlow] 🚀 inject.js v5 loaded — dual intercept ready (getUserMedia + RTCPeerConnection)');

})();
