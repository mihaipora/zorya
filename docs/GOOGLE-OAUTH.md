# Google OAuth Setup

Gives the agent read access to Gmail and read/write access to Google Calendar from inside the container.

## 1. Create a Google Cloud Project

If you don't already have a GCP project:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Sign in with the Google account whose Gmail and Calendar the agent will access
3. Click the project dropdown at the top left (next to "Google Cloud") → **New Project**
4. Name it anything (e.g. "NanoClaw") → **Create**
5. Make sure the new project is selected in the project dropdown before continuing

## 2. Enable APIs

Enable the two APIs the agent needs:

1. Go to [APIs & Services → Library](https://console.cloud.google.com/apis/library)
2. Search for **Gmail API** → click it → **Enable**
3. Go back to the Library, search for **Google Calendar API** → click it → **Enable**

## 3. Configure OAuth Consent Screen

This tells Google what your app is and who can use it.

1. Go to [APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Click **Get started** (or **Configure consent screen** if you see that instead)
3. Fill in:
   - **App name**: anything (e.g. "NanoClaw")
   - **User support email**: your email
   - **Developer contact email**: your email
4. On the **Scopes** step, click **Add or Remove Scopes** and add these two:
   - `https://www.googleapis.com/auth/gmail.readonly` (Read all Gmail messages)
   - `https://www.googleapis.com/auth/calendar.events` (View and edit Calendar events)
   - You can search for them by name ("gmail" / "calendar") in the filter box
   - Click **Update** when done
5. Click **Save and Continue** through the remaining steps
6. Under **Audience** (or **Publishing status**), leave it as **Testing**
7. Under **Test users**, click **Add users** → enter your Google email → **Save**

The app stays in "Testing" mode which is fine — only the test users you add can authorize it.

## 4. Create OAuth Client Credentials

1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Desktop app**
4. Name it anything (e.g. "NanoClaw")
5. Click **Create**
6. Click **Download JSON** on the confirmation dialog (or find it in the credentials list and click the download icon)

You'll get a file like `client_secret_123456.apps.googleusercontent.com.json`. Save it somewhere you can find it (e.g. Downloads).

## 5. Run the Script

```bash
# First time — pass the downloaded credentials file
npx tsx scripts/google-oauth.ts ~/Downloads/client_secret_*.json

# Re-run (uses saved credentials)
npx tsx scripts/google-oauth.ts
```

On macOS, this opens a browser for Google sign-in. On a headless server, it prints a URL to open manually — after authorizing, copy the redirect URL from your browser and paste it back.

## What the Script Does

1. Copies your client credentials to `~/.google-oauth/client.json`
2. Runs the OAuth consent flow (browser callback or manual paste)
3. Exchanges the authorization code for a refresh token
4. Saves everything to `~/.google-oauth/oauth.json` (permissions `600`)
5. Adds `~/.google-oauth` to the mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`)
6. Adds `~/.google-oauth` as a read-only mount to the main group's container config in SQLite

After this, the agent can read the tokens at `/workspace/extra/google-oauth/oauth.json` inside the container.

## File Locations

| File | Purpose |
|------|---------|
| `~/.google-oauth/client.json` | GCP client ID + secret |
| `~/.google-oauth/oauth.json` | Refresh token, access token, expiry, scopes |

Both files have `600` permissions. The directory is mounted read-only into the container.

## oauth.json Format

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "access_token": "...",
  "token_expiry": "2026-02-25T15:30:00Z",
  "scopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events"
  ]
}
```

The access token expires after ~1 hour. The agent should use the refresh token to get new access tokens as needed:

```bash
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=CLIENT_ID&client_secret=CLIENT_SECRET&refresh_token=REFRESH_TOKEN&grant_type=refresh_token"
```

## Troubleshooting

**"No refresh_token returned"** — You previously authorized this app and Google only sends the refresh token on first consent. Go to [Google Account → Third-party connections](https://myaccount.google.com/connections), remove the app, then re-run the script.

**"Access blocked: app has not completed the Google verification process"** — The Google account you're signing in with isn't in the test users list. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) → **Audience** → **Add users** → enter the exact Gmail address → **Save**, then re-run the script.

**"Google hasn't verified this app" warning page** — This is expected for personal/testing apps. Click the small **Advanced** link at the bottom left, then click **"Go to [your app name] (unsafe)"** to proceed. This only appears when you *are* a test user — it's the normal flow.

**Agent can't find the tokens** — Restart the bot after running the script so it picks up the new container mount config.
