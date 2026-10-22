# 🛡️ PhishGuard — Real-Time Anti-Vishing Voice Companion

PhishGuard is an automated, eyes-free security companion designed to protect vulnerable users from telephone fraud, bank impersonation, and social engineering attacks (vishing). Operating entirely in real-time, PhishGuard listens to speakerphone call streams, transcribes dialogue in sub-second cycles, measures threat patterns, and issues immediate audible warnings when fraud is detected.

---

## ✨ Key Features

* **Sub-Second Audio Transcription:** Powered by **Groq Whisper (`whisper-large-v3`)** to convert incoming speakerphone audio chunks into text with near-zero latency.
* **Instant Fraud Analysis:** Utilizes **OpenAI gpt-oss (`gpt-oss-120b`)** in JSON mode to evaluate conversation transcripts for manipulation markers, OTP demands, and urgency pressure.
* **Dynamic Live Threat Gauge:** A circular SVG risk meter (0-100) that visually shifts state between **Safe (Green)**, **Suspicious (Yellow)** and **CRITICAL (Flashing Red)**, along with automatically tagging scam styles.
* **Zero-Key Vocal Warnings:** Integrates the browser-native **Web Speech API** to deliver instant, voice warnings directly to the user when risk scores breach 70%.
* **One-Tap Emergency Deterrent:** A dedicated emergency action button that broadcasts an authoritative warning script back down the line to deter attackers.
* **Real-Time Records & Analytics:** Every monitored call, its peak risk and scam type, and how threats are trending over time. Data is stored in this browser only.
* **Scam Library:** To aware and test people about scammers' tactics and possible solutions.
---

## 🛠️ Tech Stack & Models

| Component | Technology / Model | Description |
| :--- | :--- | :--- |
| **Frontend** | HTML5, Tailwind CSS, Vanilla JS | Dark-mode tactical cybersecurity UI with Framer-style transitions. |
| **Backend** | FastAPI (Python 3.10+), Uvicorn | Asynchronous REST backend handling chunk ingestion and AI orchestration. |
| **Speech-to-Text** | Groq Whisper (`whisper-large-v3`) | Ultra-fast speech recognition API for low-latency chunk processing. |
| **Scam Classifier** | OpenAI gpt-oss (`gpt-oss-120b`) | High-reasoning LLM with strict JSON schema outputs for threat scoring. |
| **Voice Synthesis** | Web Speech API (`window.speechSynthesis`) | Zero-key, zero-latency local speech engine for vocal alerts & deterrents. |

---

## 🚀 Quick Start Guide
Prerequisites
* Python 3.10 or higher
* Google Chrome or Microsoft Edge
* Groq API Key

**1. Clone the Repository.**  
**2. Backend Setup:**  
   cd backend

   python -m venv venv
   .\venv\Scripts\activate

   pip install -r requirements.txt

* Create a .env file in the backend/ folder:  
  GROQ_API_KEY=gsk_your_actual_groq_api_key_here
* Launch the FastAPI server:  
  python -m uvicorn app.main:app --reload --port 8000

**3. Frontend Setup**  
* Open a second terminal tab at the project root:  
cd frontend  
python -m http.server 5500
* Open http://localhost:5500 in your web browser.

---

## 🔒 Privacy & Security:  
* No Data Retention: Audio chunks are processed in-memory, transcribed via API, and immediately discarded.  
* Secret Protection: .env secret key files are strictly excluded from repository commits via .gitignore.  
