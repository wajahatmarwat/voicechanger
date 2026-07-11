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
    const chunks = splitText(text, 180);
    const audioChunks = [];

    for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const buf = await fetchTTSChunk(chunk.trim(), gender);
        if (buf) audioChunks.push(buf);
    }

    if (audioChunks.length === 0) return null;
    if (audioChunks.length === 1) return audioChunks[0];

    const totalLength = audioChunks.reduce((sum, b) => sum + b.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of audioChunks) {
        combined.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
    }
    return combined.buffer;
}

/**
 * Try multiple TTS sources in sequence until one succeeds
 */
async function fetchTTSChunk(text, gender) {
    const encoded = encodeURIComponent(text);
    // TikTok voice: en_us_001 = male, en_us_002 = female
    const tiktokVoice = gender === 'female' ? 'en_us_002' : 'en_us_001';
    // Reverso voice: Bradley22k = male, Heather22k = female
    const reversoVoice = gender === 'female' ? 'Heather22k' : 'Bradley22k';

    // ── Source 1: TikTok TTS proxy (free, no API key, returns base64 MP3) ──
    try {
        const resp = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: tiktokVoice }),
        });
        if (resp.ok) {
            const json = await resp.json();
            if (json.success && json.data) {
                const binary = atob(json.data);
                const bytes  = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                if (bytes.byteLength > 100) {
                    console.log('[AccentFlow BG] TikTok TTS OK (' + bytes.byteLength + ' bytes)');
                    return bytes.buffer;
                }
            }
        }
    } catch (e) {
        console.warn('[AccentFlow BG] TikTok TTS failed:', e.message);
    }

    // ── Source 2: Reverso Voice (no API key, American voices) ──
    try {
        const b64text = btoa(unescape(encodeURIComponent(text)));
        const resp = await fetch(
            `https://voice.reverso.net/RestPronunciation.svc/v1/output=json/GetVoiceStream/voiceName=${reversoVoice}?inputText=${b64text}`,
            { headers: { 'Accept': 'audio/mpeg' } }
        );
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 100) {
                console.log('[AccentFlow BG] Reverso TTS OK (' + buf.byteLength + ' bytes)');
                return buf;
            }
        }
    } catch (e) {
        console.warn('[AccentFlow BG] Reverso TTS failed:', e.message);
    }

    // ── Source 3: Google Translate (gtx client — less restricted) ──
    try {
        const resp = await fetch(
            `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=en-US&client=gtx&q=${encoded}`,
            { headers: { 'Referer': 'https://translate.google.com/' } }
        );
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > 100) {
                console.log('[AccentFlow BG] Google TTS OK (' + buf.byteLength + ' bytes)');
                return buf;
            }
        }
    } catch (e) {
        console.warn('[AccentFlow BG] Google TTS failed:', e.message);
    }

    console.error('[AccentFlow BG] All TTS sources failed for chunk:', text);
    notifyPopup('error', 'TTS unavailable — check internet connection.');
    return null;
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
