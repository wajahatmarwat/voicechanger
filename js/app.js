/**
 * AccentFlow — Main Application Controller
 * Orchestrates the speech engine, visualizer, UI interactions, and settings
 */

class AccentFlowApp {
    constructor() {
        // Modules
        this.speech = null;
        this.visualizer = null;

        // State
        this.isRunning = false;
        this.settingsVisible = true;

        // DOM References (populated in init)
        this.els = {};

        // Bind methods
        this._handleKeyboard = this._handleKeyboard.bind(this);
    }

    /**
     * Initialize the application
     */
    async init() {
        console.log('[AccentFlow] Initializing...');

        // Cache DOM elements
        this._cacheDom();

        // Check browser support
        const support = SpeechEngine.checkSupport();
        if (!support.recognition || !support.synthesis) {
            this._showBrowserWarning();
            return;
        }

        // Initialize speech engine
        this.speech = new SpeechEngine();
        this._bindSpeechCallbacks();

        // Initialize visualizer
        this.visualizer = new AudioVisualizer('visualizer');

        // Bind UI events
        this._bindEvents();

        // Load saved settings
        this._loadSettings();

        // Hide loading overlay
        this._hideLoading();

        console.log('[AccentFlow] Ready!');
        this._showToast('AccentFlow is ready. Click the mic button to start!', 'info');
    }

    /**
     * Cache DOM element references
     */
    _cacheDom() {
        this.els = {
            // Controls
            mainToggle: document.getElementById('mainToggle'),
            controlStatus: document.getElementById('controlStatus'),
            statusDot: document.getElementById('statusDot'),
            statusText: document.getElementById('statusText'),

            // Transcripts
            originalTranscript: document.getElementById('originalTranscript'),
            convertedTranscript: document.getElementById('convertedTranscript'),

            // Settings
            settingsPanel: document.getElementById('settingsPanel'),
            settingsToggle: document.getElementById('settingsToggle'),
            voiceSelect: document.getElementById('voiceSelect'),
            speedSlider: document.getElementById('speedSlider'),
            speedValue: document.getElementById('speedValue'),
            pitchSlider: document.getElementById('pitchSlider'),
            pitchValue: document.getElementById('pitchValue'),
            volumeSlider: document.getElementById('volumeSlider'),
            volumeValue: document.getElementById('volumeValue'),
            previewVoice: document.getElementById('previewVoice'),

            // Guide
            guideToggle: document.getElementById('guideToggle'),
            guideContent: document.getElementById('guideContent'),
            guideChevron: document.getElementById('guideChevron'),

            // Other
            toastContainer: document.getElementById('toastContainer'),
            loadingOverlay: document.getElementById('loadingOverlay'),
            browserWarning: document.getElementById('browserWarning'),
        };
    }

    /**
     * Bind speech engine callbacks
     */
    _bindSpeechCallbacks() {
        this.speech.onInterimTranscript = (text) => {
            this._updateTranscript('original', text, true);
        };

        this.speech.onFinalTranscript = (text) => {
            this._updateTranscript('original', text, false);
        };

        this.speech.onConvertedText = (text) => {
            this._updateTranscript('converted', text, false);
        };

        this.speech.onStatusChange = (status) => {
            this._updateStatus(status);

            if (this.visualizer) {
                this.visualizer.setState(status);
            }
        };

        this.speech.onError = (message) => {
            this._showToast(message, 'error');
        };

        this.speech.onVoicesLoaded = (voices) => {
            this._populateVoiceSelect(voices);
        };
    }

