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
async function fetchTTSAudio(text) {
    // Google Translate TTS has a ~200 char limit per request
    const chunks = splitText(text, 180);
    const audioChunks = [];

    for (const chunk of chunks) {
        const encoded = encodeURIComponent(chunk);
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en-US&client=tw-ob&q=${encoded}&ttsspeed=1`;

        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Referer': 'https://translate.google.com/',
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const buffer = await response.arrayBuffer();
            audioChunks.push(buffer);
        } catch (err) {
            console.error('[AccentFlow BG] TTS fetch error:', err);
            // Try fallback URL
            try {
                const fallbackUrl = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=en-US&client=gtx&q=${encoded}`;
                const resp2 = await fetch(fallbackUrl);
                if (resp2.ok) {
                    audioChunks.push(await resp2.arrayBuffer());
                }
            } catch (e2) {
                console.error('[AccentFlow BG] Fallback TTS also failed:', e2);
                notifyPopup('error', 'TTS audio fetch failed. Check internet connection.');
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
                notifyPopup('error', 'No active tab found');
                return;
            }
            activeTabId = tab.id;
            isActive = true;

            // Tell content script to activate
            try {
                await chrome.tabs.sendMessage(tab.id, { action: 'activate' });
                notifyPopup('activated', null);
            } catch (err) {
                notifyPopup('error', 'Could not connect to page. Try refreshing the tab.');
                isActive = false;
                activeTabId = null;
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

            fetchTTSAudio(message.text).then((audioBuffer) => {
                if (audioBuffer && sender.tab) {
                    sendAudioToTab(sender.tab.id, audioBuffer);
                    notifyPopup('converted', message.text);
                }
            });
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
