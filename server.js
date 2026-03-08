// ═══════════════════════════════════════════════════════════
//  HEAD-HUNTER EBS v2.0
//  Security-hardened Extension Backend Service
//  Deploy to Render — attach a free PostgreSQL database
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const { Pool }   = require('pg');

// ── STARTUP GUARD ────────────────────────────────────────
if (!process.env.EXTENSION_SECRET) {
  console.error('[FATAL] EXTENSION_SECRET is not set. Exiting.');
  process.exit(1);
}
if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
  console.error('[FATAL] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set. Exiting.');
  process.exit(1);
}

const app  = express();
app.set('trust proxy', 1); // Required for Render's proxy
const PORT = process.env.PORT || 3000;

const EXTENSION_SECRET   = Buffer.from(process.env.EXTENSION_SECRET, 'base64');
const broadcasterUserId  = process.env.BROADCASTER_USER_ID || null;
var   botToken           = process.env.BOT_ACCESS_TOKEN    || null;
var   botRefreshToken    = process.env.BOT_REFRESH_TOKEN   || null;
const botUserId          = process.env.BOT_USER_ID         || null;

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(express.json());
var corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (/\.twitch\.tv$/.test(origin) || /\.ext-twitch\.tv$/.test(origin) || /^https?:\/\/localhost/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: origin not allowed: ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight for all routes

// Rate limiting — 30/min general, 10/min writes
const generalLimiter = rateLimit({ windowMs: 60000, max: 30,  standardHeaders: true, legacyHeaders: false });
const writeLimiter   = rateLimit({ windowMs: 60000, max: 10,  standardHeaders: true, legacyHeaders: false });
app.use(generalLimiter);

// ── POSTGRES ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contracts (
        id            TEXT PRIMARY KEY,
        channel_id    TEXT NOT NULL,
        target        TEXT NOT NULL,
        game          TEXT NOT NULL,
        platform      TEXT DEFAULT 'PC',
        reward        TEXT NOT NULL,
        bits_amount   INTEGER DEFAULT 0,
        conditions    TEXT DEFAULT '',
        expiry_label  TEXT DEFAULT '2 hours',
        expires_at    TIMESTAMPTZ,
        posted_at     TIMESTAMPTZ DEFAULT NOW(),
        posted_by     TEXT,
        status        TEXT DEFAULT 'active',
        avatar        TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id             TEXT PRIMARY KEY,
        contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        channel_id     TEXT NOT NULL,
        clip_url       TEXT NOT NULL,
        notes          TEXT DEFAULT '',
        submitted_by   TEXT NOT NULL,
        submitted_at   TIMESTAMPTZ DEFAULT NOW(),
        status         TEXT DEFAULT 'review',
        approves       INTEGER DEFAULT 0,
        rejects        INTEGER DEFAULT 0,
        vote_closes_at TIMESTAMPTZ,
        transaction_id TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS votes (
        submission_id TEXT NOT NULL,
        voter_id      TEXT NOT NULL,
        vote          TEXT NOT NULL,
        voted_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (submission_id, voter_id)
      );
      CREATE INDEX IF NOT EXISTS idx_contracts_channel ON contracts(channel_id);
      CREATE INDEX IF NOT EXISTS idx_contracts_status  ON contracts(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_submissions_contract ON submissions(contract_id);
      CREATE INDEX IF NOT EXISTS idx_submissions_status   ON submissions(status);
    `);
    // Migrations — safe to run on every startup
    await pool.query("ALTER TABLE contracts ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT ''");
    console.log('[db] Tables ready');
  } finally {
    client.release();
  }
}

// ── JWT MIDDLEWARE ───────────────────────────────────────
function verifyExtensionJwt(req, res, next) {
  var auth = req.headers['authorization'] || '';
  var token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing JWT' });
  try {
    var payload = jwt.verify(token, EXTENSION_SECRET, { algorithms: ['HS256'] });
    req.jwtPayload = payload;
    // channel_id always comes from JWT — never trust req.body for this
    req.channelId = String(payload.channel_id || '');
    req.userId    = String(payload.user_id    || '');
    req.role      = payload.role || 'viewer';
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid JWT: ' + e.message });
  }
}

function requireBroadcaster(req, res, next) {
  if (req.role !== 'broadcaster') {
    return res.status(403).json({ error: 'Broadcaster only' });
  }
  next();
}

// ── TOKEN CACHE ──────────────────────────────────────────
var appToken       = null;
var appTokenExpiry = 0;

async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiry) return appToken;
  var res  = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type:    'client_credentials'
    })
  });
  var data = await res.json();
  if (!data.access_token) throw new Error('App token failed: ' + JSON.stringify(data));
  appToken       = data.access_token;
  appTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return appToken;
}

async function refreshBotToken() {
  if (!botRefreshToken) throw new Error('No bot refresh token');
  var res  = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: botRefreshToken
    })
  });
  var data = await res.json();
  if (!data.access_token) throw new Error('Bot token refresh failed');
  botToken        = data.access_token;
  botRefreshToken = data.refresh_token || botRefreshToken;
  console.log('[bot] Token refreshed');
  return botToken;
}

// ── TWITCH LOOKUP ────────────────────────────────────────
async function getUserByLogin(login) {
  var token = await getAppToken();
  var res   = await fetch('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(login), {
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
  });
  var data = await res.json();
  return (data.data && data.data[0]) || null;
}

async function getUserById(id) {
  var token = await getAppToken();
  var res   = await fetch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(id), {
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
  });
  var data = await res.json();
  return (data.data && data.data[0]) || null;
}

async function isStreamLive(userId) {
  var token = await getAppToken();
  var res   = await fetch('https://api.twitch.tv/helix/streams?user_id=' + encodeURIComponent(userId), {
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': process.env.TWITCH_CLIENT_ID }
  });
  var data = await res.json();
  return !!(data.data && data.data[0]);
}

// ── CHAT NOTIFICATION ────────────────────────────────────
async function sendChatMessage(channelId, message, token) {
  if (!botUserId || !token) return { status: 0 };
  return fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id':     process.env.TWITCH_CLIENT_ID,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      broadcaster_id: channelId,
      sender_id:      botUserId,
      message:        message
    })
  });
}

async function trySendChat(channelId, message) {
  if (!botUserId || !botToken) return 'no-bot';
  try {
    var res = await sendChatMessage(channelId, message, botToken);
    if (res.status === 401) {
      var newToken = await refreshBotToken();
      res = await sendChatMessage(channelId, message, newToken);
    }
    return (res.status === 200 || res.status === 204) ? 'sent' : 'failed-' + res.status;
  } catch (e) {
    return 'error';
  }
}

// ── PUBSUB BROADCAST ─────────────────────────────────────
async function pubsubBroadcast(channelId, payload) {
  try {
    var token = jwt.sign(
      { exp: Math.floor(Date.now() / 1000) + 60, channel_id: channelId, role: 'external' },
      EXTENSION_SECRET
    );
    await fetch('https://api.twitch.tv/helix/extensions/pubsub', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Client-Id':     process.env.TWITCH_CLIENT_ID,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        target:     ['broadcast'],
        broadcaster_id: channelId,
        is_global_broadcast: false,
        message:    JSON.stringify(payload)
      })
    });
  } catch (e) {
    console.error('[pubsub] Error:', e.message);
  }
}

// ── EXPIRY CRON ──────────────────────────────────────────
function startCrons() {
  // Every 5 min: mark expired contracts
  setInterval(async function() {
    try {
      var r = await pool.query(
        "UPDATE contracts SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < NOW()"
      );
      if (r.rowCount > 0) console.log('[cron] Expired ' + r.rowCount + ' contracts');
    } catch (e) { console.error('[cron] Expiry error:', e.message); }
  }, 5 * 60 * 1000);

  // Every 2h: reset stale 'hunting' claims (hunter went offline without submitting)
  setInterval(async function() {
    try {
      var r = await pool.query(
        "UPDATE contracts SET status='active' WHERE status='hunting' AND posted_at < NOW() - INTERVAL '2 hours'"
      );
      if (r.rowCount > 0) console.log('[cron] Reset ' + r.rowCount + ' stale hunts');
    } catch (e) { console.error('[cron] Stale hunt reset error:', e.message); }
  }, 2 * 60 * 60 * 1000);

  // Every 5 min: close expired vote windows
  setInterval(async function() {
    try {
      // Find expired submissions still in review
      var expired = await pool.query(
        "SELECT id, approves, rejects FROM submissions WHERE status='review' AND vote_closes_at IS NOT NULL AND vote_closes_at < NOW()"
      );
      for (var row of expired.rows) {
        var total    = (row.approves||0) + (row.rejects||0);
        var legitPct = total > 0 ? (row.approves||0) / total : 0;
        // If 60%+ legit — auto-approve, otherwise fail
        var newStatus = (legitPct >= 0.6) ? 'approved' : 'failed';
        await pool.query('UPDATE submissions SET status=$1 WHERE id=$2', [newStatus, row.id]);
      }
      if (expired.rowCount > 0) console.log('[cron] Closed ' + expired.rowCount + ' vote windows');
    } catch (e) { console.error('[cron] Vote close error:', e.message); }
  }, 5 * 60 * 1000);
}

// ── HELPERS ──────────────────────────────────────────────
function uid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

function parseExpiry(label) {
  if (!label || label === 'No expiry') return null;
  var m = String(label).match(/^(\d+)\s*(min|hour|h|m)/i);
  if (!m) return null;
  var n   = parseInt(m[1]);
  var unit = m[2].toLowerCase();
  var ms = (unit === 'min' || unit === 'm') ? n * 60000 : n * 3600000;
  return new Date(Date.now() + ms);
}

// ═════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════

// ── HEALTH ───────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({ ok: true, version: '2.0.0' });
});

// ── USER LOOKUP ──────────────────────────────────────────
app.get('/api/lookup', async function(req, res) {
  try {
    var user = null;
    if (req.query.login) user = await getUserByLogin(req.query.login);
    else if (req.query.id) user = await getUserById(req.query.id);
    if (!user) return res.json({ found: false });
    var live = await isStreamLive(user.id);
    res.json({
      found:        true,
      id:           user.id,
      login:        user.login,
      display_name: user.display_name,
      avatar:       user.profile_image_url,
      live:         live
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET CONTRACTS ─────────────────────────────────────────
app.get('/api/contracts', verifyExtensionJwt, async function(req, res) {
  try {
    var channelId = req.channelId;
    var r = await pool.query(
      "SELECT * FROM contracts WHERE channel_id=$1 AND status IN ('active','hunting') ORDER BY posted_at DESC LIMIT 20",
      [channelId]
    );
    res.json({ contracts: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET GLOBAL CONTRACTS (all channels) ──────────────────
app.get('/api/contracts/global', verifyExtensionJwt, async function(req, res) {
  try {
    var r = await pool.query(
      "SELECT * FROM contracts WHERE status IN ('active','hunting') ORDER BY posted_at DESC LIMIT 50"
    );
    res.json({ contracts: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST CONTRACT ─────────────────────────────────────────
app.post('/api/contracts', writeLimiter, verifyExtensionJwt, async function(req, res) {
  var channelId = req.channelId; // always from JWT
  var b         = req.body;
  if (!b.target || !b.game) return res.status(400).json({ error: 'target and game required' });

  try {
    var id        = uid();
    var expiresAt = parseExpiry(b.expiry_label);
    // Look up target avatar
    var avatarUrl = '';
    try { var tu = await getUserByLogin(b.target); if (tu) avatarUrl = tu.profile_image_url || ''; } catch(e) {}
    await pool.query(
      `INSERT INTO contracts (id,channel_id,target,game,platform,reward,bits_amount,conditions,expiry_label,expires_at,posted_by,avatar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, channelId, b.target, b.game, b.platform||'PC', b.reward||'Bits',
       parseInt(b.bits_amount)||0, b.conditions||'', b.expiry_label||'2 hours',
       expiresAt, req.userId, avatarUrl]
    );

    var contract = (await pool.query('SELECT * FROM contracts WHERE id=$1', [id])).rows[0];

    // Notify broadcaster's channel chat
    var chatStatus = await trySendChat(
      broadcasterUserId || channelId,
      '☠ HEAD-HUNTER BOUNTY ALERT ☠ A bounty of ' + (b.bits_amount||'?') + ' Bits has been placed on @' + b.target + '! Game: ' + b.game + ' · Hunters, open HEAD-HUNTER to claim the contract!'
    );

    // PubSub broadcast to all viewers
    await pubsubBroadcast(channelId, { type: 'contract_posted', contract: contract });

    res.json({ success: true, contract: contract, chatStatus: chatStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE CONTRACT (broadcaster only) ───────────────────
// ── CLAIM CONTRACT ────────────────────────────────────────
app.post('/api/contracts/:id/claim', writeLimiter, verifyExtensionJwt, async function(req, res) {
  var channelId = req.channelId;
  try {
    var r = await pool.query(
      "UPDATE contracts SET status='hunting', posted_by=$1 WHERE id=$2 AND channel_id=$3 AND status='active' RETURNING *",
      [req.userId, req.params.id, channelId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Contract not found or already claimed' });
    res.json({ success: true, contract: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SUBMIT CLIP ───────────────────────────────────────────
app.post('/api/submissions', writeLimiter, verifyExtensionJwt, async function(req, res) {
  var channelId    = req.channelId;
  var b            = req.body;
  if (!b.contract_id || !b.clip_url) return res.status(400).json({ error: 'contract_id and clip_url required' });

  // Idempotency — block duplicate transaction IDs
  if (b.transaction_id) {
    var dupe = await pool.query('SELECT id FROM submissions WHERE transaction_id=$1', [b.transaction_id]);
    if (dupe.rows.length > 0) return res.status(409).json({ error: 'Duplicate transaction', existing: dupe.rows[0].id });
  }

  try {
    var contract = await pool.query('SELECT * FROM contracts WHERE id=$1 AND channel_id=$2', [b.contract_id, channelId]);
    if (contract.rows.length === 0) return res.status(404).json({ error: 'Contract not found' });

    var id          = uid();
    var voteCloses  = new Date(Date.now() + 8 * 3600 * 1000); // 8-hour vote window
    await pool.query(
      `INSERT INTO submissions (id,contract_id,channel_id,clip_url,notes,submitted_by,vote_closes_at,transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, b.contract_id, channelId, b.clip_url, b.notes||'', req.userId, voteCloses, b.transaction_id||null]
    );

    var sub = (await pool.query('SELECT * FROM submissions WHERE id=$1', [id])).rows[0];
    await pubsubBroadcast(channelId, { type: 'submission_posted', submission: sub });
    res.json({ success: true, submission: sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET SUBMISSIONS ───────────────────────────────────────
app.get('/api/submissions', verifyExtensionJwt, async function(req, res) {
  var channelId = req.channelId;
  try {
    var r = await pool.query(
      "SELECT * FROM submissions WHERE channel_id=$1 ORDER BY submitted_at DESC LIMIT 30",
      [channelId]
    );
    res.json({ submissions: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET GLOBAL SUBMISSIONS ───────────────────────────────
app.get('/api/submissions/global', verifyExtensionJwt, async function(req, res) {
  try {
    var r = await pool.query(
      "SELECT s.*, c.target, c.game, c.bits_amount FROM submissions s JOIN contracts c ON c.id=s.contract_id WHERE s.status='review' ORDER BY s.submitted_at DESC LIMIT 50"
    );
    res.json({ submissions: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VOTE ──────────────────────────────────────────────────
app.post('/api/submissions/:id/vote', writeLimiter, verifyExtensionJwt, async function(req, res) {
  var channelId = req.channelId;
  var voterId   = req.userId;
  var vote      = req.body.vote; // 'approve' or 'reject'
  if (!vote || !['approve', 'reject'].includes(vote)) return res.status(400).json({ error: 'vote must be approve or reject' });

  try {
    var sub = await pool.query('SELECT * FROM submissions WHERE id=$1', [req.params.id]);
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Submission not found' });
    if (sub.rows[0].status !== 'review') return res.status(400).json({ error: 'Voting closed' });

    // Deduplication via PRIMARY KEY constraint
    try {
      await pool.query(
        'INSERT INTO votes (submission_id,voter_id,vote) VALUES ($1,$2,$3)',
        [req.params.id, voterId, vote]
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Already voted' });
      throw e;
    }

    // Recalculate tallies
    var tally = await pool.query(
      "SELECT vote, COUNT(*)::int AS n FROM votes WHERE submission_id=$1 GROUP BY vote",
      [req.params.id]
    );
    var approves = 0, rejects = 0;
    tally.rows.forEach(function(r) {
      if (r.vote === 'approve') approves = r.n;
      else rejects = r.n;
    });

    await pool.query('UPDATE submissions SET approves=$1, rejects=$2 WHERE id=$3', [approves, rejects, req.params.id]);

    // Auto-approve if threshold met (60%+, minimum 5 votes)
    var total = approves + rejects;
    if (total >= 5 && (approves / total) >= 0.6) {
      await pool.query("UPDATE submissions SET status='approved' WHERE id=$1", [req.params.id]);
      await pubsubBroadcast(channelId, { type: 'submission_approved', submissionId: req.params.id });
    }

    res.json({ success: true, approves: approves, rejects: rejects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PAYOUT (broadcaster approves) ─────────────────────────
app.post('/api/submissions/:id/payout', writeLimiter, verifyExtensionJwt, requireBroadcaster, async function(req, res) {
  var channelId = req.channelId;
  try {
    var sub = await pool.query(
      "SELECT s.*, c.target, c.game, c.bits_amount FROM submissions s JOIN contracts c ON c.id=s.contract_id WHERE s.id=$1 AND s.channel_id=$2",
      [req.params.id, channelId]
    );
    if (sub.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    var s = sub.rows[0];

    // Mark paid
    await pool.query("UPDATE submissions SET status='paid' WHERE id=$1", [req.params.id]);
    await pool.query("UPDATE contracts SET status='completed' WHERE id=$1", [s.contract_id]);

    var reward = s.bits_amount ? s.bits_amount + ' Bits' : 'reward';
    var chatStatus = await trySendChat(
      broadcasterUserId || channelId,
      '☠ HEAD-HUNTER — BOUNTY COMPLETED! The bounty on @' + s.target + ' has been claimed and paid out! Prize: ' + reward + ' — To the victor goes the spoils! BOUNTY COMPLETED!'
    );

    await pubsubBroadcast(channelId, {
      type: 'kill_confirmed',
      target: s.target,
      game:   s.game,
      reward: reward,
      hunter: s.submitted_by
    });

    res.json({ success: true, chatStatus: chatStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── REJECT SUBMISSION (broadcaster only) ──────────────────
app.post('/api/submissions/:id/reject', writeLimiter, verifyExtensionJwt, requireBroadcaster, async function(req, res) {
  var channelId = req.channelId;
  try {
    var r = await pool.query(
      "UPDATE submissions SET status='rejected' WHERE id=$1 AND channel_id=$2 RETURNING id",
      [req.params.id, channelId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found or not yours' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HUNTER PROFILE ────────────────────────────────────────
app.get('/api/hunter/:userId', async function(req, res) {
  try {
    var r = await pool.query(
      `SELECT
         COUNT(CASE WHEN status='paid' THEN 1 END)::int               AS kills,
         COALESCE(SUM(CASE WHEN s.status='paid' THEN c.bits_amount ELSE 0 END),0)::int AS bits_earned,
         COUNT(*)::int                                                  AS total_submissions,
         COUNT(CASE WHEN status IN ('approved','paid') THEN 1 END)::int AS wins
       FROM submissions s
       JOIN contracts c ON c.id = s.contract_id
       WHERE s.submitted_by = $1`,
      [req.params.userId]
    );
    var row = r.rows[0];
    var win_rate = row.total_submissions > 0 ? Math.round((row.wins / row.total_submissions) * 100) : 0;
    res.json({ userId: req.params.userId, kills: row.kills, bits_earned: row.bits_earned, total_submissions: row.total_submissions, win_rate: win_rate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LEADERBOARD ───────────────────────────────────────────
app.get('/api/leaderboard', verifyExtensionJwt, async function(req, res) {
  try {
    var r = await pool.query(
      `SELECT s.submitted_by AS user_id,
              COUNT(CASE WHEN s.status IN ('paid','approved') THEN 1 END)::int AS kills,
              COALESCE(SUM(CASE WHEN s.status IN ('paid','approved') THEN c.bits_amount ELSE 0 END),0)::int AS bits_earned,
              COUNT(*)::int AS total_submissions
       FROM submissions s
       JOIN contracts c ON c.id = s.contract_id
       WHERE s.channel_id = $1
       GROUP BY s.submitted_by
       ORDER BY bits_earned DESC, kills DESC
       LIMIT 10`,
      [req.channelId]
    );
    // Enrich with display names from Twitch
    var rows = r.rows;
    var ids  = rows.map(function(row) { return row.user_id; }).filter(Boolean);
    var nameMap = {};
    try {
      if (ids.length > 0) {
        var url = 'https://api.twitch.tv/helix/users?' + ids.map(function(id) { return 'id=' + id; }).join('&');
        var resp = await fetch(url, {
          headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': 'Bearer ' + await getAppToken() }
        });
        var data = await resp.json();
        (data.data || []).forEach(function(u) { nameMap[u.id] = { display_name: u.display_name, login: u.login, avatar: u.profile_image_url }; });
      }
    } catch(e) { /* name lookup failed — fall back to user_id */ }

    var enriched = rows.map(function(row) {
      var info = nameMap[row.user_id] || {};
      return Object.assign({}, row, {
        display_name: info.display_name || row.user_id,
        login:        info.login        || row.user_id,
        avatar:       info.avatar       || ''
      });
    });

    res.json({ leaderboard: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET GLOBAL LEADERBOARD ───────────────────────────────
app.get('/api/leaderboard/global', verifyExtensionJwt, async function(req, res) {
  try {
    var r = await pool.query(
      `SELECT s.submitted_by AS user_id,
              COUNT(CASE WHEN s.status IN ('paid','approved') THEN 1 END)::int AS kills,
              COALESCE(SUM(CASE WHEN s.status IN ('paid','approved') THEN c.bits_amount ELSE 0 END),0)::int AS bits_earned,
              COUNT(*)::int AS total_submissions
       FROM submissions s
       JOIN contracts c ON c.id = s.contract_id
       GROUP BY s.submitted_by
       HAVING COUNT(*) > 0
       ORDER BY bits_earned DESC, kills DESC
       LIMIT 20`
    );
    var rows = r.rows;
    var ids  = rows.map(function(row) { return row.user_id; }).filter(function(id) {
      // Only numeric IDs work with Helix — skip opaque IDs (start with U or A)
      return id && /^\d+$/.test(id);
    });
    console.log('[leaderboard] user_ids from DB:', rows.map(function(r){return r.user_id;}));
    console.log('[leaderboard] numeric IDs to look up:', ids);
    var nameMap = {};
    try {
      if (ids.length > 0) {
        var token = await getAppToken();
        var url = 'https://api.twitch.tv/helix/users?' + ids.map(function(id) { return 'id=' + id; }).join('&');
        var resp = await fetch(url, { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': 'Bearer ' + token } });
        var data = await resp.json();
        console.log('[leaderboard] Helix response:', JSON.stringify(data).slice(0, 200));
        (data.data || []).forEach(function(u) { nameMap[u.id] = { display_name: u.display_name, login: u.login, avatar: u.profile_image_url }; });
      }
    } catch(e) { console.error('[leaderboard] Name lookup failed:', e.message); }
    var enriched = rows.map(function(row) {
      var info = nameMap[row.user_id] || {};
      return Object.assign({}, row, {
        display_name: info.display_name || row.user_id,
        login:        info.login        || row.user_id,
        avatar:       info.avatar       || ''
      });
    });
    console.log('[leaderboard] Returning', enriched.length, 'rows, nameMap keys:', Object.keys(nameMap).length);
    res.json({ leaderboard: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN RESET ──────────────────────────────────────────
app.get('/api/admin/reset/hh-reset-2026', async function(req, res) {
  try {
    await pool.query('DELETE FROM votes');
    await pool.query('DELETE FROM submissions');
    await pool.query('DELETE FROM contracts');
    console.log('[admin] All data wiped');
    res.send('<h2>✅ All data cleared!</h2><p>Contracts, submissions and votes deleted.</p>');
  } catch(e) {
    res.status(500).send('<h2>❌ Error: ' + e.message + '</h2>');
  }
});

// ── DEBUG LEADERBOARD ─────────────────────────────────────
app.get('/api/debug/leaderboard', verifyExtensionJwt, async function(req, res) {
  try {
    var r = await pool.query('SELECT submitted_by, status FROM submissions LIMIT 20');
    res.json({ submissions: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════
//  START
// ═════════════════════════════════════════════════════════
initDb().then(function() {
  startCrons();
  app.listen(PORT, function() {
    console.log('[HEAD-HUNTER EBS v2.0] Listening on port ' + PORT);
    console.log('Client ID:         ', process.env.TWITCH_CLIENT_ID ? '✓ set' : '✗ MISSING');
    console.log('Extension Secret:  ', '✓ set');
    console.log('Bot User ID:       ', botUserId         ? '✓ ' + botUserId : '✗ not set');
    console.log('Bot Token:         ', botToken          ? '✓ set'          : '✗ not set');
    console.log('Broadcaster ID:    ', broadcasterUserId ? '✓ ' + broadcasterUserId : '✗ not set');
    console.log('Database:          ', process.env.DATABASE_URL ? '✓ connected' : '✗ MISSING');
  });
}).catch(function(err) {
  console.error('[FATAL] DB init failed:', err.message);
  process.exit(1);
});
