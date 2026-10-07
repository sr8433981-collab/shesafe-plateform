# 🛡️ SheSafe — Women Safety & Emergency Response Web System

> **A mission-critical Women Safety and Real-Time Emergency Response Platform built with a complete Modern Frontend, RESTful Backend (Node.js & Python Flask), Interactive GPS Mapping, Web Audio Emergency Siren, and Safety Guardian Tools.**

---

## 🌟 Key Highlights & Feature Matrix

| Feature | Description | Status |
| :--- | :--- | :---: |
| **1️⃣ Landing & Auth** | Direct Login & Sign Up with password toggle, emergency contact setup, location permission, and 1-Click Demo Login (`Sweta Sharma`) | ✅ Complete |
| **2️⃣ Main Dashboard** | Top Header, Greeting (`Good Evening, Sweta 👋`), live battery/GPS pill, 4 Hero Emergency Buttons & Safety Features | ✅ Complete |
| **3️⃣ 🆘 SOS System** | Emergency sound siren (Web Audio API), 4-stage verified checklist animation, GPS coordinate dispatch to Police & Contacts | ✅ Complete |
| **4️⃣ 📞 Emergency Numbers** | Directory of 112, 181, 100, 108, 101, 1091, 1098, 1930 with interactive calling simulation overlay | ✅ Complete |
| **5️⃣ 📍 Safe Zones** | Interactive Leaflet.js map with Police Pink Booths, Hospitals, Safe Shelters, 24/7 Pharmacies + turn-by-turn Navigation | ✅ Complete |
| **6️⃣ 🗺️ Live Location** | Real-time GPS stream, shareable live track URL, guardian contact stream, and single-click Stop Sharing | ✅ Complete |
| **7️⃣ Safety Features Suite** | Emergency Contacts Manager, 🟢 "I'm Safe" Check-In, ⏰ Safety Journey Timer with Auto-Alert, Incident Reporter, Community Alerts | ✅ Complete |
| **📡 Full-Stack Backend** | Dual Backend options (Node.js & Python Flask) with RESTful API, JSON persistence & offline auto-fallback | ✅ Complete |

---

## 📁 Project Architecture

```text
women_safety/
├── backend/
│   ├── server.js              # Node.js REST API & static file web server (Zero-dep fallback)
│   ├── app.py                 # Python Flask REST API server alternative
│   ├── requirements.txt       # Python dependencies (flask, flask-cors)
│   └── data/
│       └── db.json            # Seed database (Users, Contacts, Helplines, Safe Zones, Alerts)
├── frontend/
│   ├── index.html             # Single Page Application HTML with all views and modals
│   ├── css/
│   │   └── style.css          # Responsive design with glassmorphism, pulse animations & safety theme
│   └── js/
│       ├── api.js             # API communications layer with seamless localStorage fallback
│       ├── auth.js            # Login, signup, demo bypass, and profile state manager
│       ├── sos.js             # Web Audio API emergency siren oscillator & 4-step SOS checklist
│       ├── map.js             # Leaflet.js OpenStreetMap, GPS tracking, and Safe Zone markers
│       ├── features.js        # Emergency numbers, calling screen, check-in, journey timer & alerts
│       └── main.js            # View router, mobile drawer, modal orchestrator & toasts
├── package.json               # Node.js project manifest & scripts
├── run.bat                    # 1-Click Windows launcher
└── README.md                  # Documentation and presentation guide
```

---

## 🚀 How to Run

You have **three super easy ways** to run SheSafe:

### Option 1: 1-Click Launch (Recommended for Windows)
Double-click `run.bat` in the project root folder. It automatically detects Node.js or Python and opens your browser!

---

### Option 2: Using Node.js Backend
```bash
# In the project directory:
node backend/server.js
```
Open your browser at: **`http://localhost:3000`**

