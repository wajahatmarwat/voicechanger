# AccentFlow — Real-Time Voice Accent Converter

> Transform your accent into native American English in real-time. Built for call center professionals.

---

## 🚀 Quick Start

1. Open `index.html` in **Google Chrome**
2. Allow microphone access when prompted
3. Click the **mic button** (or press `Space`)
4. Start speaking — your words will be transcribed and re-spoken in an American accent!

---

## 🖥️ Windows Setup for ViciDial

To route AccentFlow's American accent output into ViciDial as your "microphone", follow these steps:

### Step 1: Install VB-Audio Virtual Cable (Free)

1. Go to [https://vb-audio.com/Cable/](https://vb-audio.com/Cable/)
2. Download **VBCable Driver** (the free version is all you need)
3. Extract the ZIP file
4. **Right-click** `VBCABLE_Setup_x64.exe` → **Run as Administrator**
5. Follow the installer prompts
6. **Restart your computer**

After restart, you'll see two new audio devices in your system:
- `CABLE Input (VB-Audio Virtual Cable)` — this is the virtual speaker
- `CABLE Output (VB-Audio Virtual Cable)` — this is the virtual microphone

### Step 2: Configure Chrome Audio Output

1. Open **Windows Settings** → **System** → **Sound**
2. Scroll down to **Advanced sound options** → click **App volume and device preferences**
   - On Windows 11: Settings → System → Sound → Volume Mixer
3. Find **Google Chrome** in the list
4. Set its **Output** to: `CABLE Input (VB-Audio Virtual Cable)`

This routes all of Chrome's audio (including AccentFlow's TTS) through the virtual cable.

### Step 3: Open AccentFlow in Chrome

1. Open `index.html` in **Google Chrome**
2. When prompted, **allow microphone access**
3. Your physical microphone will be used for speech recognition

### Step 4: Open ViciDial in Edge (or another browser)

1. Open **Microsoft Edge** (or Firefox)
2. Navigate to your ViciDial login page
3. In ViciDial's audio/phone settings, set the **microphone** to: `CABLE Output (VB-Audio Virtual Cable)`
4. Keep the **speaker/output** set to your headphones/speakers

### Step 5: Test the Setup

1. In Chrome (AccentFlow), click the mic button to start
2. Speak into your physical microphone
3. You should see:
   - Your words appear in the "Your Speech" panel
   - The American accent version in the "American Output" panel
4. The TTS audio goes through VB-Cable → ViciDial picks it up as microphone input
5. The customer hears the American accent voice!

---

## 🎛️ Controls

| Control | Action |
|---------|--------|
| **Mic Button** | Start/Stop the accent converter |
| **Space** | Toggle start/stop (keyboard shortcut) |
| **Escape** | Stop the converter |
| **Voice** | Select from available US English voices |
| **Speed** | Adjust speech rate (0.5x — 2.0x) |
| **Pitch** | Adjust voice pitch (0.5 — 2.0) |
| **Volume** | Adjust output volume |
| **Preview** | Test the selected voice |

---

## 🔧 Troubleshooting

### "No US English voices available"
- Make sure you're using **Google Chrome**
- Try refreshing the page (voices load asynchronously)
- Check if your system has English (US) language pack installed

### Microphone not working
- Click the lock/microphone icon in Chrome's address bar
- Set Microphone to **Allow**
- Make sure your physical mic is connected and set as default in Windows Sound settings

### ViciDial can't hear the output
- Verify VB-Cable is installed (check Windows Sound settings for "CABLE" devices)
- Confirm Chrome's output is set to `CABLE Input` in the Volume Mixer
- Confirm ViciDial's microphone is set to `CABLE Output`

### Too much delay
- Increase the **Speed** slider to 1.2x or 1.3x
- Use shorter sentences when speaking
- Ensure you have a stable internet connection (Chrome's speech recognition uses the cloud)

### Echo or feedback loop
- Make sure AccentFlow (Chrome) and ViciDial (Edge) are in **separate browsers**
- Use headphones to prevent speaker output from being picked up by the mic

---

## 📋 Requirements

- **Browser**: Google Chrome (latest version recommended)
- **OS**: Windows 10 or 11
- **Microphone**: Any USB or built-in microphone
- **Internet**: Required for Chrome's speech recognition
- **VB-Cable**: Free virtual audio cable (for ViciDial integration)

---

## 🏗️ Project Structure

```
VOICECHANGER/
├── index.html          ← Open this file in Chrome
├── css/
│   └── styles.css      ← All styling
├── js/
│   ├── app.js          ← Main application controller
│   ├── speech.js       ← Speech recognition & synthesis
│   └── visualizer.js   ← Audio waveform visualizer
└── README.md           ← This file
```

---

## 💡 How It Works

```
Your Voice (Microphone)
    ↓
Web Speech API (SpeechRecognition)
    → Converts your speech to text in real-time
    ↓
Text Processing
    → Cleans up, capitalizes, adds punctuation
    ↓
Web Speech API (SpeechSynthesis)
    → Re-speaks the text with a US English voice
    ↓
Audio Output → VB-Cable → ViciDial
    → Customer hears American accent!
```

---

## ⚡ Future Improvements

- [ ] Integration with **OpenAI Whisper** for better speech recognition
- [ ] Integration with **ElevenLabs** for ultra-realistic AI voices
- [ ] Lower latency with streaming processing
- [ ] Voice cloning (sound like a specific person)
- [ ] Multi-language support
- [ ] Browser extension for easier ViciDial integration

---

Built with ❤️ for call center professionals worldwide.
