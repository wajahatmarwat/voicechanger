# AccentFlow — Real-Time Voice Accent Converter

> Transform your accent into native American English in real-time. Built for call center professionals.

---

## 🎯 Two Ways to Use AccentFlow

### Option 1: Chrome Extension ⭐ RECOMMENDED
> **No VB-Cable needed!** Works directly inside ViciDial.

### Option 2: Web App + VB-Cable
> Standalone web app. Needs VB-Cable for audio routing.

---

## ⭐ Option 1: Chrome Extension (No VB-Cable!)

The Chrome Extension intercepts ViciDial's microphone and replaces your voice with an American accent — **no extra software needed**.

### How to Install

1. Open **Google Chrome** on your Windows PC
2. Go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **"Load unpacked"**
5. Select the `extension` folder from this project
6. The AccentFlow icon appears in your toolbar! 🎉

### How to Use

1. **Click the AccentFlow icon** in Chrome toolbar
2. **Click the Start button** in the popup
3. **Allow microphone access** when prompted
4. **Now open ViciDial** in the SAME Chrome tab (or refresh the ViciDial page)
5. When ViciDial asks for mic access → AccentFlow intercepts it
6. **Start speaking** — your words are:
   - Transcribed to text (Speech-to-Text)
   - Converted to American accent audio (via Google TTS)
   - Fed directly to ViciDial as your "microphone"
7. **The customer hears American English!** 🇺🇸

### Important Notes
- Start AccentFlow **before** opening/refreshing ViciDial
- Use **Google Chrome** (speech recognition requires it)
- Internet connection required
- Audio goes directly to ViciDial — no sound plays through your speakers

---

## 📱 Option 2: Web App + VB-Cable

If you prefer the standalone web app with more controls:

### Step 1: Install VB-Audio Virtual Cable (Free)

1. Go to [https://vb-audio.com/Cable/](https://vb-audio.com/Cable/)
2. Download **VBCable Driver**
3. **Right-click** `VBCABLE_Setup_x64.exe` → **Run as Administrator**
4. **Restart your computer**

### Step 2: Configure Audio Routing

1. Open **Windows Settings** → **System** → **Sound** → **Volume Mixer**
2. Set **Google Chrome** output to: `CABLE Input (VB-Audio Virtual Cable)`

### Step 3: Open AccentFlow Web App

1. Open `index.html` in **Google Chrome**
2. Allow microphone access

### Step 4: Open ViciDial

1. Open ViciDial in **Microsoft Edge** (separate browser!)
2. Set ViciDial's microphone to: `CABLE Output (VB-Audio Virtual Cable)`

### Step 5: Start Converting

1. Click the mic button in AccentFlow
2. Speak naturally — your words are re-spoken in American accent
3. ViciDial picks up the converted audio through VB-Cable

---

## 🎛️ Controls

| Control | Action |
|---------|--------|
| **Mic Button / Start** | Start/Stop the accent converter |
| **Space** | Toggle start/stop (web app only) |
| **Escape** | Stop (web app only) |
| **Speed** | Adjust speech rate (0.5x — 2.0x) |
| **Pitch** | Adjust voice pitch (web app only) |
| **Volume** | Adjust output volume |

---

## 🔧 Troubleshooting

### Extension: "Could not connect to page"
- Refresh the ViciDial page and try again
- Make sure you're on a regular webpage (not chrome:// pages)

### Extension: No audio going to ViciDial
- Make sure you clicked Start **before** ViciDial requested your mic
- Refresh ViciDial after activating AccentFlow
- Check Chrome console for errors (F12 → Console)

### Speech recognition not working
- Use **Google Chrome** (required)
- Allow microphone permission
- Check internet connection (speech recognition uses Google's cloud)
- Reduce background noise / use a headset

### Audio sounds robotic
- The extension uses Google Translate's TTS engine — it's decent but not human
- The web app lets you choose from multiple voices
- For ultra-realistic voice: consider upgrading to ElevenLabs or OpenAI TTS

---

## 📋 Requirements

| Requirement | Extension | Web App |
|------------|-----------|---------|
| Browser | Chrome | Chrome + Edge |
| VB-Cable | ❌ Not needed | ✅ Required |
| Internet | ✅ Required | ✅ Required |
| Microphone | ✅ Required | ✅ Required |

---

## 🏗️ Project Structure

```
VOICECHANGER/
├── extension/              ← Chrome Extension (Option 1)
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── background.js
│   ├── content.js
│   ├── inject.js
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
├── index.html              ← Web App (Option 2)
├── css/
│   └── styles.css
├── js/
│   ├── app.js
│   ├── speech.js
│   └── visualizer.js
│
└── README.md               ← This file
```

---

## 💡 How It Works

### Chrome Extension Flow
```
🎤 Your Mic → Extension intercepts getUserMedia
    → Speech Recognition (STT)
    → Google TTS API (American accent audio)
    → Feeds audio directly to ViciDial as "microphone"
    → 🔊 Customer hears American English!
```

### Web App Flow
```
🎤 Your Mic → Chrome Speech Recognition
    → Text-to-Speech (American accent)
    → Audio output → VB-Cable
    → ViciDial reads VB-Cable as microphone
    → 🔊 Customer hears American English!
```

---

Built with ❤️ for call center professionals worldwide.
