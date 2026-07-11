/**
 * AccentFlow Chrome Extension — Background Service Worker
 * Handles TTS audio fetching and state management
 */

// ── State ──────────────────────────────────────────────────
let isActive = false;
let popupPort = null;
let activeTabId = null;

// ── TTS Audio Fetching ─────────────────────────────────────

/**
 * Fetch TTS audio from Google Translate (free, no API key)
 * Returns American English audio as ArrayBuffer
 */
async function fetchTTSAudio(text, gender = 'male') {
    const chunks = splitText(text, 200);
    const audioChunks = [];

    // StreamElements TTS — free, reliable, Amazon Polly voices, no API key needed
    // Brian = American male, Joanna = American female
    const voice = gender === 'female' ? 'Joanna' : 'Brian';

    for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const encoded = encodeURIComponent(chunk.trim());
        const url = `https://api.streamelements.com/kappa/v2/speech?voice=${voice}&text=${encoded}`;

        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`StreamElements TTS HTTP ${response.status}`);
            }

            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > 100) {
                audioChunks.push(buffer);
                console.log(`[AccentFlow BG] TTS fetched OK (${buffer.byteLength} bytes)`);
            }
        } catch (err) {
            console.error('[AccentFlow BG] StreamElements TTS failed:', err.message);
            // Fallback: Google Translate TTS
            try {
                const fallbackUrl = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=en-US&client=gtx&q=${encoded}`;
                const resp2 = await fetch(fallbackUrl, { headers: { 'Referer': 'https://translate.google.com/' } });
                if (resp2.ok) {
                    const buf2 = await resp2.arrayBuffer();
                    if (buf2.byteLength > 100) audioChunks.push(buf2);
                }
            } catch (e2) {
                console.error('[AccentFlow BG] All TTS sources failed:', e2.message);
                notifyPopup('error', 'TTS fetch failed — check internet.');
            }
        }
    }

    if (audioChunks.length === 0) return null;

    // If single chunk, return directly
    if (audioChunks.length === 1) return audioChunks[0];

    // Concatenate multiple chunks
    const totalLength = audioChunks.reduce((sum, buf) => sum + buf.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of audioChunks) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
    }
    return combined.buffer;
}

/**
 * Split text into chunks at sentence boundaries
 */
function splitText(text, maxLength) {
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Find last sentence boundary within maxLength
        let splitIdx = -1;
        const punctuation = ['. ', '! ', '? ', ', '];
        for (const p of punctuation) {
            const idx = remaining.lastIndexOf(p, maxLength);
            if (idx > splitIdx) splitIdx = idx + p.length;
        }

        // If no sentence boundary, split at last space
        if (splitIdx <= 0) {
            splitIdx = remaining.lastIndexOf(' ', maxLength);
        }

        // If no space either, force split
        if (splitIdx <= 0) {
            splitIdx = maxLength;
        }

        chunks.push(remaining.substring(0, splitIdx).trim());
        remaining = remaining.substring(splitIdx).trim();
    }

    return chunks;
}

/**
 * Send audio data to the content script in the active tab
 */
async function sendAudioToTab(tabId, audioBuffer) {
    const uint8Array = new Uint8Array(audioBuffer);
    const audioData = Array.from(uint8Array);

    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'playAudio',
            audioData: audioData,
        });
    } catch (err) {
        console.error('[AccentFlow BG] Failed to send audio to tab:', err);
    }
}

// ── Popup Communication ────────────────────────────────────

function notifyPopup(type, data) {
    if (popupPort) {
        try {
            popupPort.postMessage({ type, data });
        } catch (e) {
            popupPort = null;
        }
    }
}

// Handle popup connections
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'accentflow-popup') {
        popupPort = port;

        // Send current state to popup
        port.postMessage({ type: 'state', data: { isActive, activeTabId } });

        port.onDisconnect.addListener(() => {
            popupPort = null;
        });

        port.onMessage.addListener((msg) => {
            handlePopupMessage(msg);
        });
    }
});

/**
 * Handle messages from popup
 */
async function handlePopupMessage(msg) {
    switch (msg.action) {
        case 'activate': {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) {
                notifyPopup('error', 'No active tab found. Open a webpage first.');
                return;
            }

            // Block chrome:// internal pages
            if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
                notifyPopup('error', 'Please open your ViciDial / WhatsApp / Meet page first, then click Start.');
                return;
            }

            activeTabId = tab.id;
            isActive = true;

            try {
                // inject.js and content.js are already declared in manifest — just activate
                await chrome.tabs.sendMessage(tab.id, { action: 'activate' });
                notifyPopup('activated', null);
                console.log('[AccentFlow BG] Activated on tab:', tab.id, tab.url);
            } catch (err) {
                // Scripts might not be ready yet — try injecting programmatically as fallback
                console.warn('[AccentFlow BG] sendMessage failed, injecting scripts:', err.message);
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['inject.js'],
                        world: 'MAIN',
                    });
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content.js'],
                        world: 'ISOLATED',
                    });
                    await new Promise(r => setTimeout(r, 200));
                    await chrome.tabs.sendMessage(tab.id, { action: 'activate' });
                    notifyPopup('activated', null);
                } catch (err2) {
                    notifyPopup('error', 'Could not connect. Try refreshing the page then click Start again.');
                    isActive = false;
                    activeTabId = null;
                }
            }
            break;
        }
        case 'deactivate': {
            if (activeTabId) {
                try {
                    await chrome.tabs.sendMessage(activeTabId, { action: 'deactivate' });
                } catch (e) { /* tab might be closed */ }
            }
            isActive = false;
            activeTabId = null;
            notifyPopup('deactivated', null);
            break;
        }

        case 'updateSettings': {
            if (activeTabId) {
                try {
                    await chrome.tabs.sendMessage(activeTabId, {
                        action: 'updateSettings',
                        settings: msg.settings,
                    });
                } catch (e) { /* ignore */ }
            }
            // Save settings
            chrome.storage.local.set({ accentflow_settings: msg.settings });
            break;
        }
    }
}

// ── Content Script Messages ────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    switch (message.action) {
        case 'convertText':
            // Received recognized text → fetch TTS and send back
            notifyPopup('transcript', message.text);
            {
                // Get gender from saved settings
                const gender = message.gender || 'male';
                fetchTTSAudio(message.text, gender).then((audioBuffer) => {
                    if (audioBuffer && sender.tab) {
                        sendAudioToTab(sender.tab.id, audioBuffer);
                        notifyPopup('converted', message.text);
                    } else {
                        console.warn('[AccentFlow BG] No audio buffer returned from TTS');
                    }
                });
            }
            break;

        case 'interim':
            notifyPopup('interim', message.text);
            break;

        case 'speaking':
            notifyPopup('speaking', null);
            break;

        case 'speechDone':
            notifyPopup('speechDone', null);
            break;

        case 'error':
            notifyPopup('error', message.error);
            break;
    }

    return true; // Keep channel open for async
});

// ── Tab Close Cleanup ──────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTabId) {
        isActive = false;
        activeTabId = null;
        notifyPopup('deactivated', null);
    }
});

console.log('[AccentFlow BG] Service worker loaded');
