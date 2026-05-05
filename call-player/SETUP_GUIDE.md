# Call Player — Setup Guide

Follow these steps once and your app lives on your iPhone home screen forever.
Total time: ~20 minutes.

---

## Step 1 — Get your Fathom API key

1. Open **fathom.video** and log in
2. Click your profile picture (top right) → **Settings**
3. Find the **API** or **Integrations** section
4. Click **Create API Key** — copy it and save it somewhere safe

---

## Step 2 — Create a free GitHub account (if you don't have one)

1. Go to **github.com** → Sign up (free)
2. Verify your email

---

## Step 3 — Put the app on GitHub

1. On github.com, click the **+** button (top right) → **New repository**
2. Name it `call-player`, set it to **Private**, click **Create repository**
3. On the next page, click **uploading an existing file**
4. Drag the entire **`fathom-player`** folder contents into the upload area:
   - `app.py`
   - `requirements.txt`
   - `Procfile`
   - `render.yaml`
   - `.gitignore`
   - The entire `static/` folder (index.html, app.js, styles.css, manifest.json, sw.js, icon-192.png, icon-512.png)
5. Click **Commit changes**

---

## Step 4 — Deploy to Render (free hosting)

1. Go to **render.com** → Sign up with your GitHub account (free)
2. Click **New +** → **Web Service**
3. Click **Connect** next to your `call-player` repository
4. Render will auto-detect the settings. Verify:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 60`
   - **Plan:** Free
5. Scroll down to **Environment Variables** and add:
   - `FATHOM_API_KEY` = *(paste your key from Step 1)*
6. Click **Create Web Service**
7. Wait ~3 minutes for it to build and deploy
8. Render gives you a URL like `https://call-player-xxxx.onrender.com` — copy it

---

## Step 5 — Add to your iPhone home screen

1. On your iPhone, open **Safari** (must be Safari, not Chrome)
2. Go to your Render URL from Step 4
3. Wait for the app to load (first load may take ~30 seconds — Render free tier wakes up)
4. Tap the **Share** button (box with arrow pointing up)
5. Scroll down and tap **Add to Home Screen**
6. Name it **Call Player** → tap **Add**

The app icon now lives on your home screen. Open it like any other app.

---

## Step 6 — Enable video playback (optional but recommended)

The API gives us call lists and transcripts automatically. For native video/audio playback, follow these steps once:

1. Open **fathom.video** on your **desktop Mac** in Chrome or Safari
2. Log in, open any recording
3. Open **DevTools**:
   - Chrome: `⌘ + Option + I` → **Application** tab → **Cookies** → click `fathom.video`
   - Safari: `⌘ + Option + I` → **Storage** tab → **Cookies** → `fathom.video`
4. You'll see a list of cookies. Select all the rows, copy the values as a string in this format:
   `cookieName1=value1; cookieName2=value2; ...`
   (or just screenshot it — see note below)
5. In the Call Player app, tap the **gear icon** (top right of the Calls screen)
6. Paste the cookie string into the **Video Access** field → tap **Save**

> **Note:** Browser cookies expire periodically (usually every few weeks). If video stops working, repeat this step.

> **Alternative:** You can also set `FATHOM_SESSION` in your Render environment variables (same place you set the API key). This persists across app sessions without needing to re-enter it.

---

## Troubleshooting

**"App takes 30 seconds to open"**
Render's free tier sleeps after 15 minutes of inactivity. The first request wakes it up. After that it's instant. For $7/month you can upgrade to avoid this.

**"Transcript loads but no video"**
Complete Step 6 above to enable video. Without the session cookie, Fathom doesn't expose video URLs via their public API.

**"Could not connect to server"**
- Check your Render dashboard — is the service running (green dot)?
- Verify `FATHOM_API_KEY` is set correctly in Render's Environment Variables
- Make sure there are no extra spaces around the API key value

**"Calls list is empty"**
Your Fathom account may need at least one recorded call. Also check that the API key has access to your account's recordings.

---

## Updating the app in the future

If updates are made to the app files, just re-upload the changed files to GitHub (drag and drop again). Render will automatically redeploy within ~2 minutes.
