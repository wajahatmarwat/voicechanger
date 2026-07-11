/**
 * AccentFlow Chrome Extension — Inject Script v6
 *
 * COMPREHENSIVE WEBRTC INTERCEPTION:
 * Intercepts ALL possible audio paths into WebRTC:
 *   1. getUserMedia         — early mic interception
 *   2. RTCPeerConnection    — constructor tracked to get all PC instances
 *   3. addTrack             — standard track-add path
 *   4. addTransceiver       — WhatsApp/Meet use this instead of addTrack
 *   5. RTCRtpSender.replaceTrack — in case track is replaced post-setup
 *   6. Force-replace on TTS play — brute-force: replace ALL audio senders
 *                                   the moment speech is detected
 */

(function () {
    'use strict';

    if (window.__accentflow_v6) return;
    window.__accentflow_v6 = true;

    // ── State ──────────────────────────────────────────────
    let isActive = false;
    let audioCtx = null;
    let streamDest = null;
    let settings = { rate: 1.0, volume: 1.0 };
    let recognition = null;

    // Track every RTCPeerConnection created on this page
    const allPCs = []; // array of WeakRef<RTCPeerConnection>

    // ── Save ALL originals immediately ─────────────────────
    const _origGUM         = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const _OrigPC          = window.RTCPeerConnection;
    const _origAddTrack    = RTCPeerConnection.prototype.addTrack;
    const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
    const _origReplaceTrack   = RTCRtpSender.prototype.replaceTrack;
    const _origAddStream   = RTCPeerConnection.prototype.addStream; // legacy

    // ── Helper: get the TTS audio track ───────────────────
    function getTTSTrack() {
        return streamDest?.stream?.getAudioTracks?.()?.[0] ?? null;
    }

    // ══════════════════════════════════════════════════════
    //  INTERCEPT 1: RTCPeerConnection constructor
    //  Track all peer connections so we can force-replace later
    // ══════════════════════════════════════════════════════
    window.RTCPeerConnection = function (...args) {
        const pc = new _OrigPC(...args);
        allPCs.push(new WeakRef(pc));
        console.log('[AccentFlow] New RTCPeerConnection created, tracking it');
        return pc;
    };
    window.RTCPeerConnection.prototype = _OrigPC.prototype;
    Object.defineProperty(window.RTCPeerConnection, 'name', { value: 'RTCPeerConnection' });

    // ══════════════════════════════════════════════════════
    //  INTERCEPT 2: getUserMedia
    // ══════════════════════════════════════════════════════
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (!isActive || !constraints?.audio) return _origGUM(constraints);

        console.log('[AccentFlow] getUserMedia intercepted');
        try {
            const realStream = await _origGUM({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: !!(constraints.video),
            });
            // Mute real voice — we'll replace with TTS
            realStream.getAudioTracks().forEach(t => { t.enabled = false; });

            if (audioCtx && streamDest) {
                const out = new MediaStream();
                streamDest.stream.getAudioTracks().forEach(t => out.addTrack(t));
                realStream.getVideoTracks().forEach(t => out.addTrack(t));
                console.log('[AccentFlow] getUserMedia returning TTS stream');
                return out;
            }
            // AudioContext not ready yet — addTrack/addTransceiver intercepts will handle it
            console.warn('[AccentFlow] getUserMedia: AudioContext not ready, returning muted real stream');
            return realStream;
        } catch (err) {
            console.error('[AccentFlow] getUserMedia error:', err);
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic error: ' + err.message }, '*');
            return _origGUM(constraints);
        }
    };

    // ══════════════════════════════════════════════════════
    //  INTERCEPT 3: RTCPeerConnection.addTrack
    // ══════════════════════════════════════════════════════
    RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
        if (isActive && track?.kind === 'audio') {
            const tts = getTTSTrack();
            if (tts) {
                console.log('[AccentFlow] addTrack intercepted — swapping to TTS track ✅');
                return _origAddTrack.call(this, tts, ...streams);
            } else {
                console.warn('[AccentFlow] addTrack intercepted but TTS track not ready yet');
            }
        }
        return _origAddTrack.call(this, track, ...streams);
    };

    // ══════════════════════════════════════════════════════
    //  INTERCEPT 4: RTCPeerConnection.addTransceiver
    //  WhatsApp Web and Google Meet use this instead of addTrack!
    // ══════════════════════════════════════════════════════
    RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
        if (isActive) {
            const isAudio = trackOrKind === 'audio' ||
                (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio');
            if (isAudio) {
                const tts = getTTSTrack();
                if (tts) {
                    console.log('[AccentFlow] addTransceiver intercepted — swapping to TTS track ✅');
                    return _origAddTransceiver.call(this, tts, init);
                } else {
                    console.warn('[AccentFlow] addTransceiver: TTS track not ready, will force-replace on first speech');
                }
            }
        }
        return _origAddTransceiver.call(this, trackOrKind, init);
    };

    // ══════════════════════════════════════════════════════
    //  INTERCEPT 5: RTCRtpSender.replaceTrack
    //  In case app replaces the track after initial setup
    // ══════════════════════════════════════════════════════
    RTCRtpSender.prototype.replaceTrack = function (track) {
        if (isActive && track?.kind === 'audio') {
            const tts = getTTSTrack();
            if (tts) {
                console.log('[AccentFlow] replaceTrack intercepted — swapping to TTS track ✅');
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
                    const newStream = new MediaStream();
                    newStream.addTrack(tts);
                    stream.getVideoTracks().forEach(t => newStream.addTrack(t));
                    console.log('[AccentFlow] addStream intercepted — swapped audio ✅');
                    return _origAddStream.call(this, newStream);
                }
            }
            return _origAddStream.call(this, stream);
        };
    }

    // ══════════════════════════════════════════════════════
    //  INTERCEPT 6: Force-replace ALL audio senders
    //  Called the moment TTS starts playing.
    //  This catches cases where WebRTC was set up BEFORE our TTS track was ready.
    // ══════════════════════════════════════════════════════
    function forceReplaceAllAudioSenders() {
        const tts = getTTSTrack();
        if (!tts) return;

        let replaced = 0;
        allPCs.forEach(ref => {
            const pc = ref.deref();
            if (!pc || pc.connectionState === 'closed') return;
            pc.getSenders().forEach(sender => {
                if (sender.track?.kind === 'audio' && sender.track !== tts) {
                    _origReplaceTrack.call(sender, tts)
                        .then(() => console.log('[AccentFlow] Force-replaced audio sender ✅'))
                        .catch(err => console.warn('[AccentFlow] replaceTrack failed:', err.message));
                    replaced++;
                }
            });
        });
        if (replaced > 0) console.log(`[AccentFlow] Force-replaced ${replaced} audio sender(s)`);
    }

    // ══════════════════════════════════════════════════════
    //  AudioContext Init (inside real user click gesture)
    // ══════════════════════════════════════════════════════
    function initAudio() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
            return;
        }
        try {
            audioCtx = new AudioContext({ sampleRate: 48000 });
            streamDest = audioCtx.createMediaStreamDestination();

            // Near-silent oscillator to keep stream alive
            const osc = audioCtx.createOscillator();
            const sg = audioCtx.createGain();
            sg.gain.value = 0.00001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] ✅ AudioContext + StreamDest created');
            window.postMessage({ type: 'ACCENTFLOW_AUDIO_READY' }, '*');
        } catch (e) {
            console.error('[AccentFlow] AudioContext init error:', e);
        }
    }

    function attachClickListener() {
        document.addEventListener('click', () => {
            initAudio();
        }, { capture: true });
        document.addEventListener('touchend', () => {
            initAudio();
        }, { capture: true });
    }

    // ══════════════════════════════════════════════════════
    //  TTS Playback
    // ══════════════════════════════════════════════════════
    function playAudio(buffer) {
        if (!audioCtx || !streamDest) {
            window.postMessage({
                type: 'ACCENTFLOW_ERROR',
                error: 'Click the Call button first, then speak.',
            }, '*');
            return;
        }
        const go = () => decode(buffer);
        audioCtx.state === 'suspended' ? audioCtx.resume().then(go).catch(() => {}) : go();
    }

    function decode(buffer) {
        audioCtx.decodeAudioData(buffer,
            (decoded) => {
                // STEP 1: Force-replace any audio sender that's using the real mic track
                // This is the nuclear option — ensures caller hears us even if setup happened early
                forceReplaceAllAudioSenders();

                const src = audioCtx.createBufferSource();
                src.buffer = decoded;
                src.playbackRate.value = settings.rate;

                const gain = audioCtx.createGain();
                gain.gain.value = settings.volume;

                src.connect(gain);
                gain.connect(streamDest);           // → WebRTC → caller hears ✅
                gain.connect(audioCtx.destination); // → speakers → you hear locally ✅

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
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic permission denied. Click lock icon → Allow microphone.' }, '*');
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
                console.log('[AccentFlow] ✅ Activated — all WebRTC intercepts armed');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; streamDest = null; }
                allPCs.length = 0;
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

    console.log('[AccentFlow] 🚀 v6 loaded — getUserMedia + RTCPeerConnection(ctor) + addTrack + addTransceiver + replaceTrack all intercepted');

})();
