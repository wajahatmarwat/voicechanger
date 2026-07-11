/**
 * AccentFlow Chrome Extension — Inject Script v7
 *
 * KEY LESSONS FROM PREVIOUS VERSIONS:
 *  - DON'T override RTCPeerConnection constructor → breaks instanceof checks → calls stuck "connecting"
 *  - DON'T return muted stream from getUserMedia → voice messages record silence
 *
 * CORRECT APPROACH:
 *  1. getUserMedia → return REAL mic stream (voice messages work normally)
 *  2. addTrack / addTransceiver → swap audio track to TTS (call sends TTS to caller)
 *  3. Store senders from intercepts → force-replace when TTS plays (catches late callers)
 *  4. RTCRtpSender.replaceTrack → also intercepted for safety
 */

(function () {
    'use strict';

    if (window.__accentflow_v7) return;
    window.__accentflow_v7 = true;

    // ── State ─────────────────────────────────────────────
    let isActive = false;
    let audioCtx = null;
    let streamDest = null;
    let settings = { rate: 1.0, volume: 1.0 };
    let recognition = null;

    // Senders we've already swapped to TTS — force-replace these on first speech
    const swappedSenders = [];
    // Senders where TTS wasn't ready yet — replace them when TTS is first played
    const pendingSenders = [];

    // ── Save originals ────────────────────────────────────
    const _origGUM            = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const _origAddTrack       = RTCPeerConnection.prototype.addTrack;
    const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
    const _origReplaceTrack   = RTCRtpSender.prototype.replaceTrack;
    const _origAddStream      = RTCPeerConnection.prototype.addStream;

    function getTTSTrack() {
        return streamDest?.stream?.getAudioTracks?.()?.[0] ?? null;
    }

    // ══════════════════════════════════════════════════════
    //  getUserMedia — return REAL mic
    //  Voice messages use MediaRecorder on this stream → they work ✅
    //  Calls use addTrack/addTransceiver which we intercept separately ✅
    // ══════════════════════════════════════════════════════
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (!isActive || !constraints?.audio) {
            return _origGUM(constraints);
        }
        console.log('[AccentFlow] getUserMedia: returning real mic (WebRTC track swap happens at addTrack/addTransceiver)');
        // Return real mic — voice messages work, calls get swapped at addTrack/addTransceiver
        return _origGUM(constraints);
    };

    // ══════════════════════════════════════════════════════
    //  addTrack — swap audio to TTS
    // ══════════════════════════════════════════════════════
    RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
        if (isActive && track?.kind === 'audio') {
            if (!audioCtx) initAudio(); // try to init (may be in gesture chain)
            const tts = getTTSTrack();
            if (tts) {
                console.log('[AccentFlow] addTrack ✅ swapped to TTS');
                const sender = _origAddTrack.call(this, tts, ...streams);
                swappedSenders.push(sender);
                return sender;
            } else {
                // TTS track not ready — use real track but mark for later replacement
                console.warn('[AccentFlow] addTrack: TTS not ready, will replace on first speech');
                const sender = _origAddTrack.call(this, track, ...streams);
                pendingSenders.push(sender);
                return sender;
            }
        }
        return _origAddTrack.call(this, track, ...streams);
    };

    // ══════════════════════════════════════════════════════
    //  addTransceiver — WhatsApp Web and Google Meet use this!
    // ══════════════════════════════════════════════════════
    RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
        if (isActive) {
            const isAudio = trackOrKind === 'audio' ||
                (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio');

            if (isAudio) {
                if (!audioCtx) initAudio();
                const tts = getTTSTrack();
                if (tts) {
                    console.log('[AccentFlow] addTransceiver ✅ swapped to TTS');
                    const transceiver = _origAddTransceiver.call(this, tts, init);
                    swappedSenders.push(transceiver.sender);
                    return transceiver;
                } else {
                    // TTS not ready — use original but mark sender for later replacement
                    console.warn('[AccentFlow] addTransceiver: TTS not ready, will replace on first speech');
                    const transceiver = _origAddTransceiver.call(this, trackOrKind, init);
                    pendingSenders.push(transceiver.sender);
                    return transceiver;
                }
            }
        }
        return _origAddTransceiver.call(this, trackOrKind, init);
    };

    // ══════════════════════════════════════════════════════
    //  replaceTrack — intercept post-setup track replacements
    // ══════════════════════════════════════════════════════
    RTCRtpSender.prototype.replaceTrack = function (track) {
        if (isActive && track?.kind === 'audio') {
            const tts = getTTSTrack();
            if (tts) {
                console.log('[AccentFlow] replaceTrack ✅ swapped to TTS');
                return _origReplaceTrack.call(this, tts);
            }
        }
        return _origReplaceTrack.call(this, track);
    };

    // Legacy addStream
    if (_origAddStream) {
        RTCPeerConnection.prototype.addStream = function (stream) {
            if (isActive) {
                const tts = getTTSTrack();
                if (tts && stream.getAudioTracks().length > 0) {
                    const out = new MediaStream([tts, ...stream.getVideoTracks()]);
                    console.log('[AccentFlow] addStream ✅ swapped audio to TTS');
                    return _origAddStream.call(this, out);
                }
            }
            return _origAddStream.call(this, stream);
        };
    }

    // ══════════════════════════════════════════════════════
    //  Force-replace pending senders when TTS first plays
    //  (covers case where addTransceiver fired before audioCtx was ready)
    // ══════════════════════════════════════════════════════
    function replacePendingSenders() {
        if (pendingSenders.length === 0) return;
        const tts = getTTSTrack();
        if (!tts) return;

        pendingSenders.forEach(sender => {
            if (sender.track !== tts) {
                _origReplaceTrack.call(sender, tts)
                    .then(() => console.log('[AccentFlow] Pending sender replaced with TTS ✅'))
                    .catch(err => console.warn('[AccentFlow] Could not replace sender:', err.message));
            }
        });
        // Move to swapped list
        swappedSenders.push(...pendingSenders);
        pendingSenders.length = 0;
    }

    // ══════════════════════════════════════════════════════
    //  AudioContext — created on first page click (user gesture)
    // ══════════════════════════════════════════════════════
    function initAudio() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            return;
        }
        try {
            audioCtx = new AudioContext({ sampleRate: 48000 });
            streamDest = audioCtx.createMediaStreamDestination();

            // Near-silent oscillator keeps stream "live" for WebRTC
            const osc = audioCtx.createOscillator();
            const sg = audioCtx.createGain();
            sg.gain.value = 0.00001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] ✅ AudioContext + StreamDest ready');
            window.postMessage({ type: 'ACCENTFLOW_AUDIO_READY' }, '*');
        } catch (e) {
            console.error('[AccentFlow] AudioContext error:', e.message);
        }
    }

    function attachClickListener() {
        document.addEventListener('click', initAudio, { capture: true });
        document.addEventListener('touchend', initAudio, { capture: true });
    }

    // ══════════════════════════════════════════════════════
    //  TTS Playback
    // ══════════════════════════════════════════════════════
    function playAudio(buffer) {
        if (!audioCtx || !streamDest) {
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Please click the Call button first, then speak.',
            }, '*');
            return;
        }
        const go = () => {
            // Replace any senders that were set up before TTS was ready
            replacePendingSenders();
            decode(buffer);
        };
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
                gain.connect(streamDest);           // → WebRTC → caller hears ✅
                gain.connect(audioCtx.destination); // → local speakers ✅

                src.onended = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                src.start(0);
                window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            },
            (err) => {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Decode failed: ' + err.message }, '*');
            }
        );
    }

    // ══════════════════════════════════════════════════════
    //  Speech Recognition
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
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click lock icon → Allow microphone.' }, '*');
            }
        };
        try { recognition.start(); } catch (_) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
    }

    // ══════════════════════════════════════════════════════
    //  Message Listener
    // ══════════════════════════════════════════════════════
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;
        switch (e.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                attachClickListener();
                startSTT();
                console.log('[AccentFlow] ✅ Activated');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                swappedSenders.length = 0;
                pendingSenders.length = 0;
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

    console.log('[AccentFlow] 🚀 v7 loaded — getUserMedia(real) + addTrack + addTransceiver + replaceTrack');

})();
