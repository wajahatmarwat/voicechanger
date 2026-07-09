/**
 * AccentFlow — Speech Engine Module
 * Handles Speech Recognition (STT) and Speech Synthesis (TTS)
 * Converts user's speech to American-accented output in real-time
 */

class SpeechEngine {
    constructor() {
        // Core APIs
        this.recognition = null;
        this.synthesis = window.speechSynthesis;

        // Voice settings
        this.voices = [];
        this.selectedVoice = null;
        this.rate = 1.0;
        this.pitch = 1.0;
        this.volume = 1.0;

        // State
        this.isListening = false;
        this.isSpeaking = false;
        this.isPaused = false;
        this.speechQueue = [];
        this.shouldAutoRestart = false;

        // Callbacks
        this.onInterimTranscript = null;   // (text) => {}
        this.onFinalTranscript = null;     // (text) => {}
        this.onConvertedText = null;       // (text) => {}
        this.onStatusChange = null;        // (status) => {}
        this.onError = null;              // (message) => {}
        this.onVoicesLoaded = null;       // (voices) => {}

        // Initialize
        this._initRecognition();
        this._loadVoices();
    }

    /**
     * Initialize the SpeechRecognition API
     */
    _initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('[SpeechEngine] SpeechRecognition API not supported');
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        this.recognition.onresult = (event) => this._handleResult(event);
        this.recognition.onend = () => this._handleRecognitionEnd();
        this.recognition.onerror = (event) => this._handleRecognitionError(event);
        this.recognition.onstart = () => {
            console.log('[SpeechEngine] Recognition started');
        };
    }

    /**
     * Load and filter voices for en-US locale
     */
    _loadVoices() {
        const loadAndFilter = () => {
            const allVoices = this.synthesis.getVoices();
            this.voices = allVoices.filter(v =>
                v.lang === 'en-US' || v.lang.startsWith('en-US')
            );

            // Sort: prioritize Google and Microsoft voices, then local
            this.voices.sort((a, b) => {
                const scoreA = this._voicePriority(a);
                const scoreB = this._voicePriority(b);
                return scoreB - scoreA;
            });

            // Auto-select the best voice if none selected
            if (!this.selectedVoice && this.voices.length > 0) {
                this.selectedVoice = this.voices[0];
            }

            console.log(`[SpeechEngine] Loaded ${this.voices.length} en-US voices`);

            if (this.onVoicesLoaded) {
                this.onVoicesLoaded(this.voices);
            }
        };

        // Voices may load asynchronously
        loadAndFilter();
        if (this.synthesis.onvoiceschanged !== undefined) {
            this.synthesis.onvoiceschanged = loadAndFilter;
        }

        // Fallback: retry after a delay (some browsers are slow)
        setTimeout(loadAndFilter, 500);
        setTimeout(loadAndFilter, 1500);
    }

    /**
     * Assign a priority score to a voice for sorting
     * Higher = better quality for our use case
     */
    _voicePriority(voice) {
        const name = voice.name.toLowerCase();
        let score = 0;

        // Prefer Google voices (high quality)
        if (name.includes('google')) score += 10;
        // Microsoft voices are also good
        if (name.includes('microsoft')) score += 8;
        // Prefer natural/premium voices
        if (name.includes('natural')) score += 5;
        if (name.includes('premium')) score += 5;
        // Network voices tend to sound better
        if (!voice.localService) score += 3;
        // Slightly prefer female voices (often clearer on phone calls)
        if (name.includes('female') || name.includes('zira') || name.includes('jenny')) score += 1;

        return score;
    }

    /**
     * Handle speech recognition results
     */
    _handleResult(event) {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const transcript = result[0].transcript;

            if (result.isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }

        // Send interim results for live display
        if (interimTranscript && this.onInterimTranscript) {
            this.onInterimTranscript(interimTranscript);
        }

        // Process final results — send to TTS
        if (finalTranscript) {
            const cleanedText = this._cleanText(finalTranscript);

            if (this.onFinalTranscript) {
                this.onFinalTranscript(cleanedText);
            }

            if (cleanedText.trim().length > 0) {
                this._speak(cleanedText);
            }
        }
    }

    /**
     * Clean up transcribed text
     */
    _cleanText(text) {
        // Trim whitespace
        let cleaned = text.trim();

        // Capitalize first letter
        if (cleaned.length > 0) {
            cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
        }

        // Add period if no sentence-ending punctuation
        if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
            // Don't add period for very short fragments
            if (cleaned.split(' ').length > 2) {
                cleaned += '.';
            }
        }

        return cleaned;
    }

    /**
     * Speak text using SpeechSynthesis with American accent
     */
    _speak(text) {
        const utterance = new SpeechSynthesisUtterance(text);

        if (this.selectedVoice) {
            utterance.voice = this.selectedVoice;
        }

        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        utterance.volume = this.volume;
        utterance.lang = 'en-US';

        utterance.onstart = () => {
            this.isSpeaking = true;
            if (this.onStatusChange) this.onStatusChange('speaking');
        };

        utterance.onend = () => {
            this.isSpeaking = false;
            this._processQueue();

            if (!this.isSpeaking && this.isListening) {
                if (this.onStatusChange) this.onStatusChange('listening');
            }
        };

        utterance.onerror = (e) => {
            console.error('[SpeechEngine] TTS error:', e.error);
            this.isSpeaking = false;
            this._processQueue();
        };

        // Notify about converted text
        if (this.onConvertedText) {
            this.onConvertedText(text);
        }

        // Queue management: if already speaking, queue it
        if (this.isSpeaking) {
            this.speechQueue.push(utterance);
        } else {
            // Chrome bug workaround: cancel before speaking
            this.synthesis.cancel();
            this.synthesis.speak(utterance);
        }
    }

    /**
     * Process the next item in the speech queue
     */
    _processQueue() {
        if (this.speechQueue.length > 0) {
            const next = this.speechQueue.shift();
            this.synthesis.cancel();
            this.synthesis.speak(next);
        }
    }

    /**
     * Handle recognition ending (auto-restart if needed)
     */
    _handleRecognitionEnd() {
        console.log('[SpeechEngine] Recognition ended');

        if (this.isListening && this.shouldAutoRestart) {
            // Auto-restart with small delay to avoid rapid restart loops
            setTimeout(() => {
                if (this.isListening) {
                    try {
                        this.recognition.start();
                        console.log('[SpeechEngine] Auto-restarted recognition');
                    } catch (e) {
                        console.warn('[SpeechEngine] Auto-restart failed:', e.message);
                    }
                }
            }, 100);
        }
    }

    /**
     * Handle recognition errors
     */
    _handleRecognitionError(event) {
        console.error('[SpeechEngine] Recognition error:', event.error);

        switch (event.error) {
            case 'not-allowed':
            case 'service-not-allowed':
                if (this.onError) {
                    this.onError('Microphone access denied. Please allow microphone permission in your browser.');
                }
                this.isListening = false;
                if (this.onStatusChange) this.onStatusChange('error');
                break;

            case 'no-speech':
                // This is normal — just means no speech detected, recognition will auto-restart
                console.log('[SpeechEngine] No speech detected, continuing...');
                break;

            case 'audio-capture':
                if (this.onError) {
                    this.onError('No microphone found. Please connect a microphone and try again.');
                }
                this.isListening = false;
                if (this.onStatusChange) this.onStatusChange('error');
                break;

            case 'network':
                if (this.onError) {
                    this.onError('Network error. Speech recognition requires an internet connection.');
                }
                break;

            case 'aborted':
                // Normal when stop() is called
                break;

            default:
                if (this.onError) {
                    this.onError(`Speech recognition error: ${event.error}`);
                }
                break;
        }
    }

    // ==================
    // PUBLIC API
    // ==================

    /**
     * Check if the browser supports required APIs
     * @returns {{ recognition: boolean, synthesis: boolean }} Support status
     */
    static checkSupport() {
        const recognition = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
        const synthesis = !!window.speechSynthesis;
        return { recognition, synthesis };
    }

    /**
     * Start listening and converting
     */
    start() {
        if (!this.recognition) {
            if (this.onError) {
                this.onError('Speech Recognition is not supported in this browser. Please use Google Chrome.');
            }
            return false;
        }

        try {
            this.isListening = true;
            this.shouldAutoRestart = true;
            this.recognition.start();
            if (this.onStatusChange) this.onStatusChange('listening');
            return true;
        } catch (e) {
            console.error('[SpeechEngine] Failed to start:', e);
            if (this.onError) {
                this.onError('Failed to start speech recognition: ' + e.message);
            }
            this.isListening = false;
            return false;
        }
    }

    /**
     * Stop listening and clear queued speech
     */
    stop() {
        this.isListening = false;
        this.shouldAutoRestart = false;
        this.speechQueue = [];

        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch (e) {
                // Ignore — may not be started
            }
        }

        this.synthesis.cancel();
        this.isSpeaking = false;

        if (this.onStatusChange) this.onStatusChange('idle');
    }

    /**
     * Get available US English voices
     * @returns {SpeechSynthesisVoice[]}
     */
    getVoices() {
        return this.voices;
    }

    /**
     * Set the active voice
     * @param {SpeechSynthesisVoice} voice
     */
    setVoice(voice) {
        this.selectedVoice = voice;
    }

    /**
     * Set speech rate
     * @param {number} rate — 0.5 to 2.0
     */
    setRate(rate) {
        this.rate = Math.max(0.5, Math.min(2.0, rate));
    }

    /**
     * Set speech pitch
     * @param {number} pitch — 0.5 to 2.0
     */
    setPitch(pitch) {
        this.pitch = Math.max(0.5, Math.min(2.0, pitch));
    }

    /**
     * Set speech volume
     * @param {number} volume — 0 to 1
     */
    setVolume(volume) {
        this.volume = Math.max(0, Math.min(1, volume));
    }

    /**
     * Preview the current voice with a sample sentence
     * @param {string} [text] — Custom preview text
     */
    preview(text) {
        const previewText = text || "Hello, thank you for calling today. How can I assist you?";
        this.synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(previewText);
        if (this.selectedVoice) {
            utterance.voice = this.selectedVoice;
        }
        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        utterance.volume = this.volume;
        utterance.lang = 'en-US';

        this.synthesis.speak(utterance);
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpeechEngine;
}
