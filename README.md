# HEAD-HUNTER — Backend Server (EBS)

Handles live status lookups and Twitch whisper notifications for the HEAD-HUNTER extension.

---

## What it does

| Endpoint | Purpose |
|---|---|
| `GET /api/lookup?username=xyz` | Returns live status + viewer count for any Twitch username |
| `POST /api/contract` | Posts a contract + sends a whisper to the target streamer |
| `POST /api/whisper` | Sends an arbitrary whisper (internal use) |

---

## Setup — Step by Step

### 1. Get your Twitch App credentials
1. Go to [dev.twitch.tv/console](https://dev.twitch.tv/console)
2. Click **Register Your Application**
3. Name: `HEAD-HUNTER EBS` (or anything)
4. OAuth Redirect URL: `http://localhost`
5. Category: **Extension**
6. Copy your **Client ID** and generate a **Client Secret**

### 2. Get your Bot account token
Your bot account is the Twitch account that sends whispers. It can be your own account.

1. Go to [twitchtokengenerator.com](https://twitchtokengenerator.com)
2. Click **Custom Scope Token**
3. Enter your **Client ID** and **Client Secret**
4. Check the scope: `user:manage:whispers`
5. Click **Generate Token**
6. Copy the **Access Token** and **Refresh Token**

### 3. Get your Bot account's numeric User ID
1. Go to [streamweasels.com/tools/convert-twitch-username-to-user-id](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
2. Enter your bot account's username
3. Copy the numeric ID (e.g. `123456789`)

### 4. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 5. Run locally (test first)
```bash
npm install
npm start
```

Test it:
```bash
curl "http://localhost:3000/api/lookup?username=ninja"
```

---

## Deploy to Railway (free)

Railway gives you a free server with a public HTTPS URL — exactly what the extension needs.

### First time:
1. Go to [railway.app](https://railway.app) and sign up (free)
2. Install Railway CLI:
   ```bash
   npm install -g @railway/cli
   ```
3. In this folder:
   ```bash
   railway login
   railway init
   railway up
   ```
4. Set environment variables in Railway dashboard → your project → **Variables**:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `BOT_USER_ID`
   - `BOT_ACCESS_TOKEN`
   - `BOT_REFRESH_TOKEN`

5. Railway gives you a URL like: `https://head-hunter-ebs-production.up.railway.app`

### After any code change:
```bash
railway up
```

---

## Connect to the Extension

Once deployed, copy your Railway URL and paste it into `viewer.js` at the top:

```js
var EBS_URL = 'https://your-app.up.railway.app';
```

That's it — the extension will automatically use the backend for live lookups and whispers.

---

## Twitch Whisper Requirements

Twitch has restrictions on who can receive whispers from bots:
- The bot must **not** be banned or restricted on Twitch
- The bot account should have a **verified phone number**
- If the target has **whispers from strangers blocked** in their Twitch settings, they won't receive it (this is the target's own privacy setting — nothing you can do about it)
- Recommended: have your bot follow the target before sending (reduces rejection rate)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `403` on whisper | Bot account needs a verified phone number on Twitch |
| `401` on whisper | Access token expired — the server auto-refreshes, but check your refresh token is correct |
| Lookup returns offline | Normal — some streamers have privacy settings that hide their stream from the API |
| CORS errors | Make sure your Railway domain ends in `.up.railway.app` |
