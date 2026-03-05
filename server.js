// ═══════════════════════════════════════════════════════════
//  HEAD-HUNTER — Extension Backend Service (EBS)
//  Handles: live status lookup, chat notifications
//  Deploy to Railway: railway up
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: function(req, res, buf) { req.rawBody = buf.toString(); }
}));
app.use(cors({
  origin: [
    /\.twitch\.tv$/,
    /\.ext-twitch\.tv$/,
    'http://localhost:8080'
  ]
}));


// ─── POSTGRES (shared bounty network) ─────────────────────
// Attach a free PostgreSQL database in Render → DATABASE_URL is set automatically
// If DATABASE_URL is not set, extension runs in local mode (no cross-channel sync)
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

var dbReady = false;

async function initDb() {
  if (!pool) {
    console.log('[db] No DATABASE_URL — local mode only, no cross-channel sync');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS network_channels (
        channel_id    TEXT PRIMARY KEY,
        channel_login TEXT NOT NULL,
        display_name  TEXT,
        opted_in      BOOLEAN DEFAULT true,
        opted_in_at   TIMESTAMPTZ DEFAULT NOW(),
        last_seen     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS network_contracts (
        id            TEXT PRIMARY KEY,
        channel_id    TEXT NOT NULL,
        channel_login TEXT NOT NULL,
        target        TEXT NOT NULL,
        game          TEXT NOT NULL,
        platform      TEXT DEFAULT 'PC',
        reward        TEXT NOT NULL,
        bits_amount   INTEGER DEFAULT 0,
        conditions    TEXT,
        expiry_label  TEXT,
        expires_at    TIMESTAMPTZ,
        posted_at     TIMESTAMPTZ DEFAULT NOW(),
        posted_by     TEXT,
        claimed       BOOLEAN DEFAULT false,
        claimed_by    TEXT,
        claimed_at    TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS network_submissions (
        id             TEXT PRIMARY KEY,
        contract_id    TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        target         TEXT NOT NULL,
        game           TEXT NOT NULL,
        total_reward   TEXT NOT NULL,
        clip_url       TEXT NOT NULL,
        platform       TEXT DEFAULT 'TWITCH',
        submitted_by       TEXT,
        submitted_by_login TEXT,
        submitted_at   TIMESTAMPTZ DEFAULT NOW(),
        status         TEXT DEFAULT 'review',
        approves       INTEGER DEFAULT 0,
        rejects        INTEGER DEFAULT 0,
        vote_closes_at TIMESTAMPTZ,
        claimed_at     TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS network_votes (
        submission_id TEXT NOT NULL,
        voter_id      TEXT NOT NULL,
        vote          TEXT NOT NULL,
        voted_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (submission_id, voter_id)
      );
      CREATE INDEX IF NOT EXISTS idx_nc_active  ON network_contracts(claimed, expires_at);
      CREATE INDEX IF NOT EXISTS idx_ns_status  ON network_submissions(status);
    `);
    // Run migrations — safely add columns that may not exist on older deployments
    await client.query(`
      ALTER TABLE network_submissions ADD COLUMN IF NOT EXISTS submitted_by_login TEXT;
      ALTER TABLE network_contracts   ADD COLUMN IF NOT EXISTS bits_amount INTEGER DEFAULT 0;
    `).catch(function(){});

    dbReady = true;
    console.log('[db] Network tables ready — cross-channel sync active');
  } finally {
    client.release();
  }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ─── TOKEN CACHE ──────────────────────────────────────────
var appToken       = null;
var appTokenExpiry = 0;

// Bot user token — needs scope: user:write:chat
var botToken           = process.env.BOT_ACCESS_TOKEN    || null;
var botRefreshToken    = process.env.BOT_REFRESH_TOKEN   || null;
var botUserId          = process.env.BOT_USER_ID          || null;

// The broadcaster's channel where the bot posts — must be set in Render env vars
// Get your numeric Twitch user ID at: https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
var broadcasterUserId  = process.env.BROADCASTER_USER_ID || null;

// ─── GET APP ACCESS TOKEN ─────────────────────────────────
async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiry) return appToken;
  const res  = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type:    'client_credentials'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get app token: ' + JSON.stringify(data));
  appToken       = data.access_token;
  appTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  console.log('[token] App access token refreshed');
  return appToken;
}

// ─── REFRESH BOT TOKEN ────────────────────────────────────
async function refreshBotToken() {
  if (!botRefreshToken) throw new Error('No bot refresh token configured');
  const res  = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: botRefreshToken
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to refresh bot token: ' + JSON.stringify(data));
  botToken        = data.access_token;
  botRefreshToken = data.refresh_token;
  console.log('[token] Bot user token refreshed');
  return botToken;
}

// ─── GET USER ID BY USERNAME ──────────────────────────────
async function getUserId(username) {
  const token = await getAppToken();
  const res   = await fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(username), {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id':     process.env.TWITCH_CLIENT_ID
    }
  });
  const data = await res.json();
  return data.data && data.data[0] ? { id: data.data[0].id, login: data.data[0].login } : null;
}

// ─── SEND CHAT MESSAGE ────────────────────────────────────
// Sends a message to a channel's chat using Twitch Helix chat API
// broadcaster_id = channel owner's numeric ID
// sender_id      = bot's numeric ID
async function sendChatMessage(broadcasterUserId, message, token) {
  const cleanToken = (token || '').replace(/^oauth:/i, '');
  return fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cleanToken,
      'Client-Id':     process.env.TWITCH_CLIENT_ID,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterUserId,
      sender_id:      botUserId,
      message:        message
    })
  });
}

// ─── CHANNEL POINTS REDEMPTION STORE ─────────────────────
// In-memory store: { channelId: [ redemption, ... ] }
// Free Render tier has no persistent disk, so this resets on redeploy
// Redemptions are consumed by the extension polling /api/redemptions
var pendingRedemptions = {};

// ─── EVENTSUB WEBHOOK SECRET ──────────────────────────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'headhunter-secret';

// Verify Twitch EventSub signature
function verifyTwitchSignature(req) {
  const msgId        = req.headers['twitch-eventsub-message-id']        || '';
  const msgTimestamp = req.headers['twitch-eventsub-message-timestamp']  || '';
  const msgSignature = req.headers['twitch-eventsub-message-signature']  || '';
  const body         = req.rawBody || '';
  const hmacMsg      = msgId + msgTimestamp + body;
  const crypto       = require('crypto');
  const expected     = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(hmacMsg).digest('hex');
  return expected === msgSignature;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'HEAD-HUNTER EBS' });
});

// Extension ID for HEAD-HUNTER
const EXTENSION_ID = 'syw6rysu5tf8znr3f97k16pcv9u9wg';

// ─── GET /api/lookup?username=xyz ─────────────────────────
app.get('/api/lookup', async (req, res) => {
  const username = (req.query.username || '').trim().toLowerCase();
  const userId   = (req.query.id || '').trim();

  if (!username && !userId) return res.status(400).json({ error: 'username or id required' });

  // Quick ID-only lookup — just returns login name, no stream data needed
  if (userId && !username) {
    try {
      const token = await getAppToken();
      const r = await fetch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId), {
        headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
      });
      const d = await r.json();
      if (d.data && d.data[0]) {
        return res.json({ found: true, id: d.data[0].id, login: d.data[0].login, display_name: d.data[0].display_name });
      }
      return res.status(404).json({ found: false, error: 'User not found' });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const token = await getAppToken();
    const [userRes, streamRes] = await Promise.all([
      fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(username), {
        headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
      }),
      fetch('https://api.twitch.tv/helix/streams?user_login=' + encodeURIComponent(username), {
        headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
      })
    ]);

    const userData   = await userRes.json();
    const streamData = await streamRes.json();
    const user       = userData.data   && userData.data[0];
    const stream     = streamData.data && streamData.data[0];

    if (!user) return res.status(404).json({ found: false, error: 'User not found' });

    // Check if target has HEAD-HUNTER extension installed
    let hasExtension = false;
    try {
      const extRes  = await fetch('https://api.twitch.tv/helix/users/extensions?user_id=' + user.id, {
        headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
      });
      const extData = await extRes.json();
      if (extData.data) {
        const allExts = Object.values(extData.data).reduce(function(all, slot) {
          return all.concat(Object.values(slot));
        }, []);
        hasExtension = allExts.some(function(ext) { return ext.id === EXTENSION_ID && ext.active; });
      }
    } catch (extErr) {
      console.warn('[lookup] Extension check failed (non-fatal):', extErr.message);
    }

    res.json({
      found:         true,
      id:            user.id,
      login:         user.login,
      display_name:  user.display_name,
      profile_image: user.profile_image_url,
      is_live:       !!stream,
      viewer_count:  stream ? stream.viewer_count : 0,
      game:          stream ? stream.game_name    : null,
      title:         stream ? stream.title        : null,
      has_extension: hasExtension
    });
  } catch (err) {
    console.error('[lookup] Error:', err.message);
    res.status(500).json({ error: 'Lookup failed', detail: err.message });
  }
});

// ─── POST /api/contract ───────────────────────────────────
// Posts a bounty and sends a chat message in the target's channel
// Body: { target, game, platform, reward, expiry, conditions }
app.post('/api/contract', async (req, res) => {
  const { target, game, platform, reward, expiry, conditions, broadcaster_id } = req.body || {};
  if (!target || !game || !reward) {
    return res.status(400).json({ error: 'target, game, and reward are required' });
  }

  // Post to broadcaster's own channel (where bot is modded), not the target's channel
  const channelId = broadcaster_id || broadcasterUserId;

  const chatMsg = '☠ HEAD-HUNTER BOUNTY ALERT ☠ '
    + 'A bounty of ' + reward + ' has been placed on @' + target + '! '
    + 'Game: ' + game
    + (expiry && expiry !== 'No expiry' ? ' · Expires: ' + expiry : '')
    + (conditions ? ' · Conditions: ' + conditions : '')
    + ' — Hunters, open the HEAD-HUNTER panel to claim the contract!';

  var chatResult = 'not_sent';

  try {
    if (!botToken || !botUserId) {
      chatResult = 'bot_not_configured';
      console.warn('[contract] Bot not configured — set BOT_ACCESS_TOKEN and BOT_USER_ID');
    } else if (!channelId) {
      chatResult = 'no_channel';
      console.warn('[contract] No broadcaster channel — set BROADCASTER_USER_ID env var');
    } else {
      let chatRes = await sendChatMessage(channelId, chatMsg, botToken);

      if (chatRes.status === 401) {
        console.log('[chat] 401 — refreshing bot token...');
        const newToken = await refreshBotToken();
        chatRes = await sendChatMessage(channelId, chatMsg, newToken);
      }

      if (chatRes.status === 200 || chatRes.status === 204) {
        chatResult = 'sent';
        console.log('[chat] Bounty alert sent to broadcaster channel for target: ' + target);
      } else {
        const errBody = await chatRes.text();
        console.error('[chat] Failed status=' + chatRes.status + ' body=' + errBody);
        chatResult = 'failed';
      }
    }
  } catch (err) {
    console.error('[contract] Chat error (non-fatal):', err.message);
    chatResult = 'error';
  }

  res.json({ success: true, target, chat: chatResult });
});

// ─── POST /api/eventsub ───────────────────────────────────
// Receives Twitch EventSub channel point redemption webhooks
app.post('/api/eventsub', (req, res) => {
  const msgType = req.headers['twitch-eventsub-message-type'];

  // Verify signature
  if (!verifyTwitchSignature(req)) {
    console.warn('[eventsub] Invalid signature — rejected');
    return res.status(403).send('Forbidden');
  }

  // Respond to challenge (subscription verification)
  if (msgType === 'webhook_callback_verification') {
    console.log('[eventsub] Subscription verified');
    return res.status(200).send(req.body.challenge);
  }

  // Revocation
  if (msgType === 'revocation') {
    console.log('[eventsub] Subscription revoked');
    return res.sendStatus(204);
  }

  // Handle notification
  if (msgType === 'notification') {
    const event = req.body.event;
    if (event && event.reward) {
      const channelId = event.broadcaster_user_id;
      const userName  = event.user_name || event.user_login;
      const rewardTitle = event.reward.title || '';

      // Only process HEAD-HUNTER rewards
      if (rewardTitle.toLowerCase().indexOf('head-hunter') !== -1 ||
          rewardTitle.toLowerCase().indexOf('headhunter')  !== -1 ||
          rewardTitle.toLowerCase().indexOf('bounty')      !== -1) {

        if (!pendingRedemptions[channelId]) pendingRedemptions[channelId] = [];
        pendingRedemptions[channelId].push({
          id:          event.id,
          redeemedBy:  userName,
          rewardTitle: rewardTitle,
          rewardCost:  event.reward.cost,
          userInput:   event.user_input || '',
          redeemedAt:  Date.now()
        });
        console.log('[eventsub] Channel points redemption stored for channel', channelId, 'by', userName);
      }
    }
    return res.sendStatus(204);
  }

  res.sendStatus(204);
});

// ─── GET /api/redemptions?channel_id=xyz ─────────────────
// Extension polls this to check for pending channel point bounties
app.get('/api/redemptions', (req, res) => {
  const channelId = req.query.channel_id;
  if (!channelId) return res.status(400).json({ error: 'channel_id required' });

  const items = pendingRedemptions[channelId] || [];
  // Return and clear pending redemptions for this channel
  pendingRedemptions[channelId] = [];
  res.json({ redemptions: items });
});

// ─── POST /api/subscribe-channel-points ──────────────────
// Broadcaster calls this once to register EventSub subscription
app.post('/api/subscribe-channel-points', async (req, res) => {
  const { broadcaster_id } = req.body || {};
  if (!broadcaster_id) return res.status(400).json({ error: 'broadcaster_id required' });

  const callbackUrl = (process.env.RENDER_EXTERNAL_URL || 'https://head-hunter-backend.onrender.com') + '/api/eventsub';

  try {
    const token = await getAppToken();
    const subRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id':     process.env.TWITCH_CLIENT_ID,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        type:      'channel.channel_points_custom_reward_redemption.add',
        version:   '1',
        condition: { broadcaster_user_id: broadcaster_id },
        transport: {
          method:   'webhook',
          callback: callbackUrl,
          secret:   WEBHOOK_SECRET
        }
      })
    });
    const data = await subRes.json();
    if (data.error) {
      console.error('[subscribe] Failed:', data);
      return res.status(400).json({ error: data.message || 'Subscription failed', detail: data });
    }
    console.log('[subscribe] EventSub subscription created for', broadcaster_id);
    res.json({ success: true, subscription: data.data && data.data[0] });
  } catch (err) {
    console.error('[subscribe] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payout ─────────────────────────────────
// Sends a chat message when bounty is paid out
app.post('/api/payout', async (req, res) => {
  const { target, reward, hunter, count, broadcaster, seAwarded } = req.body || {};
  if (!target || !reward) return res.status(400).json({ error: 'target and reward required' });

  const bountyWord  = count && count > 1 ? count + ' bounties' : 'bounty';
  const hunterLabel = hunter && hunter !== 'A hunter' ? '@' + hunter : 'a hunter';
  const seNote      = seAwarded && seAwarded > 0
    ? ' ⚡ ' + Number(seAwarded).toLocaleString() + ' SE Points auto-awarded to hunter!'
    : '';
  const chatMsg = '☠ HEAD-HUNTER — BOUNTY COMPLETED! '
    + 'The ' + bountyWord + ' on @' + target + ' has been claimed by ' + hunterLabel + '! '
    + 'Prize: ' + reward + seNote + ' — To the victor goes the spoils!';

  var chatResult = 'not_sent';

  // Send to broadcaster's channel (where the extension lives) AND target's channel
  const channelsToNotify = [];
  try {
    if (!botToken || !botUserId) {
      chatResult = 'bot_not_configured';
    } else {
      // Post to broadcaster's channel (where bot is modded)
      // Use BROADCASTER_USER_ID env var, or broadcaster login passed in body
      if (broadcasterUserId) {
        channelsToNotify.push({ id: broadcasterUserId, name: broadcaster || 'broadcaster' });
      } else if (broadcaster) {
        const bcUser = await getUserId(broadcaster);
        if (bcUser) channelsToNotify.push({ id: bcUser.id, name: broadcaster });
      }
      // If neither available, fall back to target's channel (may fail without mod)
      if (channelsToNotify.length === 0) {
        const targetUser = await getUserId(target);
        if (targetUser) channelsToNotify.push({ id: targetUser.id, name: target });
      }

      if (channelsToNotify.length === 0) {
        chatResult = 'user_not_found';
      } else {
        var anyFailed = false;
        for (var i = 0; i < channelsToNotify.length; i++) {
          var ch = channelsToNotify[i];
          let chatRes = await sendChatMessage(ch.id, chatMsg, botToken);
          if (chatRes.status === 401) {
            console.log('[payout] 401 — refreshing bot token...');
            const newToken = await refreshBotToken();
            chatRes = await sendChatMessage(ch.id, chatMsg, newToken);
          }
          if (chatRes.status === 200 || chatRes.status === 204) {
            console.log('[payout] Chat sent to ' + ch.name + ': sent');
          } else {
            const errBody = await chatRes.text();
            console.error('[payout] Chat FAILED to ' + ch.name + ' — status:', chatRes.status, '— body:', errBody);
            anyFailed = true;
          }
        }
        chatResult = anyFailed ? 'partial' : 'sent';
      }
    }
  } catch (err) {
    console.error('[payout] Error:', err.message);
    chatResult = 'error';
  }

  res.json({ success: true, target, chat: chatResult });
});

// ─── STREAMELEMENTS HELPERS ──────────────────────────────
const SE_API       = 'https://api.streamelements.com/kappa/v2';
const SE_CHANNEL   = process.env.SE_CHANNEL_ID  || '';
const SE_JWT       = process.env.SE_JWT_TOKEN    || '';

async function seRequest(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + SE_JWT,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(SE_API + path, opts);
}

// ─── GET /api/se/balance?username=xyz ─────────────────
app.get('/api/se/balance', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!SE_JWT || !SE_CHANNEL) return res.status(503).json({ error: 'SE not configured' });
  try {
    const r    = await seRequest('GET', '/points/' + SE_CHANNEL + '/' + encodeURIComponent(username));
    const data = await r.json();
    if (data.points !== undefined) {
      console.log('[se/balance]', username, '→', data.points);
      res.json({ username, points: data.points });
    } else {
      console.warn('[se/balance] unexpected response:', data);
      res.status(404).json({ error: 'User not found in SE', detail: data });
    }
  } catch (err) {
    console.error('[se/balance] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/se/deduct ──────────────────────────────
// Deducts points from a viewer (bounty placer)
app.post('/api/se/deduct', async (req, res) => {
  const { username, points, reason } = req.body || {};
  if (!username || !points) return res.status(400).json({ error: 'username and points required' });
  if (!SE_JWT || !SE_CHANNEL) return res.status(503).json({ error: 'SE not configured' });
  try {
    const r    = await seRequest('DELETE', '/points/' + SE_CHANNEL + '/' + encodeURIComponent(username) + '/' + Math.abs(parseInt(points)));
    const data = await r.json();
    console.log('[se/deduct]', username, '-', points, 'pts | reason:', reason, '| result:', data.newAmount);
    res.json({ success: true, username, deducted: points, newAmount: data.newAmount });
  } catch (err) {
    console.error('[se/deduct] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/se/award ───────────────────────────────
// Awards points to a viewer (hunter payout or refund)
app.post('/api/se/award', async (req, res) => {
  const { username, points, reason } = req.body || {};
  if (!username || !points) return res.status(400).json({ error: 'username and points required' });
  if (!SE_JWT || !SE_CHANNEL) return res.status(503).json({ error: 'SE not configured' });
  try {
    const r    = await seRequest('PUT', '/points/' + SE_CHANNEL + '/' + encodeURIComponent(username) + '/' + Math.abs(parseInt(points)));
    const data = await r.json();
    console.log('[se/award]', username, '+', points, 'pts | reason:', reason, '| result:', data.newAmount);
    res.json({ success: true, username, awarded: points, newAmount: data.newAmount });
  } catch (err) {
    console.error('[se/award] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════
//  NETWORK ROUTES — Cross-channel shared bounty board
//  All routes require DATABASE_URL to be set in Render env
// ═══════════════════════════════════════════════════════════

// ── GET /api/network/status ───────────────────────────────
app.get('/api/network/status', (req, res) => {
  res.json({ enabled: dbReady, service: 'HEAD-HUNTER NETWORK' });
});

// ── POST /api/network/optin ────────────────────────────────
app.post('/api/network/optin', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available — DATABASE_URL not set' });
  const { channel_id, channel_login, display_name, opted_in } = req.body || {};
  if (!channel_id || !channel_login) return res.status(400).json({ error: 'channel_id and channel_login required' });
  try {
    await pool.query(`
      INSERT INTO network_channels (channel_id, channel_login, display_name, opted_in, last_seen)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (channel_id) DO UPDATE SET opted_in=$4, channel_login=$2, display_name=$3, last_seen=NOW()
    `, [channel_id, channel_login, display_name || channel_login, opted_in !== false]);
    console.log('[network] ' + channel_login + (opted_in !== false ? ' joined' : ' left') + ' the network');
    res.json({ success: true, opted_in: opted_in !== false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/network/channels ─────────────────────────────
app.get('/api/network/channels', async (req, res) => {
  if (!dbReady) return res.json({ channels: [] });
  try {
    const r = await pool.query(
      'SELECT channel_id, channel_login, display_name, opted_in_at FROM network_channels WHERE opted_in=true ORDER BY opted_in_at ASC'
    );
    res.json({ channels: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/network/contracts ────────────────────────────
app.get('/api/network/contracts', async (req, res) => {
  if (!dbReady) return res.json({ contracts: [], ts: new Date().toISOString() });
  const { channel_id, since } = req.query;
  try {
    let q = `
      SELECT c.*, ch.display_name as channel_display
      FROM network_contracts c
      LEFT JOIN network_channels ch ON ch.channel_id = c.channel_id
      WHERE c.claimed=false AND (c.expires_at IS NULL OR c.expires_at > NOW())
    `;
    const params = [];
    if (channel_id) { params.push(channel_id); q += ' AND c.channel_id=$' + params.length; }
    if (since)      { params.push(since);       q += ' AND c.posted_at>$'  + params.length; }
    q += ' ORDER BY c.posted_at DESC LIMIT 100';
    const r = await pool.query(q, params);
    res.json({ contracts: r.rows, ts: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/network/contract ────────────────────────────
app.post('/api/network/contract', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  const { channel_id, channel_login, target, game, platform, reward, bits_amount,
          conditions, expiry_label, expires_at, posted_by, broadcaster_id } = req.body || {};
  if (!channel_id || !target || !game || !reward)
    return res.status(400).json({ error: 'channel_id, target, game, reward required' });

  // Auto-register channel as opted in
  await pool.query(`
    INSERT INTO network_channels (channel_id, channel_login, display_name, opted_in, last_seen)
    VALUES ($1,$2,$2,true,NOW())
    ON CONFLICT (channel_id) DO UPDATE SET last_seen=NOW(), opted_in=true
  `, [channel_id, channel_login || channel_id]).catch(() => {});

  const id = uid();
  try {
    await pool.query(`
      INSERT INTO network_contracts
        (id,channel_id,channel_login,target,game,platform,reward,bits_amount,conditions,expiry_label,expires_at,posted_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [id, channel_id, channel_login || channel_id, target, game,
        platform || 'PC', reward, bits_amount || 0,
        conditions || '', expiry_label || 'No expiry', expires_at || null, posted_by || null]);

    // Build and send chat message
    const chatMsg = '☠ HEAD-HUNTER BOUNTY ALERT ☠ '
      + 'A bounty of ' + reward + ' has been placed on @' + target + '! Game: ' + game
      + (expiry_label && expiry_label !== 'No expiry' ? ' · Expires: ' + expiry_label : '')
      + (conditions ? ' · Conditions: ' + conditions : '')
      + ' — Hunters, open the HEAD-HUNTER panel to claim!';

    const chatChannelId = broadcaster_id || broadcasterUserId || channel_id;
    var chatResult = 'not_sent';
    try {
      let chatRes2 = await sendChatMessage(chatChannelId, chatMsg, botToken);
      if (chatRes2.status === 401) {
        const newTok = await refreshBotToken();
        chatRes2 = await sendChatMessage(chatChannelId, chatMsg, newTok);
      }
      chatResult = (chatRes2.status === 200 || chatRes2.status === 204) ? 'sent' : 'failed';
    } catch(e) { chatResult = 'error'; }

    console.log('[network/contract] ' + target + ' | ' + reward + ' | chat: ' + chatResult);
    res.json({ success: true, id, chat: chatResult });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/network/contract/:id/claim ──────────────────
app.post('/api/network/contract/:id/claim', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  const { claimed_by, broadcaster_id } = req.body || {};
  try {
    const r = await pool.query(
      'UPDATE network_contracts SET claimed=true,claimed_by=$1,claimed_at=NOW() WHERE id=$2 AND claimed=false RETURNING *',
      [claimed_by || 'unknown', req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or already claimed' });
    const contract = r.rows[0];
    const chatChannelId = broadcaster_id || broadcasterUserId || contract.channel_id;
    const msg = '☠ HEAD-HUNTER — BOUNTY COMPLETED! The bounty on @' + contract.target
      + ' has been claimed by @' + (claimed_by || 'a hunter') + '! Prize: ' + contract.reward + ' — To the victor goes the spoils!';
    try {
      let cr = await sendChatMessage(chatChannelId, msg, botToken);
      if (cr.status === 401) { const nt = await refreshBotToken(); await sendChatMessage(chatChannelId, msg, nt); }
    } catch(e) {}
    res.json({ success: true, contract });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/network/contract/:id ──────────────────────
app.delete('/api/network/contract/:id', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  try {
    await pool.query('DELETE FROM network_contracts WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/network/submissions ──────────────────────────
app.get('/api/network/submissions', async (req, res) => {
  if (!dbReady) return res.json({ submissions: [], ts: new Date().toISOString() });
  const { channel_id } = req.query;
  try {
    const params = channel_id ? [channel_id] : [];
    const where  = channel_id ? "status='review' AND channel_id=$1" : "status='review'";
    const r = await pool.query('SELECT * FROM network_submissions WHERE ' + where + ' ORDER BY submitted_at DESC', params);
    res.json({ submissions: r.rows, ts: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/network/submission ──────────────────────────
app.post('/api/network/submission', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  const { contract_id, channel_id, target, game, total_reward, clip_url, platform, submitted_by } = req.body || {};
  if (!contract_id || !clip_url || !target) return res.status(400).json({ error: 'contract_id, clip_url, target required' });
  const id = uid();
  const voteClosesAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
  try {
    await pool.query(`
      INSERT INTO network_submissions (id,contract_id,channel_id,target,game,total_reward,clip_url,platform,submitted_by,submitted_by_login,vote_closes_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [id, contract_id, channel_id || '', target, game || '', total_reward || '', clip_url, platform || 'TWITCH', submitted_by || null, req.body.submitted_by_login || null, voteClosesAt]);
    res.json({ success: true, id, vote_closes_at: voteClosesAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/network/vote ─────────────────────────────────
app.post('/api/network/vote', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  const { submission_id, voter_id, vote } = req.body || {};
  if (!submission_id || !voter_id || !['approve','reject'].includes(vote))
    return res.status(400).json({ error: 'submission_id, voter_id, vote required' });
  try {
    await pool.query(
      'INSERT INTO network_votes(submission_id,voter_id,vote) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [submission_id, voter_id, vote]
    );
    const counts = await pool.query(
      "SELECT COUNT(*) FILTER(WHERE vote='approve') AS approves, COUNT(*) FILTER(WHERE vote='reject') AS rejects FROM network_votes WHERE submission_id=$1",
      [submission_id]
    );
    const { approves, rejects } = counts.rows[0];
    await pool.query('UPDATE network_submissions SET approves=$1,rejects=$2 WHERE id=$3',
      [parseInt(approves), parseInt(rejects), submission_id]);
    res.json({ success: true, approves: parseInt(approves), rejects: parseInt(rejects) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/network/submission/:id/approve ──────────────
app.post('/api/network/submission/:id/approve', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  const { broadcaster_id, hunter_name } = req.body || {};
  try {
    const r = await pool.query(
      "UPDATE network_submissions SET status='claimed',claimed_at=NOW() WHERE id=$1 AND status='review' RETURNING *",
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const s = r.rows[0];
    await pool.query('UPDATE network_contracts SET claimed=true,claimed_by=$1,claimed_at=NOW() WHERE id=$2',
      [hunter_name || 'unknown', s.contract_id]);
    const chatChannelId = broadcaster_id || broadcasterUserId || s.channel_id;
    try {
      const payMsg = '☠ HEAD-HUNTER — BOUNTY COMPLETED! The bounty on @' + s.target + ' has been claimed! Prize: ' + s.total_reward + ' — To the victor goes the spoils!';
      let pr = await sendChatMessage(chatChannelId, payMsg, botToken);
      if (pr.status === 401) { const nt = await refreshBotToken(); await sendChatMessage(chatChannelId, payMsg, nt); }
    } catch(e) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/network/submission/:id/reject ───────────────
app.post('/api/network/submission/:id/reject', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  try {
    await pool.query("UPDATE network_submissions SET status='rejected' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── POST /api/network/leaderboard/clear ───────────────────
// Resets all claimed data so leaderboard starts fresh
// Protected by ADMIN_SECRET env var
app.post('/api/network/leaderboard/clear', async (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'headhunter-admin';
  if (req.body.secret !== secret) return res.status(403).json({ error: 'Forbidden' });
  if (!dbReady) return res.status(503).json({ error: 'Network not available' });
  try {
    // Reset claimed fields on all contracts — leaderboard pulls from claimed_by
    await pool.query('UPDATE network_contracts SET claimed=false, claimed_by=NULL, claimed_at=NULL');
    // Delete all submissions so vote history is clean too
    await pool.query('DELETE FROM network_submissions');
    await pool.query('DELETE FROM network_votes');
    console.log('[admin] Leaderboard and submissions cleared');
    res.json({ success: true, message: 'Leaderboard cleared — fresh start!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/network/leaderboard ──────────────────────────
app.get('/api/network/leaderboard', async (req, res) => {
  if (!dbReady) return res.json({ leaderboard: [] });
  try {
    const r = await pool.query(`
      SELECT claimed_by AS hunter, COUNT(*) AS kills, SUM(bits_amount) AS total_bits
      FROM network_contracts WHERE claimed=true AND claimed_by IS NOT NULL
      GROUP BY claimed_by ORDER BY kills DESC, total_bits DESC LIMIT 20
    `);
    res.json({ leaderboard: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/network/poll ─────────────────────────────────
// Lightweight check — tells client if anything changed since last poll
app.get('/api/network/poll', async (req, res) => {
  if (!dbReady) return res.json({ active_contracts: 0, new_contracts: 0, pending_submissions: 0, ts: new Date().toISOString() });
  const since = req.query.since || new Date(0).toISOString();
  try {
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM network_contracts WHERE claimed=false AND (expires_at IS NULL OR expires_at>NOW())) AS active_contracts,
        (SELECT COUNT(*) FROM network_contracts WHERE posted_at>$1) AS new_contracts,
        (SELECT COUNT(*) FROM network_submissions WHERE status='review') AS pending_submissions
    `, [since]);
    res.json({ ...r.rows[0], ts: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START ────────────────────────────────────────────────
initDb().catch(err => console.error('[db] Init failed (non-fatal):', err.message));

app.listen(PORT, () => {
  console.log('HEAD-HUNTER EBS running on port ' + PORT);
  console.log('Client ID:',       process.env.TWITCH_CLIENT_ID     ? '✓ set' : '✗ MISSING');
  console.log('Client Secret:',   process.env.TWITCH_CLIENT_SECRET ? '✓ set' : '✗ MISSING');
  console.log('Bot User ID:',     botUserId         ? '✓ set' : '✗ not set (chat disabled)');
  console.log('Bot Token:',       botToken          ? '✓ set' : '✗ not set (chat disabled)');
  console.log('Broadcaster ID:',  broadcasterUserId ? '✓ set (' + broadcasterUserId + ')' : 'not set (per-channel fallback)');
  console.log('Network DB:',      process.env.DATABASE_URL ? '✓ connecting...' : '✗ not set (local mode only)');
  console.log('SE Channel ID:',   SE_CHANNEL ? '✓ set' : '✗ not set (SE disabled)');
  console.log('SE JWT:',          SE_JWT     ? '✓ set' : '✗ not set (SE disabled)');
});

