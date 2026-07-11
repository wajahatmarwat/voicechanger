/**
 * AccentFlow Chrome Extension — Content Script
 * Runs in the extension's isolated world
 * Relays messages between inject.js (page context) and background.js (service worker)
 */

// ── Relay: Page → Background ────────────────────────────
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    switch (event.data.type) {
        case 'ACCENTFLOW_FINAL_TEXT':
            // User spoke → send text to background for TTS conversion
            chrome.storage.local.get('accentflow_settings', (result) => {
                const gender = result?.accentflow_settings?.gender || 'male';
                chrome.runtime.sendMessage({
                    action: 'convertText',
                    text: event.data.text,
                    gender: gender,
                });
            });
            break;

        case 'ACCENTFLOW_INTERIM':
            // Interim transcript → forward to popup via background
            chrome.runtime.sendMessage({
                action: 'interim',
                text: event.data.text,
            });
            break;

        case 'ACCENTFLOW_SPEAKING':
            chrome.runtime.sendMessage({ action: 'speaking' });
            break;

        case 'ACCENTFLOW_SPEECH_DONE':
            chrome.runtime.sendMessage({ action: 'speechDone' });
            break;

        case 'ACCENTFLOW_ERROR':
            chrome.runtime.sendMessage({
                action: 'error',
                error: event.data.error,
            });
            break;
    }
});

// ── Relay: Background → Page ────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    switch (message.action) {
        case 'activate':
            window.postMessage({ type: 'ACCENTFLOW_ACTIVATE' }, '*');
            break;

        case 'deactivate':
            window.postMessage({ type: 'ACCENTFLOW_DEACTIVATE' }, '*');
            break;

        case 'playAudio':
            // Audio data from background → forward to page for playback
            window.postMessage(
                {
                    type: 'ACCENTFLOW_PLAY_AUDIO',
                    audioData: message.audioData,
                },
                '*'
            );
            break;

        case 'updateSettings':
            window.postMessage(
                {
                    type: 'ACCENTFLOW_UPDATE_SETTINGS',
                    settings: message.settings,
                },
                '*'
            );
            break;
    }
});

console.log('[AccentFlow] Content script loaded — message relay active');