*(Note: The server uses Node's standard libraries, so it runs immediately even without `npm install`!)*

---

### Option 3: Using Python Flask Backend
```bash
# Install dependencies (if not installed):
pip install -r backend/requirements.txt

# Run Python server:
python backend/app.py
```
Open your browser at: **`http://localhost:5000`**

---

### Option 4: Direct Standalone Browser Preview
Simply double-click **`frontend/index.html`** in your browser!
Thanks to the smart `api.js` client fallback, **every single feature (SOS, Siren, Check-In, Safety Timer, Contacts, and Maps) works 100% offline without needing any server running!**

---

## 🎯 Hackathon / Project Presentation Walkthrough

Here is the exact recommended presentation script for demoing to judges or evaluators:

1. **Landing / Login Page (`1️⃣ Landing / Login Page`)**:
   - Point out the 🛡️ **SheSafe** branding and 24/7 top emergency helpline strip (`112 | 181 | 100`).
   - Click the **"🚀 Instant 1-Click Demo Login (Sweta)"** button.
   - Show how it instantly logs in as Sweta Sharma and transitions directly into the Dashboard.

2. **Main Dashboard Overview (`2️⃣ Main Dashboard`)**:
   - Highlight the personalized greeting: *"Good Evening, Sweta 👋 Stay Safe. Stay Connected."*
   - Point out the **Live Shield Status** indicating active GPS and emergency contacts.
   - Show the **Main 4 Emergency Big Hero Buttons**:
     - `🆘 SOS — Send Alert`
     - `📞 EMERGENCY NUMBERS`
     - `📍 SAFE ZONE — Find Nearby`
     - `🗺️ LIVE LOCATION SHARE`

3. **Triggering 🆘 SOS Alert (`3️⃣ SOS Button`)**:
   - Tap the big crimson **SOS** button.
   - Listen to the synthesized emergency alarm siren generated live using the Web Audio API.
   - Observe the 4-step emergency dispatch checklist animation:
     - `✓ Emergency alert prepared`
     - `✓ Current location captured` (with live GPS telemetry)
     - `✓ Emergency contacts notified` (simulated SMS dispatch)
     - `✓ Help request initiated to Police Control Room (112 ERSS)`
   - Show the **"🛑 Cancel SOS"** button to end the alert when safe.

4. **Emergency Helplines (`4️⃣ Emergency Numbers`)**:
   - Click **"📞 EMERGENCY NUMBERS"**.
   - Show 112 (National ERSS), 181 (Women Helpline), 100 (Police), 108 (Ambulance), 101 (Fire), 1091 (NCW), 1098 (Childline), and 1930 (Cyber Crime).
   - Click the **[ CALL ]** button on any card to showcase the interactive calling overlay screen with connection timer!

5. **Safe Zones & Nearby Facilities (`5️⃣ Safe Zone`)**:
   - Click **"📍 SAFE ZONE"**.
   - Showcase the interactive OpenStreetMap with pins for:
     - 👮 Police Station & Pink Booth (1.2 km away)
     - 🏥 City Hospital Trauma Center (1.8 km away)
     - 🏠 Safe Shelter & Crisis Center (2.1 km away)
     - 💊 24/7 Apollo Pharmacy (600m away)
     - 🌸 Women Help Centre & Pink Patrol (900m away)
   - Click **[ Navigate ]** to show immediate route opening in Google Maps.

6. **Live Location Streaming (`6️⃣ Live Location`)**:
   - Click **"🗺️ LIVE LOCATION SHARE"**.
   - See the real-time blinking GPS marker and live coordinate ticker.
   - See the list of trusted contacts actively receiving coordinates (`Mom`, `Sister`, `Aman`).
   - Demonstrate the **[ Stop Sharing ]** and **[ Copy Link ]** features.

7. **Safety Features Suite (`7️⃣ Dashboard Features`)**:
   - **🟢 Safety Check-In**: Tap *"🟢 I'M SAFE — Check In"*. Notice the instant toast notification and the updated timeline log: *"Sweta has checked in and is safe."*
   - **⏰ Safety Timer (Journey Guard)**: Set commute from *College* to *Home* for 5 or 15 mins. Show the ticking countdown. If expired, show the urgent prompt: *"⚠️ Safety Check Required — Are you safe? [I'M SAFE] [SEND ALERT]"*.
   - **📝 Incident Report**: Open the confidential incident form (Harassment, Stalking, Eve-teasing, Poor Lighting) with anonymous reporting toggle.
   - **📢 Community Alerts**: View crowd-sourced safety notices with verified vs community-reported badges and upvote capability.

---

## 📡 REST API Reference

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/api/auth/login` | `POST` | Authenticate user via email/mobile and password |
| `/api/auth/signup` | `POST` | Register new user with emergency contact |
| `/api/emergency-numbers` | `GET` | Retrieve official 24x7 emergency helplines |
| `/api/contacts` | `GET` / `POST` | Retrieve and add emergency contacts |
| `/api/contacts/:id` | `DELETE` | Remove emergency contact |
| `/api/safe-zones` | `GET` | Get list and coordinates of nearby safe places |
| `/api/sos/trigger` | `POST` | Dispatch active emergency alert and notify contacts |
| `/api/sos/cancel` | `POST` | Cancel active emergency and notify safe status |
| `/api/checkins` | `GET` / `POST` | Fetch history or post new "I'm Safe" check-in |
| `/api/community-alerts` | `GET` / `POST` | Retrieve and broadcast community safety warnings |
| `/api/incidents` | `GET` / `POST` | Submit confidential incident report |

---

## 🛡️ Built with care for Women's Safety & Empowerment
SheSafe ensures safety is accessible at a single tap, anytime, anywhere.
