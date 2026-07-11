/**
 * AccentFlow Chrome Extension — Popup Controller (Updated)
 * Handles voice gender selection, pitch, speed, volume settings.
 * TTS is now done via Web SpeechSynthesis in inject.js (no network needed).
 */

document.addEventListener('DOMContentLoaded', () => {
    // ── DOM Elements ────────────────────────────────────
    const mainBtn     = document.getElementById('mainBtn');
    const controlLabel = document.getElementById('controlLabel');
    const statusDot   = document.getElementById('statusDot');
    const statusText  = document.getElementById('statusText');
    const originalBox = document.getElementById('originalBox');
    const convertedBox = document.getElementById('convertedBox');

    const maleBtn    = document.getElementById('maleBtn');
    const femaleBtn  = document.getElementById('femaleBtn');

    const speedSlider  = document.getElementById('speedSlider');
    const speedValue   = document.getElementById('speedValue');
    const pitchSlider  = document.getElementById('pitchSlider');
    const pitchValue   = document.getElementById('pitchValue');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue  = document.getElementById('volumeValue');
    const toast        = document.getElementById('toast');

    // ── State ───────────────────────────────────────────
    let isActive = false;
    let settings = { rate: 1.0, pitch: 1.0, volume: 1.0, gender: 'male' };

    // ── Connect to Background ───────────────────────────
    const port = chrome.runtime.connect({ name: 'accentflow-popup' });

    port.onMessage.addListener((msg) => {
        switch (msg.type) {
            case 'state':
                if (msg.data.isActive) { isActive = true; setActiveUI(); }
                break;
            case 'activated':
                isActive = true;
                setActiveUI();
                showToast('✅ AccentFlow active! Start speaking.', 'success');
                break;
            case 'deactivated':
                isActive = false;
                setIdleUI();
                break;
            case 'transcript':
                addTranscriptLine(originalBox, msg.data, 'final');
                addTranscriptLine(convertedBox, msg.data, 'final'); // same text, different accent audio
                break;
            case 'interim':
                updateInterim(originalBox, msg.data);
                break;
            case 'speaking':
                statusDot.className = 'status-dot speaking';
                statusText.textContent = 'Speaking American accent...';
                controlLabel.textContent = 'Speaking...';
                controlLabel.className = 'control-label speaking';
                break;
            case 'speechDone':
                if (isActive) {
                    statusDot.className = 'status-dot active';
                    statusText.textContent = 'Listening — speak now';
                    controlLabel.textContent = 'Listening...';
                    controlLabel.className = 'control-label active';
                }
                break;
            case 'error':
                showToast('❌ ' + msg.data, 'error');
                break;
        }
    });

    // ── UI State ────────────────────────────────────────
    function setActiveUI() {
        mainBtn.classList.add('active');
        controlLabel.textContent = 'Listening...';
        controlLabel.className = 'control-label active';
        statusDot.className = 'status-dot active';
        statusText.textContent = 'Listening — speak now';
    }

    function setIdleUI() {
        mainBtn.classList.remove('active');
        controlLabel.textContent = 'Press to Start';
        controlLabel.className = 'control-label';
        statusDot.className = 'status-dot';
        statusText.textContent = 'Ready — Click Start to begin';
    }

    // ── Transcript ──────────────────────────────────────
    function addTranscriptLine(container, text, type) {
        const empty = container.querySelector('.transcript-empty');
        if (empty) empty.remove();
        const interim = container.querySelector('.transcript-line.interim');
        if (interim) interim.remove();

        const line = document.createElement('div');
        line.className = `transcript-line ${type}`;
        line.textContent = text;
        container.appendChild(line);
        container.scrollTop = container.scrollHeight;
    }

    function updateInterim(container, text) {
        const empty = container.querySelector('.transcript-empty');
        if (empty) empty.remove();
        let interim = container.querySelector('.transcript-line.interim');
        if (!interim) {
            interim = document.createElement('div');
            interim.className = 'transcript-line interim';
            container.appendChild(interim);
        }
        interim.textContent = text;
        container.scrollTop = container.scrollHeight;
    }

    // ── Toast ────────────────────────────────────────────
    function showToast(message, type) {
        toast.textContent = message;
        toast.className = `toast visible ${type}`;
        setTimeout(() => { toast.className = 'toast'; }, 3500);
    }

    // ── Send Settings to Content Script ─────────────────
    function pushSettings() {
        port.postMessage({ action: 'updateSettings', settings });
        chrome.storage.local.set({ accentflow_settings: settings });
    }

    // ── Event Listeners ─────────────────────────────────

    // Start / Stop button
    mainBtn.addEventListener('click', () => {
        port.postMessage({ action: isActive ? 'deactivate' : 'activate' });
    });

    // Gender toggle — Male
    maleBtn.addEventListener('click', () => {
        settings.gender = 'male';
        settings.pitch  = 0.85; // slightly lower pitch for male voice
        maleBtn.classList.add('active');
        femaleBtn.classList.remove('active');
        pitchSlider.value = settings.pitch;
        pitchValue.textContent = settings.pitch.toFixed(1);
        pushSettings();
        showToast('👨 Male American voice selected', 'success');
    });

    // Gender toggle — Female
    femaleBtn.addEventListener('click', () => {
        settings.gender = 'female';
        settings.pitch  = 1.2; // slightly higher pitch for female voice
        femaleBtn.classList.add('active');
        maleBtn.classList.remove('active');
        pitchSlider.value = settings.pitch;
        pitchValue.textContent = settings.pitch.toFixed(1);
        pushSettings();
        showToast('👩 Female American voice selected', 'success');
    });

    // Speed slider
    speedSlider.addEventListener('input', (e) => {
        settings.rate = parseFloat(e.target.value);
        speedValue.textContent = settings.rate.toFixed(1) + 'x';
        pushSettings();
    });

    // Pitch slider
    pitchSlider.addEventListener('input', (e) => {
        settings.pitch = parseFloat(e.target.value);
        pitchValue.textContent = settings.pitch.toFixed(1);
        pushSettings();
    });

    // Volume slider
    volumeSlider.addEventListener('input', (e) => {
        settings.volume = parseFloat(e.target.value);
        volumeValue.textContent = Math.round(settings.volume * 100) + '%';
        pushSettings();
    });

    // ── Load Saved Settings ─────────────────────────────
    chrome.storage.local.get('accentflow_settings', (result) => {
        if (!result.accentflow_settings) return;
        settings = { ...settings, ...result.accentflow_settings };

        if (settings.rate) {
            speedSlider.value = settings.rate;
            speedValue.textContent = settings.rate.toFixed(1) + 'x';
        }
        if (settings.pitch) {
            pitchSlider.value = settings.pitch;
            pitchValue.textContent = settings.pitch.toFixed(1);
        }
        if (settings.volume !== undefined) {
            volumeSlider.value = settings.volume;
            volumeValue.textContent = Math.round(settings.volume * 100) + '%';
        }
        if (settings.gender === 'female') {
            femaleBtn.classList.add('active');
            maleBtn.classList.remove('active');
        } else {
            maleBtn.classList.add('active');
            femaleBtn.classList.remove('active');
        }
    });
});