    /**
     * Bind all UI event listeners
     */
    _bindEvents() {
        // Main toggle button
        this.els.mainToggle.addEventListener('click', () => this._toggleRunning());

        // Settings toggle
        this.els.settingsToggle.addEventListener('click', () => this._toggleSettings());

        // Voice selection
        this.els.voiceSelect.addEventListener('change', (e) => {
            const voice = this.speech.getVoices()[e.target.selectedIndex];
            if (voice) {
                this.speech.setVoice(voice);
                this._saveSettings();
            }
        });

        // Speed slider
        this.els.speedSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.speech.setRate(val);
            this.els.speedValue.textContent = val.toFixed(1) + 'x';
            this._saveSettings();
        });

        // Pitch slider
        this.els.pitchSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.speech.setPitch(val);
            this.els.pitchValue.textContent = val.toFixed(1);
            this._saveSettings();
        });

        // Volume slider
        this.els.volumeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.speech.setVolume(val);
            this.els.volumeValue.textContent = Math.round(val * 100) + '%';
            this._saveSettings();
        });

        // Preview voice button
        this.els.previewVoice.addEventListener('click', () => {
            this.speech.preview();
            this._showToast('Playing voice preview...', 'info');
        });

        // Setup guide toggle
        this.els.guideToggle.addEventListener('click', () => this._toggleGuide());

        // Keyboard shortcuts
        document.addEventListener('keydown', this._handleKeyboard);
    }

    /**
     * Handle keyboard shortcuts
     */
    _handleKeyboard(event) {
        // Don't trigger when typing in input fields
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT' || event.target.tagName === 'TEXTAREA') {
            return;
        }

        switch (event.code) {
            case 'Space':
                event.preventDefault();
                this._toggleRunning();
                break;
            case 'Escape':
                if (this.isRunning) {
                    this._toggleRunning();
                }
                break;
        }
    }

    /**
     * Toggle the main running state (start/stop)
     */
    async _toggleRunning() {
        if (this.isRunning) {
            this._stop();
        } else {
            await this._start();
        }
    }

    /**
     * Start the accent conversion
     */
    async _start() {
        // Initialize visualizer audio if not done yet
        if (!this.visualizer.audioContext) {
            const micOk = await this.visualizer.init();
            if (!micOk) {
                this._showToast('Could not access microphone. Please allow permission and try again.', 'error');
                return;
            }
        }

        // Start speech engine
        const started = this.speech.start();
        if (!started) return;

        // Start visualizer
        this.visualizer.start();

        // Update UI state
        this.isRunning = true;
        this.els.mainToggle.classList.add('active');
        this.els.controlStatus.textContent = 'Listening...';
        this.els.controlStatus.classList.add('active');

        this._showToast('AccentFlow is active! Start speaking.', 'success');
    }

    /**
     * Stop the accent conversion
     */
    _stop() {
        this.speech.stop();
        this.visualizer.stop();

        this.isRunning = false;
        this.els.mainToggle.classList.remove('active');
        this.els.controlStatus.textContent = 'Press to Start';
        this.els.controlStatus.classList.remove('active', 'speaking');

        this._updateStatus('idle');
        this._showToast('AccentFlow stopped.', 'info');
    }

    /**
     * Update the status indicator
     */
    _updateStatus(status) {
        const dot = this.els.statusDot;
        const text = this.els.statusText;
        const controlStatus = this.els.controlStatus;

        // Reset classes
        dot.className = 'status-dot';
        controlStatus.classList.remove('active', 'speaking');

        switch (status) {
            case 'listening':
                dot.classList.add('active');
                text.textContent = 'Listening';
                controlStatus.textContent = 'Listening...';
                controlStatus.classList.add('active');
                break;
            case 'speaking':
                dot.classList.add('speaking');
                text.textContent = 'Speaking';
                controlStatus.textContent = 'Converting...';
                controlStatus.classList.add('speaking');
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Error';
                controlStatus.textContent = 'Error';
                break;
            case 'idle':
            default:
                text.textContent = 'Ready';
                controlStatus.textContent = this.isRunning ? 'Listening...' : 'Press to Start';
                break;
        }
    }

    /**
     * Update transcript display
     */
    _updateTranscript(type, text, isInterim) {
        const container = type === 'original' ? this.els.originalTranscript : this.els.convertedTranscript;

        // Remove empty state if present
        const emptyState = container.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }

        if (isInterim) {
            // Update or create interim element
            let interimEl = container.querySelector('.transcript-line.interim');
            if (!interimEl) {
                interimEl = document.createElement('div');
                interimEl.className = 'transcript-line interim';
                container.appendChild(interimEl);
            }
            interimEl.textContent = text;
        } else {
            // Remove interim element
            const interimEl = container.querySelector('.transcript-line.interim');
            if (interimEl) {
                interimEl.remove();
            }

            // Add final transcript line
            const lineEl = document.createElement('div');
            lineEl.className = 'transcript-line final';
            lineEl.textContent = text;
            container.appendChild(lineEl);
        }

        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    /**
     * Populate the voice selection dropdown
     */
    _populateVoiceSelect(voices) {
        const select = this.els.voiceSelect;
        select.innerHTML = '';

        if (voices.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = 'No US English voices available';
            opt.disabled = true;
            select.appendChild(opt);
            return;
        }

        voices.forEach((voice, index) => {
            const opt = document.createElement('option');
            const type = voice.localService ? 'Local' : 'Cloud';
            opt.textContent = `${voice.name} (${type})`;
            opt.value = index;
            select.appendChild(opt);
        });

        // Restore saved voice preference
        const savedVoiceName = localStorage.getItem('accentflow_voice');
        if (savedVoiceName) {
            const savedIndex = voices.findIndex(v => v.name === savedVoiceName);
            if (savedIndex >= 0) {
                select.value = savedIndex;
                this.speech.setVoice(voices[savedIndex]);
            }
        }
    }

    /**
     * Toggle settings panel visibility
     */
    _toggleSettings() {
        this.settingsVisible = !this.settingsVisible;

        if (this.settingsVisible) {
            this.els.settingsPanel.classList.remove('collapsed');
        } else {
            this.els.settingsPanel.classList.add('collapsed');
        }
    }

    /**
     * Toggle setup guide visibility
     */
    _toggleGuide() {
        const content = this.els.guideContent;
        const chevron = this.els.guideChevron;

        content.classList.toggle('open');
        chevron.classList.toggle('open');
    }

    /**
     * Save settings to localStorage
     */
    _saveSettings() {
        try {
            const settings = {
                voice: this.speech.selectedVoice ? this.speech.selectedVoice.name : null,
                rate: this.speech.rate,
                pitch: this.speech.pitch,
                volume: this.speech.volume,
            };
            localStorage.setItem('accentflow_settings', JSON.stringify(settings));
        } catch (e) {
            console.warn('[AccentFlow] Could not save settings:', e);
        }
    }

    /**
     * Load settings from localStorage
     */
    _loadSettings() {
        try {
            const saved = localStorage.getItem('accentflow_settings');
            if (!saved) return;

            const settings = JSON.parse(saved);

            if (settings.rate !== undefined) {
                this.speech.setRate(settings.rate);
                this.els.speedSlider.value = settings.rate;
                this.els.speedValue.textContent = settings.rate.toFixed(1) + 'x';
            }

            if (settings.pitch !== undefined) {
                this.speech.setPitch(settings.pitch);
                this.els.pitchSlider.value = settings.pitch;
                this.els.pitchValue.textContent = settings.pitch.toFixed(1);
            }

            if (settings.volume !== undefined) {
                this.speech.setVolume(settings.volume);
                this.els.volumeSlider.value = settings.volume;
                this.els.volumeValue.textContent = Math.round(settings.volume * 100) + '%';
            }

            // Voice is restored when voices are loaded (async)
            if (settings.voice) {
                localStorage.setItem('accentflow_voice', settings.voice);
            }
        } catch (e) {
            console.warn('[AccentFlow] Could not load settings:', e);
        }
    }

    /**
     * Show a toast notification
     */
    _showToast(message, type = 'info') {
        const container = this.els.toastContainer;
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️',
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${message}</span>
        `;

        container.appendChild(toast);

        // Auto-remove after 4 seconds
        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    /**
     * Show browser compatibility warning
     */
    _showBrowserWarning() {
        const warning = this.els.browserWarning;
        if (warning) {
            warning.classList.add('visible');
        }
        this._hideLoading();
    }

    /**
     * Hide the loading overlay
     */
    _hideLoading() {
        const overlay = this.els.loadingOverlay;
        if (overlay) {
            overlay.classList.add('hidden');
            setTimeout(() => overlay.remove(), 500);
        }
    }
}

// ==================
// Initialize on page load
// ==================
document.addEventListener('DOMContentLoaded', () => {
    const app = new AccentFlowApp();
    app.init();
});
