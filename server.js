// ═══════════════════════════════════════════════════════════
//  HEAD-HUNTER — Extension Backend Service (EBS)
//  Handles: live status lookup, chat notifications
//  Deploy to Railway: railway up
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

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

// ─── TOKEN CACHE ──────────────────────────────────────────
var appToken       = null;
var appTokenExpiry = 0;

// Bot user token — needs scope: user:write:chat
var botToken        = process.env.BOT_ACCESS_TOKEN  || null;
var botRefreshToken = process.env.BOT_REFRESH_TOKEN || null;
var botUserId       = process.env.BOT_USER_ID        || null;

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
  return fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
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
  if (!username) return res.status(400).json({ error: 'username required' });

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
  const { target, game, platform, reward, expiry, conditions } = req.body || {};
  if (!target || !game || !reward) {
    return res.status(400).json({ error: 'target, game, and reward are required' });
  }

  // Build the chat message — keep it punchy for chat
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
    } else {
      // Resolve target's user ID (needed as broadcaster_id for their channel)
      const targetUser = await getUserId(target);
      if (!targetUser) {
        chatResult = 'user_not_found';
      } else {
        // Send chat message to target's channel
        let chatRes = await sendChatMessage(targetUser.id, chatMsg, botToken);

        // Auto-refresh token if expired
        if (chatRes.status === 401) {
          console.log('[chat] 401 — refreshing bot token...');
          const newToken = await refreshBotToken();
          chatRes = await sendChatMessage(targetUser.id, chatMsg, newToken);
        }

        if (chatRes.status === 200 || chatRes.status === 204) {
          chatResult = 'sent';
          console.log('[chat] Message sent to ' + target + '\'s channel');
        } else {
          const errBody = await chatRes.text();
          console.error('[chat] Failed:', chatRes.status, errBody);
          chatResult = 'failed';
        }
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
// Sends a chat message to the target's channel when bounty is paid out
app.post('/api/payout', async (req, res) => {
  const { target, reward, count } = req.body || {};
  if (!target || !reward) return res.status(400).json({ error: 'target and reward required' });

  const bountyWord = count && count > 1 ? count + ' bounties' : 'bounty';
  const chatMsg = '☠ HEAD-HUNTER — BOUNTY COMPLETED! '
    + 'The ' + bountyWord + ' on @' + target + ' has been claimed and paid out! '
    + 'Total reward: ' + reward + ' — To the victor goes the spoils - BOUNTY COMPLETED!';

  var chatResult = 'not_sent';

  try {
    if (!botToken || !botUserId) {
      chatResult = 'bot_not_configured';
    } else {
      const targetUser = await getUserId(target);
      if (!targetUser) {
        chatResult = 'user_not_found';
      } else {
        let chatRes = await sendChatMessage(targetUser.id, chatMsg, botToken);
        if (chatRes.status === 401) {
          const newToken = await refreshBotToken();
          chatRes = await sendChatMessage(targetUser.id, chatMsg, newToken);
        }
        chatResult = (chatRes.status === 200 || chatRes.status === 204) ? 'sent' : 'failed';
        console.log('[payout] Chat sent to ' + target + ':', chatResult);
      }
    }
  } catch (err) {
    console.error('[payout] Error:', err.message);
    chatResult = 'error';
  }

  res.json({ success: true, target, chat: chatResult });
});

// ─── START ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('HEAD-HUNTER EBS running on port ' + PORT);
  console.log('Client ID:',      process.env.TWITCH_CLIENT_ID     ? '✓ set' : '✗ MISSING');
  console.log('Client Secret:',  process.env.TWITCH_CLIENT_SECRET ? '✓ set' : '✗ MISSING');
  console.log('Bot User ID:',    botUserId  ? '✓ set' : '✗ not set (chat disabled)');
  console.log('Bot Token:',      botToken   ? '✓ set' : '✗ not set (chat disabled)');
});

