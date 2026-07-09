/**
 * AccentFlow Chrome Extension — Popup Controller
 * Handles popup UI interactions and communicates with background service worker
 */

document.addEventListener('DOMContentLoaded', () => {
    // ── DOM Elements ────────────────────────────────────
    const mainBtn = document.getElementById('mainBtn');
    const controlLabel = document.getElementById('controlLabel');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const originalBox = document.getElementById('originalBox');
    const convertedBox = document.getElementById('convertedBox');
    const speedSlider = document.getElementById('speedSlider');
    const speedValue = document.getElementById('speedValue');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    const toast = document.getElementById('toast');

    // ── State ───────────────────────────────────────────
    let isActive = false;
    let settings = { rate: 1.0, volume: 1.0 };

    // ── Connect to Background ───────────────────────────
    const port = chrome.runtime.connect({ name: 'accentflow-popup' });

    port.onMessage.addListener((msg) => {
        switch (msg.type) {
            case 'state':
                // Initial state from background
                if (msg.data.isActive) {
                    isActive = true;
                    setActiveUI();
                }
                break;

            case 'activated':
                isActive = true;
                setActiveUI();
                showToast('✅ AccentFlow active! Now open ViciDial in this tab.', 'success');
                break;

            case 'deactivated':
                isActive = false;
                setIdleUI();
                break;

            case 'transcript':
                addTranscriptLine(originalBox, msg.data, 'final');
                break;

            case 'interim':
                updateInterim(originalBox, msg.data);
                break;

            case 'converted':
                addTranscriptLine(convertedBox, msg.data, 'final');
                break;

            case 'speaking':
                statusDot.className = 'status-dot speaking';
                statusText.textContent = 'Converting accent...';
                controlLabel.textContent = 'Converting...';
                controlLabel.className = 'control-label speaking';
                break;

            case 'speechDone':
                if (isActive) {
                    statusDot.className = 'status-dot active';
                    statusText.textContent = 'Listening...';
                    controlLabel.textContent = 'Listening...';
                    controlLabel.className = 'control-label active';
                }
                break;

            case 'error':
                showToast('❌ ' + msg.data, 'error');
                break;
        }
    });

    // ── UI Updates ──────────────────────────────────────
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

    function addTranscriptLine(container, text, type) {
        // Remove empty state
        const empty = container.querySelector('.transcript-empty');
        if (empty) empty.remove();

        // Remove interim
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

    function showToast(message, type) {
        toast.textContent = message;
        toast.className = `toast visible ${type}`;
        setTimeout(() => {
            toast.className = 'toast';
        }, 3500);
    }

    // ── Event Listeners ─────────────────────────────────
    mainBtn.addEventListener('click', () => {
        if (isActive) {
            port.postMessage({ action: 'deactivate' });
        } else {
            port.postMessage({ action: 'activate' });
        }
    });

    speedSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        settings.rate = val;
        speedValue.textContent = val.toFixed(1) + 'x';
        port.postMessage({ action: 'updateSettings', settings });
    });

    volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        settings.volume = val;
        volumeValue.textContent = Math.round(val * 100) + '%';
        port.postMessage({ action: 'updateSettings', settings });
    });

    // ── Load Saved Settings ─────────────────────────────
    chrome.storage.local.get('accentflow_settings', (result) => {
        if (result.accentflow_settings) {
            settings = result.accentflow_settings;

            if (settings.rate) {
                speedSlider.value = settings.rate;
                speedValue.textContent = settings.rate.toFixed(1) + 'x';
            }
            if (settings.volume !== undefined) {
                volumeSlider.value = settings.volume;
                volumeValue.textContent = Math.round(settings.volume * 100) + '%';
            }
        }
    });
});
