/**
 * AccentFlow — Audio Visualizer Module
 * Real-time microphone audio visualization using Web Audio API & Canvas
 */

class AudioVisualizer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.bufferLength = 0;
        this.animationId = null;
        this.isActive = false;
        this.stream = null;
        this.state = 'idle'; // idle | listening | speaking | converting

        // Visual config
        this.barGap = 2;
        this.smoothing = 0.8;

        // Colors per state
        this.stateColors = {
            idle:       { r: 100, g: 116, b: 139, name: 'slate' },
            listening:  { r: 59,  g: 130, b: 246, name: 'blue' },
            speaking:   { r: 6,   g: 182, b: 212, name: 'cyan' },
            converting: { r: 16,  g: 185, b: 129, name: 'green' },
        };

        this._resizeCanvas();
        this._boundResize = () => this._resizeCanvas();
        window.addEventListener('resize', this._boundResize);

        // Draw initial idle state
        this._drawIdle();
    }

    /**
     * Initialize the Web Audio API and connect to the microphone
     * @returns {Promise<boolean>} Whether initialization succeeded
     */
    async init() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = this.smoothing;

            this.bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(this.bufferLength);

            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            const source = this.audioContext.createMediaStreamSource(this.stream);
            source.connect(this.analyser);
            // NOTE: We do NOT connect analyser to destination — we don't want mic playback

            return true;
        } catch (err) {
            console.error('[Visualizer] Microphone access error:', err);
            return false;
        }
    }

    /**
     * Resize the canvas to match its container
     */
    _resizeCanvas() {
        if (!this.canvas || !this.canvas.parentElement) return;

        const rect = this.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = rect.width * dpr;
        this.canvas.height = 120 * dpr;
        this.canvas.style.width = rect.width + 'px';
        this.canvas.style.height = '120px';

        this.ctx.scale(dpr, dpr);

        // Redraw after resize
        if (!this.isActive) {
            this._drawIdle();
        }
    }

    /**
     * Set the visual state (changes color scheme)
     * @param {'idle'|'listening'|'speaking'|'converting'} state
     */
    setState(state) {
        if (this.stateColors[state]) {
            this.state = state;
        }
    }

    /**
     * Start the visualization loop
     */
    start() {
        if (this.isActive) return;
        this.isActive = true;

        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this._draw();
    }

    /**
     * Stop the visualization loop
     */
    stop() {
        this.isActive = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this._drawIdle();
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.stop();
        window.removeEventListener('resize', this._boundResize);

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }

    /**
     * Main draw loop — renders frequency bars mirrored around center
     */
    _draw() {
        if (!this.isActive) return;

        this.animationId = requestAnimationFrame(() => this._draw());

        this.analyser.getByteFrequencyData(this.dataArray);

        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        const centerY = height / 2;

        this.ctx.clearRect(0, 0, width, height);

        const color = this.stateColors[this.state] || this.stateColors.idle;
        const barCount = this.bufferLength;
        const totalBarWidth = width / barCount;
        const barWidth = Math.max(totalBarWidth - this.barGap, 1);

        for (let i = 0; i < barCount; i++) {
            const value = this.dataArray[i] / 255;
            const barHeight = Math.max(value * centerY * 0.9, 1);
            const x = i * totalBarWidth;

            // Create gradient for each bar
            const gradient = this.ctx.createLinearGradient(x, centerY - barHeight, x, centerY + barHeight);
            const alpha = 0.3 + value * 0.7;
            gradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha * 0.4})`);
            gradient.addColorStop(0.3, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha * 0.8})`);
            gradient.addColorStop(0.5, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`);
            gradient.addColorStop(0.7, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha * 0.8})`);
            gradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha * 0.4})`);

            this.ctx.fillStyle = gradient;

            // Draw mirrored bars around center
            const roundRadius = Math.min(barWidth / 2, 2);
            this._roundRect(x, centerY - barHeight, barWidth, barHeight * 2, roundRadius);
        }

        // Draw center glow line
        this.ctx.beginPath();
        this.ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.15)`;
        this.ctx.lineWidth = 1;
        this.ctx.moveTo(0, centerY);
        this.ctx.lineTo(width, centerY);
        this.ctx.stroke();
    }

    /**
     * Draw a rounded rectangle
     */
    _roundRect(x, y, w, h, r) {
        if (w < 2 * r) r = w / 2;
        if (h < 2 * r) r = h / 2;

        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y);
        this.ctx.arcTo(x + w, y, x + w, y + h, r);
        this.ctx.arcTo(x + w, y + h, x, y + h, r);
        this.ctx.arcTo(x, y + h, x, y, r);
        this.ctx.arcTo(x, y, x + w, y, r);
        this.ctx.closePath();
        this.ctx.fill();
    }

    /**
     * Draw the idle state — flat line with subtle pulse
     */
    _drawIdle() {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        const centerY = height / 2;

        this.ctx.clearRect(0, 0, width, height);

        // Draw subtle center line
        const gradient = this.ctx.createLinearGradient(0, centerY, width, centerY);
        gradient.addColorStop(0, 'rgba(100, 116, 139, 0)');
        gradient.addColorStop(0.2, 'rgba(100, 116, 139, 0.15)');
        gradient.addColorStop(0.5, 'rgba(100, 116, 139, 0.25)');
        gradient.addColorStop(0.8, 'rgba(100, 116, 139, 0.15)');
        gradient.addColorStop(1, 'rgba(100, 116, 139, 0)');

        this.ctx.beginPath();
        this.ctx.strokeStyle = gradient;
        this.ctx.lineWidth = 1.5;
        this.ctx.moveTo(0, centerY);
        this.ctx.lineTo(width, centerY);
        this.ctx.stroke();

        // Draw subtle dots along the line
        const dotCount = 30;
        const spacing = width / dotCount;
        for (let i = 0; i < dotCount; i++) {
            const x = i * spacing + spacing / 2;
            const alpha = 0.08 + Math.sin(i * 0.3) * 0.04;
            this.ctx.beginPath();
            this.ctx.arc(x, centerY, 1.5, 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(100, 116, 139, ${alpha})`;
            this.ctx.fill();
        }
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioVisualizer;
}
