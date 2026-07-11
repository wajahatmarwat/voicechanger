/**
 * AccentFlow Chrome Extension — Inject Script v3 (Reliable Dual-Pipeline)
 *
 * HOW IT WORKS:
 *  1. RTCPeerConnection.addTrack is intercepted at the deepest level.
 *     When WhatsApp tries to send ANY audio to the network, we silently
 *     replace it with our TTS AudioContext stream.
 *
 *  2. getUserMedia is also intercepted as a fallback for simpler apps.
 *
 *  3. TTS is generated via Web SpeechSynthesis (speaks through speakers
 *     locally so you can monitor) AND simultaneously via background
 *     Google TTS fetch which gets piped directly into the WebRTC stream.
 *
 *  Both pipelines fire in parallel — whichever reaches the caller wins.
 */

(function () {
    'use strict';

    if (window.__accentflow_v3) return;
    window.__accentflow_v3 = true;

    // ── State ──────────────────────────────────────────────────────────
    let isActive    = false;
    let audioCtx    = null;
    let streamDest  = null;
    let recognition = null;
    let settings    = { rate: 1.0, volume: 1.0, pitch: 1.0, gender: 'male' };
    let voices      = [];

    // ── Save originals ─────────────────────────────────────────────────
    const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    // ── Voices ─────────────────────────────────────────────────────────
    function loadVoices() {
        const v = window.speechSynthesis.getVoices();
        if (v.length) voices = v;
    }
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();

    function findVoice(gender) {
        if (!voices.length) voices = window.speechSynthesis.getVoices();
        const maleKws   = ['David', 'Mark', 'Guy', 'James', 'Ryan', 'Eric', 'Male'];
        const femaleKws = ['Zira', 'Jenny', 'Aria', 'Ana', 'Michelle', 'Susan', 'Female'];
        const kws = gender === 'male' ? maleKws : femaleKws;
        for (const kw of kws) {
            const v = voices.find(v => v.lang.startsWith('en-US') && v.name.includes(kw));
            if (v) return v;
        }
        return voices.find(v => v.lang.startsWith('en-US')) ||
               voices.find(v => v.lang.startsWith('en')) || null;
    }

    // ══════════════════════════════════════════════════════════════════
    //  AudioContext — shared, created on first user gesture
    // ══════════════════════════════════════════════════════════════════
    function ensureAudioContext() {
        if (audioCtx && audioCtx.state !== 'closed') return;
        try {
            audioCtx   = new AudioContext();
            streamDest = audioCtx.createMediaStreamDestination();

            // Near-silent oscillator keeps stream alive (prevents WebRTC
            // from flagging stream as inactive and silencing it)
            const osc = audioCtx.createOscillator();
            const sg  = audioCtx.createGain();
            sg.gain.value = 0.00001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] AudioContext ready, sampleRate=' + audioCtx.sampleRate);
        } catch (e) {
            console.error('[AccentFlow] AudioContext failed:', e);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  TTS Speak — fires BOTH local speech AND pipes into stream
    // ══════════════════════════════════════════════════════════════════
    function speak(text) {
        if (!text?.trim() || !isActive) return;

        window.speechSynthesis.cancel();

        const utterance  = new SpeechSynthesisUtterance(text.trim());
        utterance.lang   = 'en-US';
        utterance.rate   = settings.rate   || 1.0;
        utterance.volume = settings.volume || 1.0;
        utterance.pitch  = settings.pitch  || 1.0;

        const voice = findVoice(settings.gender || 'male');
        if (voice) utterance.voice = voice;

        utterance.onstart = () => window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
        utterance.onend   = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        utterance.onerror = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');

        // Play locally through speakers so user can monitor
        window.speechSynthesis.speak(utterance);

        // ALSO pipe into WebRTC via background TTS fetch
        // content.js relays ACCENTFLOW_FINAL_TEXT to background which fetches
        // Google TTS MP3 and sends back ACCENTFLOW_PLAY_AUDIO
        window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: text.trim() }, '*');
    }

    // ── Pipe background TTS audio into the WebRTC stream ──────────────
    async function playAudioIntoStream(audioDataArray) {
        if (!streamDest) {
            console.warn('[AccentFlow] streamDest not ready');
            return;
        }
        try {
            ensureAudioContext();
            if (audioCtx.state === 'suspended') await audioCtx.resume();

            const arrayBuf = new Uint8Array(audioDataArray).buffer.slice(0);
            audioCtx.decodeAudioData(arrayBuf, (decoded) => {
                const src  = audioCtx.createBufferSource();
                src.buffer = decoded;

                const gain = audioCtx.createGain();
                gain.gain.value = 1.5; // boost slightly into stream

                src.connect(gain);
                gain.connect(streamDest);  // → WebRTC caller hears this ✅
                src.start(0);
                console.log('[AccentFlow] Audio piped into WebRTC stream ✅');
            }, (err) => console.error('[AccentFlow] Decode error:', err));
        } catch (e) {
            console.error('[AccentFlow] Stream pipe error:', e);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  getUserMedia Override — returns TTS stream as mic
    // ══════════════════════════════════════════════════════════════════
    const customGUM = async function(constraints) {
        if (!isActive || !constraints?.audio) {
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
        console.log('[AccentFlow] getUserMedia intercepted');

        try {
            const realStream = await _origGUM.call(navigator.mediaDevices, {
                audio: { echoCancellation: true, noiseSuppression: true },
                video: false,
            });

            ensureAudioContext();
            if (audioCtx.state === 'suspended') await audioCtx.resume();

            // Connect real mic (muted) for hardware clock timing
            try {
                const micSrc   = audioCtx.createMediaStreamSource(realStream);
                const muteGain = audioCtx.createGain();
                muteGain.gain.value = 0;
                micSrc.connect(muteGain);
                muteGain.connect(streamDest);
            } catch(e) {}

            window.__accentflow_realStream = realStream;
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');
            console.log('[AccentFlow] Returning TTS stream as mic ✅');
            return streamDest.stream;

        } catch (err) {
            console.error('[AccentFlow] GUM fallback:', err.message);
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
    };

    // Patch all getUserMedia entry points
    navigator.mediaDevices.getUserMedia = customGUM;
    try { MediaDevices.prototype.getUserMedia = customGUM; } catch(e) {}
    try {
        if (navigator.getUserMedia) navigator.getUserMedia = (c,s,e) => customGUM(c).then(s).catch(e);
        if (navigator.webkitGetUserMedia) navigator.webkitGetUserMedia = (c,s,e) => customGUM(c).then(s).catch(e);
    } catch(e) {}

    // ══════════════════════════════════════════════════════════════════
    //  RTCPeerConnection.addTrack — deepest intercept
    //  Lets WhatsApp use the real mic for all its checks, but swaps
    //  the audio payload right before it goes over the network
    // ══════════════════════════════════════════════════════════════════
    try {
        const origAddTrack = RTCPeerConnection.prototype.addTrack;
        RTCPeerConnection.prototype.addTrack = function(track, ...streams) {
            if (isActive && track?.kind === 'audio') {
                console.log('[AccentFlow] RTCPeerConnection.addTrack — swapping audio track ✅');
                ensureAudioContext();
                try {
                    const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([track]));
                    const hwMute = audioCtx.createGain();
                    hwMute.gain.value = 0;
                    hwSrc.connect(hwMute);
                    hwMute.connect(streamDest);
                } catch(e) {}
                const fakeTrack = streamDest.stream.getAudioTracks()[0];
                if (fakeTrack) {
                    try { Object.defineProperty(fakeTrack, 'label', { get: () => track.label, configurable: true }); } catch(e) {}
                    try { fakeTrack.getSettings = () => track.getSettings(); } catch(e) {}
                    return origAddTrack.call(this, fakeTrack, ...streams);
                }
            }
            return origAddTrack.call(this, track, ...streams);
        };

        // WhatsApp uses addTransceiver (NOT addTrack) for voice calls!
        const origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
        RTCPeerConnection.prototype.addTransceiver = function(trackOrKind, init) {
            if (isActive) {
                const isAudio = trackOrKind === 'audio' ||
                                (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio');
                if (isAudio) {
                    console.log('[AccentFlow] RTCPeerConnection.addTransceiver — swapping audio ✅');
                    ensureAudioContext();
                    if (trackOrKind instanceof MediaStreamTrack) {
                        try {
                            const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([trackOrKind]));
                            const hwMute = audioCtx.createGain();
                            hwMute.gain.value = 0;
                            hwSrc.connect(hwMute);
                            hwMute.connect(streamDest);
                        } catch(e) {}
                    }
                    const fakeTrack = streamDest.stream.getAudioTracks()[0];
                    if (fakeTrack) {
                        return origAddTransceiver.call(this, fakeTrack, init);
                    }
                }
            }
            return origAddTransceiver.call(this, trackOrKind, init);
        };

        // Also intercept replaceTrack (used when mic changes mid-call)
        const origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
        RTCRtpSender.prototype.replaceTrack = function(newTrack) {
            if (isActive && newTrack?.kind === 'audio') {
                console.log('[AccentFlow] RTCRtpSender.replaceTrack — swapping audio ✅');
                ensureAudioContext();
                const fakeTrack = streamDest?.stream.getAudioTracks()[0];
                if (fakeTrack) return origReplaceTrack.call(this, fakeTrack);
            }
            return origReplaceTrack.call(this, newTrack);
        };

        console.log('[AccentFlow] RTCPeerConnection fully intercepted ✅');
    } catch(e) {
        console.error('[AccentFlow] RTCPeerConnection intercept failed:', e);
    }

    // ══════════════════════════════════════════════════════════════════
    //  Speech Recognition (STT)
    // ══════════════════════════════════════════════════════════════════
    function startSTT() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) {
            window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Use Google Chrome for speech recognition.' }, '*');
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
                speak(clean);
            }
        };

        recognition.onend = () => {
            if (isActive) setTimeout(() => {
                if (isActive) try { recognition.start(); } catch(_) {}
            }, 200);
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click the lock icon in the address bar → Allow mic.' }, '*');
            }
        };

        try { recognition.start(); } catch(_) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch(_) {} recognition = null; }
    }

    // ── Message Bus ────────────────────────────────────────────────────
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;

        switch (e.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                loadVoices();
                ensureAudioContext();
                startSTT();
                console.log('[AccentFlow] Activated ✅');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                window.speechSynthesis.cancel();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; streamDest = null; }
                console.log('[AccentFlow] Deactivated');
                break;

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (e.data.settings) settings = { ...settings, ...e.data.settings };
                break;

            case 'ACCENTFLOW_PLAY_AUDIO':
                if (e.data.audioData) {
                    playAudioIntoStream(e.data.audioData);
                }
                break;
        }
    });

    console.log('[AccentFlow] v3 loaded — RTCPeerConnection + getUserMedia + SpeechSynthesis pipeline active');
})();
