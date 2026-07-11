/**
 * AccentFlow Chrome Extension — Inject Script v5
 *
 * THE FIX: SpeechSynthesis audio CANNOT be captured by Web Audio API.
 * They are completely separate audio pipelines in Chrome.
 *
 * SOLUTION:
 *  - Background.js fetches Google TTS as an MP3 ArrayBuffer
 *  - We create a hidden <audio> element and play the MP3 through it
 *  - We use createMediaElementSource() to tap into that audio element
 *  - That source is connected to BOTH:
 *      1. audioCtx.destination → plays through speakers (user hears it) ✅
 *      2. streamDest → goes into the WebRTC stream (caller hears it) ✅
 *
 *  RTCPeerConnection constructor is hooked to track all PCs, and
 *  replaceAllAudioSenders() retroactively swaps tracks when Start is clicked.
 *
 *  AudioContext is resumed on any page click (capture listener) so it's
 *  always running when the user clicks Call in WhatsApp.
 */

(function () {
    'use strict';

    if (window.__accentflow_v5) return;
    window.__accentflow_v5 = true;

    // ── State ───────────────────────────────────────────────────────────
    let isActive    = false;
    let audioCtx    = null;
    let streamDest  = null;
    let recognition = null;
    let settings    = { rate: 1.0, volume: 1.0, pitch: 1.0, gender: 'male' };
    let voices      = [];
    let audioContextResumed = false;

    // Track ALL RTCPeerConnections created on this page
    const allPCs = new Set();

    // ── Save originals ──────────────────────────────────────────────────
    const _origGUM   = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const _origRTCPC = window.RTCPeerConnection;

    // ── Voices (for SpeechSynthesis fallback) ───────────────────────────
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
    //  AudioContext — created eagerly, resumed on user click
    // ══════════════════════════════════════════════════════════════════
    function ensureAudioContext() {
        if (audioCtx && audioCtx.state !== 'closed') return;
        try {
            audioCtx   = new AudioContext();
            streamDest = audioCtx.createMediaStreamDestination();

            // Silent oscillator keeps the stream "alive" so WebRTC
            // doesn't mark it as inactive and silence it
            const osc = audioCtx.createOscillator();
            const sg  = audioCtx.createGain();
            sg.gain.value = 0.00001;
            osc.connect(sg);
            sg.connect(streamDest);
            osc.start();

            console.log('[AccentFlow] AudioContext created, state=' + audioCtx.state);
        } catch (e) {
            console.error('[AccentFlow] AudioContext error:', e);
        }
    }

    // Resume AudioContext on any user interaction with the page
    // This ensures it's running when user clicks Call in WhatsApp
    function resumeAudioCtx() {
        if (!audioCtx || audioContextResumed) return;
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                audioContextResumed = true;
                console.log('[AccentFlow] AudioContext resumed via user click ✅');
                // If already active, replace any existing senders now
                if (isActive) replaceAllAudioSenders();
            }).catch(e => console.warn('[AccentFlow] Resume failed:', e));
        } else {
            audioContextResumed = true;
        }
    }

    // Capture-phase listener fires BEFORE WhatsApp's own click handlers
    document.addEventListener('click', resumeAudioCtx, { capture: true, passive: true });
    document.addEventListener('touchstart', resumeAudioCtx, { capture: true, passive: true });

    function getTTSTrack() {
        ensureAudioContext();
        return streamDest?.stream?.getAudioTracks()[0] || null;
    }

    // ══════════════════════════════════════════════════════════════════
    //  THE KEY FUNCTION: Play audio via <audio> element, piped into stream
    //  audio element → MediaElementSource → streamDest (WebRTC) ✅
    //                                     → audioCtx.destination (speakers) ✅
    // ══════════════════════════════════════════════════════════════════
    async function playAudioData(audioDataArray) {
        try {
            ensureAudioContext();

            if (audioCtx.state === 'suspended') {
                try { await audioCtx.resume(); } catch(e) {}
            }

            // Build a Blob URL from the MP3 bytes received from background.js
            const blob    = new Blob([new Uint8Array(audioDataArray)], { type: 'audio/mpeg' });
            const blobURL = URL.createObjectURL(blob);

            // Create a hidden audio element
            const el = document.createElement('audio');
            el.src             = blobURL;
            el.crossOrigin     = 'anonymous';
            el.style.display   = 'none';
            document.body.appendChild(el);

            // Tap into the audio element's output with Web Audio API
            const src = audioCtx.createMediaElementSource(el);

            // Connect to BOTH output destinations:
            src.connect(audioCtx.destination);  // → speakers (user hears it) ✅
            src.connect(streamDest);             // → WebRTC stream (caller hears it) ✅

            el.onended = () => {
                URL.revokeObjectURL(blobURL);
                el.remove();
                window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
            };
            el.onerror = () => {
                URL.revokeObjectURL(blobURL);
                el.remove();
                window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
                // Fall back to SpeechSynthesis for local audio
                speakFallback(el._text || '');
            };

            window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
            await el.play();

            console.log('[AccentFlow] Playing via audio element → stream ✅');
        } catch (e) {
            console.error('[AccentFlow] Audio element playback failed:', e);
            window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        }
    }

    // SpeechSynthesis fallback — only for local monitoring when TTS fetch fails
    function speakFallback(text) {
        if (!text?.trim()) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.trim());
        u.lang   = 'en-US';
        u.rate   = settings.rate   || 1.0;
        u.volume = settings.volume || 1.0;
        u.pitch  = settings.pitch  || 1.0;
        const voice = findVoice(settings.gender || 'male');
        if (voice) u.voice = voice;
        u.onstart = () => window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
        u.onend   = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        window.speechSynthesis.speak(u);
    }

    function speak(text) {
        if (!text?.trim() || !isActive) return;
        window.speechSynthesis.cancel();
        // Send to background for Google TTS fetch (which uses audio element for stream injection)
        // SpeechSynthesis fires immediately as fallback in case background is slow
        speakFallback(text);
        window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: text.trim() }, '*');
    }

    // ══════════════════════════════════════════════════════════════════
    //  Retroactive sender replacement — runs when Start is clicked
    // ══════════════════════════════════════════════════════════════════
    async function replaceAllAudioSenders() {
        if (!audioCtx || audioCtx.state === 'suspended') {
            console.log('[AccentFlow] AudioContext not ready for replaceAllSenders — waiting for click');
            return;
        }

        const fakeTrack = getTTSTrack();
        if (!fakeTrack) return;

        let replaced = 0;
        for (const pc of allPCs) {
            if (pc.signalingState === 'closed') { allPCs.delete(pc); continue; }
            for (const sender of pc.getSenders()) {
                if (sender.track?.kind === 'audio') {
                    // Anchor hardware clock
                    try {
                        const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([sender.track]));
                        const hwMute = audioCtx.createGain();
                        hwMute.gain.value = 0;
                        hwSrc.connect(hwMute);
                        hwMute.connect(streamDest);
                    } catch(e) {}

                    try {
                        await sender.replaceTrack(fakeTrack);
                        replaced++;
                        console.log('[AccentFlow] ✅ Retroactively replaced audio sender');
                    } catch(err) {
                        console.error('[AccentFlow] replaceTrack error:', err.message);
                    }
                }
            }
        }
        console.log(`[AccentFlow] Done: replaced ${replaced} sender(s) on ${allPCs.size} PC(s)`);
    }

    // ══════════════════════════════════════════════════════════════════
    //  RTCPeerConnection Constructor Hook
    // ══════════════════════════════════════════════════════════════════
    window.RTCPeerConnection = function(...args) {
        const pc = new _origRTCPC(...args);
        allPCs.add(pc);
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'closed') allPCs.delete(pc);
        });
        console.log('[AccentFlow] RTCPeerConnection created — tracking');

        // If already active when PC is created, replace its senders after negotiation
        if (isActive) {
            pc.addEventListener('track', () => {
                setTimeout(() => replaceAllAudioSenders(), 500);
            });
        }
        return pc;
    };
    window.RTCPeerConnection.prototype = _origRTCPC.prototype;
    try { window.RTCPeerConnection.generateCertificate = _origRTCPC.generateCertificate?.bind(_origRTCPC); } catch(e) {}

    // ══════════════════════════════════════════════════════════════════
    //  WebRTC Intercepts (for new connections created after Start)
    // ══════════════════════════════════════════════════════════════════
    try {
        // addTrack
        const origAddTrack = _origRTCPC.prototype.addTrack;
        _origRTCPC.prototype.addTrack = function(track, ...streams) {
            if (isActive && track?.kind === 'audio' && audioCtx?.state === 'running') {
                const fakeTrack = getTTSTrack();
                if (fakeTrack) {
                    try {
                        const hwSrc  = audioCtx.createMediaStreamSource(new MediaStream([track]));
                        const hwMute = audioCtx.createGain();
                        hwMute.gain.value = 0;
                        hwSrc.connect(hwMute);
                        hwMute.connect(streamDest);
                    } catch(e) {}
                    console.log('[AccentFlow] addTrack swapped ✅');
                    return origAddTrack.call(this, fakeTrack, ...streams);
                }
            }
            return origAddTrack.call(this, track, ...streams);
        };

        // addTransceiver (WhatsApp uses this!)
        const origAddTransceiver = _origRTCPC.prototype.addTransceiver;
        _origRTCPC.prototype.addTransceiver = function(trackOrKind, init) {
            if (isActive && audioCtx?.state === 'running') {
                const isAudio = trackOrKind === 'audio' ||
                    (trackOrKind instanceof MediaStreamTrack && trackOrKind.kind === 'audio');
                if (isAudio) {
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
                        console.log('[AccentFlow] addTransceiver swapped ✅');
                        return origAddTransceiver.call(this, fakeTrack, init);
                    }
                }
            }
            return origAddTransceiver.call(this, trackOrKind, init);
        };

        // replaceTrack
        const origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
        RTCRtpSender.prototype.replaceTrack = function(newTrack) {
            if (isActive && newTrack?.kind === 'audio' && audioCtx?.state === 'running') {
                const fakeTrack = getTTSTrack();
                if (fakeTrack) {
                    console.log('[AccentFlow] replaceTrack swapped ✅');
                    return origReplaceTrack.call(this, fakeTrack);
                }
            }
            return origReplaceTrack.call(this, newTrack);
        };

        console.log('[AccentFlow] All WebRTC entry points hooked ✅');
    } catch(e) {
        console.error('[AccentFlow] WebRTC hook error:', e);
    }

    // ══════════════════════════════════════════════════════════════════
    //  getUserMedia fallback (for ViciDial and simple apps)
    // ══════════════════════════════════════════════════════════════════
    const customGUM = async function(constraints) {
        if (!isActive || !constraints?.audio) {
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
        try {
            const realStream = await _origGUM.call(navigator.mediaDevices, {
                audio: { echoCancellation: true, noiseSuppression: true },
                video: false,
            });
            ensureAudioContext();
            if (audioCtx.state === 'suspended') await audioCtx.resume();
            audioContextResumed = true;
            try {
                const micSrc   = audioCtx.createMediaStreamSource(realStream);
                const muteGain = audioCtx.createGain();
                muteGain.gain.value = 0;
                micSrc.connect(muteGain);
                muteGain.connect(streamDest);
            } catch(e) {}
            window.__accentflow_realStream = realStream;
            console.log('[AccentFlow] getUserMedia returning TTS stream ✅');
            return streamDest.stream;
        } catch(err) {
            console.error('[AccentFlow] GUM error:', err.message);
            return _origGUM.call(navigator.mediaDevices, constraints);
        }
    };
    navigator.mediaDevices.getUserMedia = customGUM;
    try { MediaDevices.prototype.getUserMedia = customGUM; } catch(e) {}

    // ══════════════════════════════════════════════════════════════════
    //  Speech Recognition
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
                window.postMessage({ type: 'ACCENTFLOW_ERROR', error: 'Mic denied. Click the lock icon → Allow mic.' }, '*');
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
                // Try immediate replacement (works if AudioContext already running)
                replaceAllAudioSenders();
                console.log('[AccentFlow] ✅ Activated v5');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                audioContextResumed = false;
                stopSTT();
                window.speechSynthesis.cancel();
                if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; streamDest = null; }
                console.log('[AccentFlow] ⏹ Deactivated');
                break;

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (e.data.settings) settings = { ...settings, ...e.data.settings };
                break;

            case 'ACCENTFLOW_PLAY_AUDIO':
                // Audio from background.js Google TTS fetch
                // Play via audio element → pipes into BOTH speakers AND WebRTC stream
                if (e.data.audioData) {
                    window.speechSynthesis.cancel(); // stop SpeechSynthesis fallback
                    playAudioData(e.data.audioData);
                }
                break;
        }
    });

    console.log('[AccentFlow] v5 loaded — audio element pipeline (speakers + stream) active');
})();
