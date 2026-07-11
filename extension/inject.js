/**
 * AccentFlow Chrome Extension — Inject Script v6
 *
 * ARCHITECTURE:
 *  1. getUserMedia is intercepted → real mic routed at 5% + TTS at 100%
 *     → both go into streamDest → returned as the "microphone"
 *  2. WhatsApp's audio activity detector sees the 5% real mic → no "mic error"
 *  3. When user speaks → TTS audio fires at 100% → dominates the real voice
 *  4. The caller hears mostly American TTS (some tiny real voice leakage)
 *  5. RTCPeerConnection constructor is tracked for retroactive replacement
 *
 *  AudioContext is created eagerly and resumed on any user interaction.
 *  We do NOT gate intercepts on audioCtx.state==='running' anymore.
 */

(function () {
    'use strict';

    if (window.__accentflow_v6) return;
    window.__accentflow_v6 = true;

    // ── State ───────────────────────────────────────────────────────────
    let isActive    = false;
    let audioCtx    = null;
    let streamDest  = null;
    let realMicGain = null;   // GainNode for real mic (5% normally)
    let ttsGain     = null;   // GainNode for TTS audio (0% normally, 100% when speaking)
    let recognition = null;
    let settings    = { rate: 1.0, volume: 1.0, pitch: 1.0, gender: 'male' };
    let voices      = [];

    const allPCs = new Set();

    // ── Originals ───────────────────────────────────────────────────────
    const _origGUM   = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
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
    //  AudioContext Setup — called inside getUserMedia (user gesture ✅)
    // ══════════════════════════════════════════════════════════════════
    function setupAudioPipeline(realStream) {
        if (audioCtx && audioCtx.state !== 'closed') return;

        try {
            audioCtx   = new AudioContext();
            streamDest = audioCtx.createMediaStreamDestination();

            // Real mic → 5% gain → streamDest
            // This prevents WhatsApp's "mic not working" detector from triggering
            realMicGain = audioCtx.createGain();
            realMicGain.gain.value = 0.05; // 5% of real voice leaks through

            const micSrc = audioCtx.createMediaStreamSource(realStream);
            micSrc.connect(realMicGain);
            realMicGain.connect(streamDest);

            // TTS audio gain node (starts at 0, jumps to 1.0 when TTS plays)
            ttsGain = audioCtx.createGain();
            ttsGain.gain.value = 0;
            ttsGain.connect(streamDest);

            // Tiny oscillator keeps stream alive
            const osc = audioCtx.createOscillator();
            const sg  = audioCtx.createGain();
            sg.gain.value = 0.0001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] Audio pipeline ready, ctx=' + audioCtx.state);
        } catch (e) {
            console.error('[AccentFlow] AudioContext error:', e);
        }
    }

    // Resume AudioContext on any user gesture (capture phase = before WhatsApp handlers)
    function tryResume() {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                console.log('[AccentFlow] AudioContext resumed ✅');
                if (isActive) replaceAllAudioSenders();
            }).catch(() => {});
        }
    }
    document.addEventListener('click',      tryResume, { capture: true, passive: true });
    document.addEventListener('touchstart', tryResume, { capture: true, passive: true });
    document.addEventListener('mousedown',  tryResume, { capture: true, passive: true });

    // ══════════════════════════════════════════════════════════════════
    //  Play TTS audio from background (MP3 bytes via audio element)
    //  Piped into streamDest via ttsGain → caller hears it
    // ══════════════════════════════════════════════════════════════════
    async function playAudioData(audioDataArray) {
        if (!audioCtx || !streamDest || !ttsGain) {
            console.warn('[AccentFlow] Audio pipeline not ready');
            return;
        }

        try {
            if (audioCtx.state === 'suspended') {
                try { await audioCtx.resume(); } catch(e) {}
            }

            const blob    = new Blob([new Uint8Array(audioDataArray)], { type: 'audio/mpeg' });
            const blobURL = URL.createObjectURL(blob);

            const el = document.createElement('audio');
            el.src           = blobURL;
            el.style.display = 'none';
            document.body.appendChild(el);

            // Tap audio into Web Audio graph
            const src = audioCtx.createMediaElementSource(el);
            src.connect(audioCtx.destination); // → speakers (user monitors)
            src.connect(ttsGain);              // → streamDest → WebRTC (caller hears)

            // Boost TTS, mute real mic while speaking
            realMicGain.gain.setValueAtTime(0,    audioCtx.currentTime);
            ttsGain.gain.setValueAtTime(1.0,       audioCtx.currentTime);

            el.onended = () => {
                // Restore real mic leakage, mute TTS
                realMicGain.gain.setValueAtTime(0.05, audioCtx.currentTime);
                ttsGain.gain.setValueAtTime(0,        audioCtx.currentTime);
                URL.revokeObjectURL(blobURL);
                el.remove();
                window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                console.log('[AccentFlow] TTS done, mic restored');
            };

            el.onerror = (err) => {
                console.error('[AccentFlow] Audio element error:', err);
                realMicGain.gain.setValueAtTime(0.05, audioCtx.currentTime);
                ttsGain.gain.setValueAtTime(0,        audioCtx.currentTime);
                URL.revokeObjectURL(blobURL);
                el.remove();
                window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                speakFallback(el._text || '');
            };

            window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            await el.play();

            console.log('[AccentFlow] TTS playing via audio element → stream ✅');
        } catch (e) {
            console.error('[AccentFlow] playAudioData error:', e);
            window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        }
    }

    function speakFallback(text) {
        if (!text?.trim()) return;
        window.speechSynthesis.cancel();
        const u    = new SpeechSynthesisUtterance(text.trim());
        u.lang     = 'en-US';
        u.rate     = settings.rate   || 1.0;
        u.volume   = settings.volume || 1.0;
        u.pitch    = settings.pitch  || 1.0;
        const v    = findVoice(settings.gender || 'male');
        if (v) u.voice = v;
        u.onstart  = () => window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
        u.onend    = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        window.speechSynthesis.speak(u);
    }

    function speak(text) {
        if (!text?.trim() || !isActive) return;
        // SpeechSynthesis fires immediately as audio fallback (user hears right away)
        speakFallback(text);
        // Request background to fetch real TTS MP3 for stream injection
        window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: text.trim() }, '*');
    }

    // ══════════════════════════════════════════════════════════════════
    //  getUserMedia — the primary injection point
    //  Creates audio pipeline with real mic + TTS mix → returned to app
    // ══════════════════════════════════════════════════════════════════
    const customGUM = async function(constraints) {
        if (!constraints?.audio) {
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
        if (!isActive) {
            return _origGUM.call(navigator.mediaDevices, constraints);
        }

        console.log('[AccentFlow] getUserMedia intercepted — building audio pipeline');

        try {
            // Get real mic (permission stays valid, provides hardware clock)
            const realStream = await _origGUM.call(navigator.mediaDevices, {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 48000,
                },
                video: false,
            });

            // Set up audio pipeline INSIDE getUserMedia — user gesture chain ✅
            setupAudioPipeline(realStream);

            if (audioCtx && audioCtx.state === 'suspended') {
                try { await audioCtx.resume(); } catch(e) {}
            }

            window.__accentflow_realStream = realStream;
            window.postMessage({ type: 'ACCENTFLOW_MIC_READY' }, '*');

            console.log('[AccentFlow] Returning mixed stream (5% real + TTS) ✅');
            return streamDest.stream;

        } catch (err) {
            console.error('[AccentFlow] GUM error, using real mic:', err.message);
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
    };

    navigator.mediaDevices.getUserMedia = customGUM;
    try { MediaDevices.prototype.getUserMedia = customGUM; } catch(e) {}
    try {
        if (navigator.getUserMedia)       navigator.getUserMedia       = (c,s,e) => customGUM(c).then(s).catch(e);
        if (navigator.webkitGetUserMedia) navigator.webkitGetUserMedia = (c,s,e) => customGUM(c).then(s).catch(e);
    } catch(e) {}

    // ══════════════════════════════════════════════════════════════════
    //  RTCPeerConnection constructor hook — track all PCs
    // ══════════════════════════════════════════════════════════════════
    window.RTCPeerConnection = function(...args) {
        const pc = new _origRTCPC(...args);
        allPCs.add(pc);
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') allPCs.delete(pc);
        });
        return pc;
    };
    window.RTCPeerConnection.prototype = _origRTCPC.prototype;
    try { window.RTCPeerConnection.generateCertificate = _origRTCPC.generateCertificate?.bind(_origRTCPC); } catch(e) {}

    // ══════════════════════════════════════════════════════════════════
    //  Retroactive sender replacement (fallback if GUM intercept missed)
    // ══════════════════════════════════════════════════════════════════
    async function replaceAllAudioSenders() {
        if (!streamDest) return;

        const fakeTrack = streamDest.stream.getAudioTracks()[0];
        if (!fakeTrack) return;

        for (const pc of allPCs) {
            if (pc.signalingState === 'closed') { allPCs.delete(pc); continue; }
            for (const sender of pc.getSenders()) {
                if (sender.track?.kind === 'audio' && sender.track !== fakeTrack) {
                    try {
                        await sender.replaceTrack(fakeTrack);
                        console.log('[AccentFlow] Retroactively replaced sender ✅');
                    } catch(err) {
                        console.warn('[AccentFlow] replaceTrack failed:', err.message);
                    }
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  WebRTC intercepts — for connections created after Start
    // ══════════════════════════════════════════════════════════════════
    try {
        const origAddTrack = _origRTCPC.prototype.addTrack;
        _origRTCPC.prototype.addTrack = function(track, ...streams) {
            if (isActive && track?.kind === 'audio' && streamDest) {
                const fakeTrack = streamDest.stream.getAudioTracks()[0];
                if (fakeTrack && fakeTrack !== track) {
                    console.log('[AccentFlow] addTrack swapped ✅');
                    return origAddTrack.call(this, fakeTrack, ...streams);
                }
            }
            return origAddTrack.call(this, track, ...streams);
        };

        const origAddTransceiver = _origRTCPC.prototype.addTransceiver;
        _origRTCPC.prototype.addTransceiver = function(trackOrKind, init) {
            if (isActive && streamDest) {
                const isAudio = trackOrKind === 'audio' ||
                    (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio');
                if (isAudio) {
                    const fakeTrack = streamDest.stream.getAudioTracks()[0];
                    if (fakeTrack) {
                        console.log('[AccentFlow] addTransceiver swapped ✅');
                        return origAddTransceiver.call(this, fakeTrack, init);
                    }
                }
            }
            return origAddTransceiver.call(this, trackOrKind, init);
        };

        const origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
        RTCRtpSender.prototype.replaceTrack = function(newTrack) {
            if (isActive && newTrack?.kind === 'audio' && streamDest) {
                const fakeTrack = streamDest.stream.getAudioTracks()[0];
                if (fakeTrack && fakeTrack !== newTrack) {
                    console.log('[AccentFlow] replaceTrack swapped ✅');
                    return origReplaceTrack.call(this, fakeTrack);
                }
            }
            return origReplaceTrack.call(this, newTrack);
        };

        console.log('[AccentFlow] WebRTC fully intercepted ✅');
    } catch(e) {
        console.error('[AccentFlow] WebRTC hook error:', e);
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
                startSTT();
                console.log('[AccentFlow] ✅ Activated v6 — click WhatsApp page then call');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                window.speechSynthesis.cancel();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; streamDest = null; realMicGain = null; ttsGain = null; }
                console.log('[AccentFlow] ⏹ Deactivated');
                break;

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (e.data.settings) settings = { ...settings, ...e.data.settings };
                break;

            case 'ACCENTFLOW_PLAY_AUDIO':
                if (e.data.audioData) {
                    window.speechSynthesis.cancel();
                    playAudioData(e.data.audioData);
                }
                break;
        }
    });

    console.log('[AccentFlow] v6 loaded — real mic 5% + TTS 100% pipeline');
})();
