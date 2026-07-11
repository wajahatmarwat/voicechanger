/**
 * AccentFlow Chrome Extension — Inject Script (Stable + SpeechSynthesis)
 *
 * TTS now uses the browser's built-in Web Speech Synthesis API directly.
 * - No network requests, no API keys, no audio buffers
 * - Real male/female American English voices (from system/Chrome)
 * - Audio plays through speakers → Stereo Mix → WhatsApp/ViciDial mic
 */

(function () {
    'use strict';

    if (window.__accentflow_stable) return;
    window.__accentflow_stable = true;

    // ── State ─────────────────────────────────────────────
    let isActive = false;
    let recognition = null;
    let settings = { rate: 1.0, volume: 1.0, pitch: 1.0, gender: 'male' };
    let voices = [];
    let voicesLoaded = false;

    // ── Load Available Voices ─────────────────────────────
    function loadVoices() {
        voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
            voicesLoaded = true;
            // Send available US voices to popup for display
            const usVoices = voices
                .filter(v => v.lang.startsWith('en'))
                .map(v => ({ name: v.name, lang: v.lang }));
            window.postMessage({ type: 'ACCENTFLOW_VOICES', voices: usVoices }, '*');
        }
    }

    // Voices load asynchronously on first call
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices(); // try immediately too

    // ── Voice Selection ────────────────────────────────────
    function findBestVoice(gender) {
        if (voices.length === 0) voices = window.speechSynthesis.getVoices();

        // Priority lists for each gender — US English voices
        const maleKeywords   = ['David', 'Mark', 'Guy', 'Male', 'James', 'Eric', 'Ryan', 'Andrew', 'Christopher'];
        const femaleKeywords = ['Zira', 'Jenny', 'Aria', 'Ana', 'Female', 'Susan', 'Michelle', 'Elizabeth'];

        const keywords = gender === 'male' ? maleKeywords : femaleKeywords;

        // 1. Try exact keyword match in US English
        for (const kw of keywords) {
            const v = voices.find(v => v.lang.startsWith('en-US') && v.name.includes(kw));
            if (v) return v;
        }
        // 2. Try any en-US voice
        const anyUS = voices.find(v => v.lang === 'en-US');
        if (anyUS) return anyUS;
        // 3. Try any English voice
        const anyEn = voices.find(v => v.lang.startsWith('en'));
        if (anyEn) return anyEn;

        return null; // browser will use default
    }

    // ── TTS — Web Speech Synthesis ────────────────────────
    function speak(text) {
        if (!text?.trim() || !isActive) return;

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text.trim());
        utterance.lang   = 'en-US';
        utterance.rate   = settings.rate   || 1.0;
        utterance.volume = settings.volume || 1.0;
        utterance.pitch  = settings.pitch  || 1.0;

        const voice = findBestVoice(settings.gender || 'male');
        if (voice) {
            utterance.voice = voice;
            console.log('[AccentFlow] 🗣 Speaking with voice:', voice.name);
        }

        utterance.onstart = () => window.postMessage({ type: 'ACCENTFLOW_SPEAKING' }, '*');
        utterance.onend   = () => window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        utterance.onerror = (e) => {
            console.error('[AccentFlow] TTS error:', e.error);
            window.postMessage({ type: 'ACCENTFLOW_SPEECH_DONE' }, '*');
        };

        window.speechSynthesis.speak(utterance);
    }

    // ── Speech Recognition (STT) ──────────────────────────
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

            if (interim) {
                window.postMessage({ type: 'ACCENTFLOW_INTERIM', text: interim }, '*');
            }
            if (final?.trim()) {
                const clean = final.trim();
                window.postMessage({ type: 'ACCENTFLOW_FINAL_TEXT', text: clean }, '*');
                // Speak immediately via browser TTS (no network needed!)
                speak(clean);
            }
        };

        recognition.onend = () => {
            if (isActive) {
                setTimeout(() => {
                    if (isActive) try { recognition.start(); } catch (_) {}
                }, 200);
            }
        };

        recognition.onerror = (e) => {
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                window.postMessage({
                    type: 'ACCENTFLOW_ERROR',
                    error: 'Mic permission denied. Click the lock icon → Allow microphone.',
                }, '*');
            }
        };

        try { recognition.start(); } catch (_) {}
    }

    function stopSTT() {
        if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
    }

    // ── Message Listener ──────────────────────────────────
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data?.type) return;

        switch (e.data.type) {
            case 'ACCENTFLOW_ACTIVATE':
                isActive = true;
                loadVoices();
                startSTT();
                console.log('[AccentFlow] ✅ Activated — STT + SpeechSynthesis TTS ready');
                window.postMessage({ type: 'ACCENTFLOW_READY' }, '*');
                break;

            case 'ACCENTFLOW_DEACTIVATE':
                isActive = false;
                stopSTT();
                window.speechSynthesis.cancel();
                console.log('[AccentFlow] ⏹ Deactivated');
                break;

            case 'ACCENTFLOW_UPDATE_SETTINGS':
                if (e.data.settings) {
                    settings = { ...settings, ...e.data.settings };
                    console.log('[AccentFlow] Settings updated:', settings);
                }
                break;

            // No longer used — kept for backward compat
            case 'ACCENTFLOW_PLAY_AUDIO':
                break;
        }
    });

    console.log('[AccentFlow] 🚀 Stable inject loaded — SpeechSynthesis TTS (no network, male/female voices)');
})();
