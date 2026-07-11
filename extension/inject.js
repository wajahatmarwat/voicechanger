/**
 * AccentFlow Chrome Extension — Inject Script v4
 *
 * KEY INSIGHT: WhatsApp creates RTCPeerConnection and adds audio tracks
 * BEFORE the user clicks Start in the extension. So intercepting addTrack/
 * addTransceiver alone is not enough — we also need to:
 *   1. Hook the RTCPeerConnection CONSTRUCTOR to track all created PCs
 *   2. When Start is clicked, immediately call sender.replaceTrack() on
 *      ALL existing audio senders across ALL peer connections
 *   3. Keep intercepting addTrack/addTransceiver for any NEW connections
 */

(function () {
    'use strict';

    if (window.__accentflow_v4) return;
    window.__accentflow_v4 = true;

    // ── State ───────────────────────────────────────────────────────────
    let isActive   = false;
    let audioCtx   = null;
    let streamDest = null;
    let recognition = null;
    let settings   = { rate: 1.0, volume: 1.0, pitch: 1.0, gender: 'male' };
    let voices     = [];

    // Track ALL RTCPeerConnections created on this page
    const allPeerConnections = new Set();

    // ── Save originals ──────────────────────────────────────────────────
    const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const _origRTCPC = window.RTCPeerConnection;

    // ── Voices ──────────────────────────────────────────────────────────
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
    //  AudioContext — created on demand inside user gesture chain
    // ══════════════════════════════════════════════════════════════════
    function ensureAudioContext() {
        if (audioCtx && audioCtx.state !== 'closed') return;
        try {
            audioCtx   = new AudioContext();
            streamDest = audioCtx.createMediaStreamDestination();

            // Tiny oscillator keeps stream alive (prevents WebRTC silence detection)
            const osc = audioCtx.createOscillator();
            const sg  = audioCtx.createGain();
            sg.gain.value = 0.00001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] AudioContext ready, rate=' + audioCtx.sampleRate);
        } catch (e) {
            console.error('[AccentFlow] AudioContext error:', e);
        }
    }

    function getTTSTrack() {
        ensureAudioContext();
        const tracks = streamDest?.stream?.getAudioTracks() || [];
        return tracks[0] || null;
    }

    // ══════════════════════════════════════════════════════════════════
    //  Core: Replace audio on ALL existing peer connections
    //  Called the moment the user clicks Start — retroactive replacement!
    // ══════════════════════════════════════════════════════════════════
    async function replaceAllAudioSenders() {
        ensureAudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        const fakeTrack = getTTSTrack();
        if (!fakeTrack) {
            console.warn('[AccentFlow] No TTS track ready yet');
            return;
        }

        let replaced = 0;
        for (const pc of allPeerConnections) {
            if (pc.connectionState === 'closed') continue;
            for (const sender of pc.getSenders()) {
                if (sender.track?.kind === 'audio') {
                    try {
                        // Attach real mic clock to AudioContext
                        const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([sender.track]));
                        const hwMute = audioCtx.createGain();
                        hwMute.gain.value = 0;
                        hwSrc.connect(hwMute);
                        hwMute.connect(streamDest);
                    } catch(e) {}

                    try {
                        await sender.replaceTrack(fakeTrack);
                        replaced++;
                        console.log('[AccentFlow] ✅ Replaced audio sender track on existing PC');
                    } catch(err) {
                        console.error('[AccentFlow] replaceTrack failed:', err);
                    }
                }
            }
        }
        console.log(`[AccentFlow] Replaced ${replaced} audio sender(s) across ${allPeerConnections.size} PC(s)`);
    }

    // ══════════════════════════════════════════════════════════════════
    //  RTCPeerConnection Constructor Hook
    //  Track every PC created on this page so we can retro-replace
    // ══════════════════════════════════════════════════════════════════
    window.RTCPeerConnection = function(...args) {
        const pc = new _origRTCPC(...args);
        allPeerConnections.add(pc);

        // Clean up closed PCs
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') allPeerConnections.delete(pc);
        });

        console.log('[AccentFlow] RTCPeerConnection created — tracking it');
        return pc;
    };
    window.RTCPeerConnection.prototype = _origRTCPC.prototype;
    window.RTCPeerConnection.generateCertificate = _origRTCPC.generateCertificate?.bind(_origRTCPC);

    // ══════════════════════════════════════════════════════════════════
    //  addTrack / addTransceiver / replaceTrack intercepts
    //  Handles NEW connections created AFTER Start is clicked
    // ══════════════════════════════════════════════════════════════════
    try {
        // ── addTrack ───────────────────────────────────────────────────
        const origAddTrack = _origRTCPC.prototype.addTrack;
        _origRTCPC.prototype.addTrack = function(track, ...streams) {
            if (isActive && track?.kind === 'audio') {
                console.log('[AccentFlow] addTrack intercepted ✅');
                const fakeTrack = getTTSTrack();
                if (fakeTrack) {
                    try {
                        const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([track]));
                        const hwMute = audioCtx.createGain();
                        hwMute.gain.value = 0;
                        hwSrc.connect(hwMute);
                        hwMute.connect(streamDest);
                    } catch(e) {}
                    return origAddTrack.call(this, fakeTrack, ...streams);
                }
            }
            return origAddTrack.call(this, track, ...streams);
        };

        // ── addTransceiver ─────────────────────────────────────────────
        const origAddTransceiver = _origRTCPC.prototype.addTransceiver;
        _origRTCPC.prototype.addTransceiver = function(trackOrKind, init) {
            if (isActive) {
                const isAudio = trackOrKind === 'audio' ||
                    (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio');
                if (isAudio) {
                    console.log('[AccentFlow] addTransceiver intercepted ✅');
                    const fakeTrack = getTTSTrack();
                    if (fakeTrack) {
                        if (trackOrKind instanceof MediaStreamTrack) {
                            try {
                                const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([trackOrKind]));
                                const hwMute = audioCtx.createGain();
                                hwMute.gain.value = 0;
                                hwSrc.connect(hwMute);
                                hwMute.connect(streamDest);
                            } catch(e) {}
                        }
                        return origAddTransceiver.call(this, fakeTrack, init);
                    }
                }
            }
            return origAddTransceiver.call(this, trackOrKind, init);
        };

        // ── replaceTrack ───────────────────────────────────────────────
        const origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
        RTCRtpSender.prototype.replaceTrack = function(newTrack) {
            if (isActive && newTrack?.kind === 'audio') {
                console.log('[AccentFlow] replaceTrack intercepted ✅');
                const fakeTrack = getTTSTrack();
                if (fakeTrack) return origReplaceTrack.call(this, fakeTrack);
            }
            return origReplaceTrack.call(this, newTrack);
        };

        console.log('[AccentFlow] All WebRTC entry points intercepted ✅');
    } catch(e) {
        console.error('[AccentFlow] WebRTC intercept error:', e);
    }

    // ══════════════════════════════════════════════════════════════════
    //  getUserMedia — fallback for simple apps (ViciDial)
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
            try {
                const micSrc   = audioCtx.createMediaStreamSource(realStream);
                const muteGain = audioCtx.createGain();
                muteGain.gain.value = 0;
                micSrc.connect(muteGain);
                muteGain.connect(streamDest);
            } catch(e) {}
            window.__accentflow_realStream = realStream;
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');
            return streamDest.stream;
        } catch (err) {
            console.error('[AccentFlow] GUM error:', err.message);
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
    };
    navigator.mediaDevices.getUserMedia = customGUM;
    try { MediaDevices.prototype.getUserMedia = customGUM; } catch(e) {}
    try {
        if (navigator.getUserMedia) navigator.getUserMedia = (c,s,e) => customGUM(c).then(s).catch(e);
        if (navigator.webkitGetUserMedia) navigator.webkitGetUserMedia = (c,s,e) => customGUM(c).then(s).catch(e);
    } catch(e) {}

    // ══════════════════════════════════════════════════════════════════
    //  TTS — speak text through speakers AND pipe into WebRTC stream
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

        window.speechSynthesis.speak(utterance);

        // Also notify content.js to relay to background for Google TTS stream injection
        window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: text.trim() }, '*');
    }

    async function playAudioIntoStream(audioDataArray) {
        if (!streamDest) return;
        try {
            ensureAudioContext();
            if (audioCtx.state === 'suspended') await audioCtx.resume();
            const buf = new Uint8Array(audioDataArray).buffer.slice(0);
            audioCtx.decodeAudioData(buf, (decoded) => {
                const src  = audioCtx.createBufferSource();
                src.buffer = decoded;
                const gain = audioCtx.createGain();
                gain.gain.value = 1.0;
                src.connect(gain);
                gain.connect(streamDest);
                src.start(0);
                console.log('[AccentFlow] Audio piped into stream ✅');
            }, err => console.error('[AccentFlow] Decode error:', err));
        } catch (e) {
            console.error('[AccentFlow] Pipe error:', e);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Speech Recognition (STT)
    // ══════════════════════════════════════════════════════════════════
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
            if (final?.trim()) speak(final.trim());
        };

        recognition.onend = () => {
            if (isActive) setTimeout(() => {
                if (isActive) try { recognition.start(); } catch(_) {}
            }, 200);
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click lock → Allow mic.' }, '*');
            }
        };

        try { recognition.start(); } catch(_) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch(_) {} recognition = null; }
    }

    // ── Message Bus ─────────────────────────────────────────────────────
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;
        switch (e.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                loadVoices();
                ensureAudioContext();
                startSTT();
                // KEY: Immediately replace tracks on ALL existing peer connections!
                replaceAllAudioSenders();
                console.log('[AccentFlow] ✅ Activated — retroactively replacing all audio senders');
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
                if (e.data.audioData) playAudioIntoStream(e.data.audioData);
                break;
        }
    });

    console.log('[AccentFlow] v4 loaded — constructor hook + retroactive sender replacement active');
})();
