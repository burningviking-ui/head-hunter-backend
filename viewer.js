// ═══════════════════════════════════════════════════════
//  HEAD-HUNTER  —  viewer.js
// ═══════════════════════════════════════════════════════

// ── SET THIS AFTER YOU DEPLOY YOUR BACKEND ─────────────
// Paste your Railway URL here, no trailing slash
var EBS_URL = 'https://your-app.up.railway.app';
// ───────────────────────────────────────────────────────

var contracts   = [];
var submissions = [];  // { id, target, url, platform, status, approves, rejects, submittedAt, claimedAt }
var leaderboard = [];
var userVotes   = {};  // { submissionId: 'approve'|'reject' } — tracks what this viewer voted
var nextId      = 1;
var tabs, tabIds;
var channelKey  = 'hh_default';
var VOTE_WINDOW_MS  = 24 * 60 * 60 * 1000; // 24 hours
var APPROVE_THRESH  = 60;                   // 60% required after timer expires
var timerTick       = null;

// ─── TWITCH AUTH ───────────────────────────────────────
if (window.Twitch && window.Twitch.ext) {
  window.Twitch.ext.onAuthorized(function (auth) {
    var newKey = 'hh_' + (auth.channelId || 'default');
    if (newKey !== channelKey) {
      channelKey = newKey;
      loadState();
      renderAll();
    }
  });
}

// ─── PERSISTENCE ───────────────────────────────────────
function saveState() {
  try {
    localStorage.setItem(channelKey, JSON.stringify({
      contracts: contracts, submissions: submissions,
      leaderboard: leaderboard, nextId: nextId
    }));
    // userVotes saved separately so it survives channel key changes
    localStorage.setItem(channelKey + '_votes', JSON.stringify(userVotes));
  } catch(e) {}
}

function loadState() {
  try {
    var raw = localStorage.getItem(channelKey);
    if (!raw) return;
    var d = JSON.parse(raw);
    contracts   = d.contracts   || [];
    submissions = d.submissions || [];
    leaderboard = d.leaderboard || [];
    nextId      = d.nextId      || 1;
  } catch(e) {}
  try {
    var vraw = localStorage.getItem(channelKey + '_votes');
    userVotes = vraw ? JSON.parse(vraw) : {};
  } catch(e) { userVotes = {}; }
}

// ─── BOOT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  loadState();

  tabs   = document.querySelectorAll('.tab');
  tabIds = ['board','place','submit','vote','leaderboard'];
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { switchTab(i); });
  });

  var tn = document.getElementById('targetName');
  if (tn) tn.addEventListener('input', clearLookup);

  bind('lookupBtn', 'click', doLookup);

  document.querySelectorAll('.pay-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.pay-tab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.pay-panel').forEach(function (p) { p.classList.remove('active'); });
      tab.classList.add('active');
      var panel = el(tab.classList.contains('bits-tab') ? 'pay-bits' : 'pay-cash');
      if (panel) panel.classList.add('active');
    });
  });

  document.querySelectorAll('.bits-preset').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.bits-preset').forEach(function (b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      var amt = parseInt(btn.getAttribute('data-amount') || '0');
      var f = el('bitsAmount');
      if (f) { f.value = amt > 0 ? amt : ''; f.focus(); }
    });
  });

  var platCfg = {
    twitch:  { label: 'Twitch Clip URL',   ph: 'https://clips.twitch.tv/...',       hint: 'Clip must show kill feed with target username visible.' },
    youtube: { label: 'YouTube Video URL', ph: 'https://youtube.com/watch?v=...',    hint: 'Link directly to the video. Add a timestamp below.' },
    twitter: { label: 'X / Twitter URL',   ph: 'https://x.com/username/status/...', hint: 'Link to the tweet containing the video.' },
    other:   { label: 'Video URL',         ph: 'https://...',                        hint: 'Any direct link — Medal.tv, Streamable, Imgur, etc.' }
  };
  document.querySelectorAll('.plat-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.plat-tab').forEach(function (t) {
        t.classList.remove('active','twitch','youtube','twitter','other');
      });
      var plat = tab.getAttribute('data-plat');
      tab.classList.add('active', plat);
      var c = platCfg[plat];
      if (!c) return;
      setText('urlLabel', c.label);
      setAttr('clipUrl', 'placeholder', c.ph);
      setText('urlHint', c.hint);
      setVal('clipUrl', '');
    });
  });

  bind('postBtn',   'click', postContract);
  bind('submitBtn', 'click', submitKill);

  renderAll();

  // Tick timers every 30s
  timerTick = setInterval(function () { renderVote(); renderSubmissions(); }, 30000);
});

// ─── RENDER ALL ────────────────────────────────────────
function renderAll() {
  renderBoard();
  renderLeaderboard();
  syncDropdown();
  renderSubmissions();
  renderVote();
}

// ─── HELPERS ───────────────────────────────────────────
function bind(id, ev, fn) { var e = el(id); if (e) e.addEventListener(ev, fn); }
function el(id)            { return document.getElementById(id); }
function val(id)           { var e = el(id); return e ? e.value.trim() : ''; }
function setVal(id, v)     { var e = el(id); if (e) e.value = v; }
function setText(id, t)    { var e = el(id); if (e) e.textContent = t; }
function setAttr(id, a, v) { var e = el(id); if (e) e.setAttribute(a, v); }
function hide(id)          { var e = el(id); if (e) e.style.display = 'none'; }

function switchTab(i) {
  tabs.forEach(function (t) { t.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
  tabs[i].classList.add('active');
  el('panel-' + tabIds[i]).classList.add('active');
}

function showToast(msg) {
  var t = el('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () { t.classList.remove('show'); }, 2800);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Format countdown from ms remaining
function fmtCountdown(ms) {
  if (ms <= 0) return 'CLOSED';
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return h + 'h ' + m + 'm left';
  return m + 'm left';
}

// Vote state for a submission
function voteState(s) {
  var total    = (s.approves || 0) + (s.rejects || 0);
  var pct      = total > 0 ? Math.round((s.approves || 0) / total * 100) : 0;
  var elapsed  = Date.now() - (s.submittedAt || 0);
  var expired  = elapsed >= VOTE_WINDOW_MS;
  var passed   = pct >= APPROVE_THRESH && total > 0;
  // Claim ONLY unlocks after the full timer expires AND 60%+ approval
  var claimable = expired && passed && s.status === 'review';
  return { total: total, pct: pct, elapsed: elapsed, expired: expired, passed: passed, claimable: claimable };
}

// ─── LOOKUP ────────────────────────────────────────────
function doLookup() {
  var username = val('targetName');
  if (!username) { showToast('Enter a Twitch username first'); return; }
  clearLookup();

  // Show loading state immediately
  var prof = el('streamerProfile');
  setText('spAvatar', '⏳');
  setText('spName', username);
  var s = el('spStatus');
  if (s) { s.textContent = 'Looking up...'; s.className = 'sp-status'; }
  setText('spLink', 'twitch.tv/' + username);
  if (prof) prof.style.display = 'flex';

  // Hit backend for real live status
  if (EBS_URL && EBS_URL.indexOf('your-app') === -1) {
    fetch(EBS_URL + '/api/lookup?username=' + encodeURIComponent(username))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.found) {
          setText('spAvatar', '❓');
          if (s) { s.textContent = 'User not found on Twitch'; s.className = 'sp-status offline'; }
          return;
        }
        setText('spAvatar', data.is_live ? '🔴' : '🎮');
        setText('spName',   data.display_name || username);
        setText('spLink',   'twitch.tv/' + data.login);
        if (data.profile_image) {
          var av = el('spAvatar');
          if (av) {
            av.style.backgroundImage = 'url(' + data.profile_image + ')';
            av.style.backgroundSize  = 'cover';
            av.textContent           = '';
          }
        }
        if (s) {
          if (data.is_live) {
            s.textContent = '🔴 LIVE NOW — ' + Number(data.viewer_count).toLocaleString() + ' viewers'
              + (data.game ? ' · ' + data.game : '');
            s.className = 'sp-status live';
          } else {
            s.textContent = '⚫ OFFLINE';
            s.className   = 'sp-status offline';
          }
        }
        var badge = el('spExtBadge');
        if (badge) badge.style.display = 'inline-block';
      })
      .catch(function (err) {
        // Backend unreachable — fall back to manual check link
        setText('spAvatar', '🎮');
        if (s) {
          s.innerHTML = '⚠ Backend offline — <a href="https://twitch.tv/' + encodeURIComponent(username)
            + '" target="_blank" style="color:inherit;text-decoration:underline;">check live status manually ↗</a>';
          s.className = 'sp-status offline';
        }
        var badge = el('spExtBadge');
        if (badge) badge.style.display = 'inline-block';
      });
  } else {
    // EBS_URL not configured yet — show manual link
    setText('spAvatar', '🎮');
    if (s) {
      s.innerHTML = '<a href="https://twitch.tv/' + encodeURIComponent(username)
        + '" target="_blank" style="color:inherit;text-decoration:underline;letter-spacing:1px;">↗ Check live on Twitch</a>';
      s.className = 'sp-status';
    }
    var badge = el('spExtBadge');
    if (badge) badge.style.display = 'inline-block';
  }
}

function clearLookup() {
  hide('streamerProfile'); hide('lookupError');
  var badge = el('spExtBadge');
  if (badge) badge.style.display = 'none';
}

// ─── POST CONTRACT ─────────────────────────────────────
function postContract() {
  var target     = val('targetName');
  var game       = val('targetGame');
  var expiry     = val('expiryInput') || 'No expiry';
  var platform   = val('platformSelect') || 'PC';
  var conditions = val('hitConditions') || 'Eliminate target in a live match. Kill feed must be visible.';
  var prof = el('streamerProfile');

  if (!target) { showToast('Enter a Twitch username'); return; }
  if (!prof || prof.style.display === 'none') { showToast('Look up the streamer first'); return; }
  if (!game)   { showToast('Enter the game'); return; }

  var isCash = !!document.querySelector('.pay-tab.cash-tab.active');
  var reward = '';
  if (isCash) {
    var cashVal = val('cashAmount');
    if (!cashVal) { showToast('Enter a cash amount'); return; }
    reward = '$' + parseFloat(cashVal).toFixed(2);
  } else {
    var bitsVal = val('bitsAmount');
    if (!bitsVal) { showToast('Enter a Bits amount'); return; }
    reward = Number(bitsVal).toLocaleString() + ' Bits';
  }

  contracts.push({
    id: 'c' + (nextId++), target: target, game: game,
    platform: platform, expiry: expiry, conditions: conditions,
    reward: reward, isCash: isCash, postedAt: Date.now()
  });
  saveState();

  setVal('targetName',''); setVal('targetGame',''); setVal('expiryInput','');
  setVal('hitConditions',''); setVal('bitsAmount',''); setVal('cashAmount','');
  document.querySelectorAll('.bits-preset').forEach(function (b) { b.classList.remove('selected'); });
  clearLookup();

  renderBoard(); syncDropdown(); switchTab(0);
  showToast('☠ Contract posted on ' + target + ' — sending notification...');

  // Hit backend to post chat notification (non-blocking — contract already saved locally)
  if (EBS_URL && EBS_URL.indexOf('your-app') === -1) {
    fetch(EBS_URL + '/api/contract', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: target, game: game, platform: platform,
        reward: reward, expiry: expiry, conditions: conditions
      })
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.chat === 'sent') {
        showToast('🔔 Bounty alert posted in ' + target + '\'s chat!');
      } else if (data.chat === 'failed' || data.chat === 'error') {
        showToast('Contract live — could not post to chat');
      }
    })
    .catch(function () {
      // Silent fail — contract is already posted
    });
  }
}

// ─── BOARD ─────────────────────────────────────────────
function renderBoard() {
  var board = el('panel-board');
  board.querySelectorAll('.wanted-card,.empty-state').forEach(function (n) { n.remove(); });

  if (contracts.length === 0) {
    var emp = document.createElement('div');
    emp.className = 'empty-state';
    emp.innerHTML = '<div class="empty-icon">☠</div>'
      + '<div class="empty-text">No active contracts</div>'
      + '<div class="empty-sub">Be the first to place a bounty</div>';
    board.appendChild(emp);
    return;
  }

  contracts.forEach(function (c) {
    var card = document.createElement('div');
    card.className = 'wanted-card high';
    card.id = 'card-' + c.id;
    var chip = c.isCash
      ? '<div class="reward-chip cash">' + escHtml(c.reward) + '</div>'
      : '<div class="reward-chip bits">' + escHtml(c.reward) + '</div>';
    var timerTxt = c.expiry === 'No expiry' ? 'No expiry' : '⏱ ' + c.expiry;
    var survivalTxt = c.expiry === 'No expiry'
      ? '<div class="survival-payout no-expiry">No expiry — no survival payout</div>'
      : '<div class="survival-payout">🛡 If target survives — they receive 50% of the pot</div>';

    card.innerHTML =
      '<div class="card-top">'
      + '<div class="card-wanted-label">WANTED</div>'
      + '<div class="card-avatar">🎯</div>'
      + '<div class="card-info">'
      +   '<div class="card-gamertag">'
      +     '<a href="https://twitch.tv/' + encodeURIComponent(c.target) + '" target="_blank" style="color:inherit;text-decoration:none;">' + escHtml(c.target) + '</a>'
      +     ' <span class="streamer-offline">— <a href="https://twitch.tv/' + encodeURIComponent(c.target) + '" target="_blank" style="color:inherit;font-size:9px;">↗ Twitch</a></span>'
      +   '</div>'
      +   '<div class="card-game">🎮 ' + escHtml(c.game) + ' · ' + escHtml(c.platform) + '</div>'
      +   '<div class="card-reward-row">' + chip + '</div>'
      + '</div>'
      + '<div class="card-right">'
      +   '<div class="danger-level high">⚠ HIGH</div>'
      +   '<div class="card-timer">' + escHtml(timerTxt) + '</div>'
      + '</div>'
      + '</div>'
      + '<div class="card-expanded">'
      +   '<div class="placer-row">CONTRACT · <span class="notify-tag notified">🔔 TARGET NOTIFIED*</span></div>'
      +   '<div class="expand-section"><div class="expand-label">Hit Conditions</div><div class="expand-text">' + escHtml(c.conditions) + '</div></div>'
      +   survivalTxt
      +   '<button class="claim-btn" data-cid="' + c.id + '" data-target="' + escHtml(c.target) + '">⚔ CLAIM THIS CONTRACT</button>'
      + '</div>';

    card.addEventListener('click', function () {
      var exp = card.querySelector('.card-expanded');
      var open = exp.classList.contains('open');
      document.querySelectorAll('.card-expanded').forEach(function (e) { e.classList.remove('open'); });
      if (!open) exp.classList.add('open');
    });
    var claimContractBtn = card.querySelector('.claim-btn');
    claimContractBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      syncDropdown();
      var sel = el('claimTarget');
      if (sel) sel.value = claimContractBtn.getAttribute('data-target');
      switchTab(2);
      showToast('Contract selected: ' + claimContractBtn.getAttribute('data-target'));
    });

    board.appendChild(card);
  });
}

// ─── DROPDOWN ──────────────────────────────────────────
function syncDropdown() {
  var sel = el('claimTarget');
  if (!sel) return;
  sel.innerHTML = contracts.length === 0
    ? '<option value="">No active contracts yet...</option>'
    : '<option value="">Select contract...</option>';
  contracts.forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c.target;
    opt.textContent = c.target + ' (' + c.game + ')';
    sel.appendChild(opt);
  });
}

// ─── SUBMIT KILL ───────────────────────────────────────
function submitKill() {
  var target = el('claimTarget') ? el('claimTarget').value : '';
  var url    = val('clipUrl');
  if (!target) { showToast('Select a contract first'); return; }
  if (!url)    { showToast('Provide your clip URL');   return; }

  var platTab = document.querySelector('.plat-tab.active');
  var plat    = platTab ? platTab.getAttribute('data-plat').toUpperCase() : 'TWITCH';

  submissions.push({
    id:          's' + (nextId++),
    target:      target,
    url:         url,
    platform:    plat,
    status:      'review',   // review | claimed | rejected
    approves:    0,
    rejects:     0,
    submittedAt: Date.now()
  });
  saveState();

  setVal('clipUrl',''); setVal('clipNotes',''); setVal('clipTimestamp','');
  renderSubmissions(); renderVote();
  showToast('Kill submitted — voting opens for 24h');
}

// ─── MY SUBMISSIONS ────────────────────────────────────
function renderSubmissions() {
  var wrap = el('mySubmissions');
  if (!wrap) return;
  if (submissions.length === 0) {
    wrap.innerHTML = '<div class="empty-state" style="padding:20px 0">'
      + '<div class="empty-icon" style="font-size:18px">—</div>'
      + '<div class="empty-sub">No submissions yet</div></div>';
    return;
  }
  wrap.innerHTML = '';
  submissions.slice().reverse().forEach(function (s) {
    var vs   = voteState(s);
    var item = document.createElement('div');
    item.className = 'pending-item';

    var statusHtml = '';
    if (s.status === 'claimed') {
      statusHtml = '<span class="pending-status approved">✓ CLAIMED</span>';
    } else if (s.status === 'rejected') {
      statusHtml = '<span class="pending-status rejected">✕ REJECTED</span>';
    } else if (vs.claimable) {
      statusHtml = '<button class="claim-reward-btn" data-sid="' + s.id + '">⚔ CLAIM REWARD</button>';
    } else if (vs.expired && !vs.passed) {
      statusHtml = '<span class="pending-status rejected">✕ VOTE FAILED</span>';
    } else {
      statusHtml = '<span class="pending-status review">'
        + vs.pct + '% · ' + fmtCountdown(VOTE_WINDOW_MS - vs.elapsed) + '</span>';
    }

    item.innerHTML = '<span class="pending-target">' + escHtml(s.target) + ' · ' + s.platform + '</span>' + statusHtml;

    var claimBtn = item.querySelector('.claim-reward-btn');
    if (claimBtn) {
      claimBtn.addEventListener('click', function () { claimReward(s.id); });
    }
    wrap.appendChild(item);
  });
}

// ─── CLAIM REWARD ──────────────────────────────────────
function claimReward(sid) {
  var s = null;
  submissions.forEach(function (sub) { if (sub.id === sid) s = sub; });
  if (!s) return;
  var vs = voteState(s);
  if (!vs.claimable) { showToast('Votes not yet in your favour'); return; }

  s.status    = 'claimed';
  s.claimedAt = Date.now();
  saveState();

  // Add to leaderboard
  var contract = null;
  contracts.forEach(function (c) { if (c.target === s.target) contract = c; });
  var reward = contract ? contract.reward : '?';
  recordKill('You', reward);

  renderSubmissions();
  renderVote();
  showToast('☠ Reward claimed! Broadcaster will confirm payout.');
}

// ─── VOTE PANEL ────────────────────────────────────────
function renderVote() {
  var panel = el('panel-vote');
  panel.querySelectorAll('.vote-card,.empty-state').forEach(function (n) { n.remove(); });

  var visible = submissions.filter(function (s) { return s.status === 'review'; });
  if (visible.length === 0) {
    var emp = document.createElement('div');
    emp.className = 'empty-state';
    emp.innerHTML = '<div class="empty-icon">☠</div>'
      + '<div class="empty-text">No clips to review</div>'
      + '<div class="empty-sub">Submitted kills will appear here</div>';
    panel.appendChild(emp);
    return;
  }

  visible.forEach(function (s) {
    var vs      = voteState(s);
    var vid     = 'vc-' + s.id;
    var card    = document.createElement('div');
    card.className = 'vote-card';
    card.id = vid;

    var contract  = null;
    contracts.forEach(function (c) { if (c.target === s.target) contract = c; });
    var rewardTxt = contract ? contract.reward : '—';

    // Timer bar colour: green if passing, red if failing, grey if closed
    var barColor = vs.expired ? '#555' : vs.passed ? '#2ecc71' : '#c0392b';
    var countdown = vs.expired
      ? '<span style="color:#ff4444;font-family:Share Tech Mono,monospace;font-size:9px;letter-spacing:1px;">⏱ VOTING CLOSED</span>'
      : '<span style="color:var(--text-dim);font-family:Share Tech Mono,monospace;font-size:9px;letter-spacing:1px;">⏱ ' + fmtCountdown(VOTE_WINDOW_MS - vs.elapsed) + '</span>';

    // Threshold indicator
    var thresholdPx = Math.round(APPROVE_THRESH); // % position of the 60% line

    var statusBar = '';
    if (vs.claimable) {
      statusBar = '<div style="text-align:center;padding:8px 0;">'
        + '<button class="claim-reward-btn" data-sid="' + s.id + '" '
        + 'style="background:var(--blood);color:#fff;border:none;padding:10px 24px;'
        + 'font-family:Oswald,sans-serif;font-size:13px;letter-spacing:3px;cursor:pointer;width:100%;">'
        + '⚔ CLAIM REWARD — ' + escHtml(rewardTxt) + '</button></div>';
    } else if (vs.expired && !vs.passed) {
      statusBar = '<div style="text-align:center;padding:8px;font-family:Share Tech Mono,monospace;'
        + 'font-size:10px;color:#ff4444;letter-spacing:2px;">✕ VOTE FAILED — ' + vs.pct + '% approval (needed 60%)</div>';
    }

    var alreadyVoted = userVotes[s.id];

    card.innerHTML =
      '<div class="vc-header">'
      +   '<div class="vc-target">' + escHtml(s.target) + '</div>'
      +   '<div class="vc-reward">' + escHtml(rewardTxt) + '</div>'
      + '</div>'
      + '<div class="vc-meta" style="display:flex;justify-content:space-between;align-items:center;">'
      +   '<span>PLATFORM: <span class="vc-plat ' + s.platform.toLowerCase() + '">' + s.platform + '</span></span>'
      +   countdown
      + '</div>'
      + '<a class="vc-clip-link" href="' + escHtml(s.url) + '" target="_blank">▶ Watch Clip</a>'
      + '<div class="vc-tally">'
      +   '<div class="vc-tally-label">'
      +     '<span id="' + vid + '-approve-count">' + (s.approves||0) + ' approve</span>'
      +     '<span id="' + vid + '-pct">' + vs.pct + '%</span>'
      +     '<span id="' + vid + '-reject-count">' + (s.rejects||0) + ' reject</span>'
      +   '</div>'
      +   '<div class="vc-bar-bg" style="position:relative;">'
      +     '<div class="vc-bar-fill" id="' + vid + '-bar" style="width:' + vs.pct + '%;background:' + barColor + ';transition:width 0.4s;"></div>'
      +     '<div style="position:absolute;top:0;left:' + thresholdPx + '%;width:2px;height:100%;background:rgba(255,255,255,0.4);" title="60% threshold"></div>'
      +   '</div>'
      +   '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--text-dim);text-align:right;margin-top:2px;letter-spacing:1px;">60% needed · unlocks after 24h timer</div>'
      + '</div>'
      // Voting buttons — hidden if already voted or window closed
      + (!vs.expired && !alreadyVoted ?
          '<div class="vc-actions" id="' + vid + '-actions">'
          + '<button class="vc-btn approve">✓ LEGIT</button>'
          + '<button class="vc-btn reject">✕ INVALID</button>'
          + '</div>' : '')
      // Restore voted state if they already voted
      + (alreadyVoted ?
          '<div class="vc-voted ' + alreadyVoted + '" id="' + vid + '-voted">'
          + (alreadyVoted === 'approve' ? '✓ YOU VOTED — LEGIT' : '✕ YOU VOTED — INVALID')
          + '</div>' :
          '<div class="vc-voted" id="' + vid + '-voted" style="display:none"></div>')
      + statusBar;

    if (!vs.expired && !alreadyVoted) {
      var apBtn  = card.querySelector('.vc-btn.approve');
      var rejBtn = card.querySelector('.vc-btn.reject');
      if (apBtn)  apBtn.addEventListener('click',  function () { castVote(s.id, vid, 'approve'); });
      if (rejBtn) rejBtn.addEventListener('click',  function () { castVote(s.id, vid, 'reject');  });
    }

    var claimBtn = card.querySelector('.claim-reward-btn');
    if (claimBtn) claimBtn.addEventListener('click', function () { claimReward(s.id); });

    panel.appendChild(card);
  });
}

// ─── CAST VOTE ─────────────────────────────────────────
function castVote(sid, vid, type) {
  var s = null;
  submissions.forEach(function (sub) { if (sub.id === sid) s = sub; });
  if (!s) return;

  var vs = voteState(s);
  if (vs.expired) { showToast('Voting window has closed'); return; }

  // Block double voting
  if (userVotes[sid]) { showToast('You already voted on this clip'); return; }

  if (type === 'approve') s.approves = (s.approves || 0) + 1;
  else                    s.rejects  = (s.rejects  || 0) + 1;

  userVotes[sid] = type;
  saveState();

  // Update bar inline
  var newVs  = voteState(s);
  var apEl   = el(vid + '-approve-count');
  var rejEl  = el(vid + '-reject-count');
  var pctEl  = el(vid + '-pct');
  var barEl  = el(vid + '-bar');
  var actEl  = el(vid + '-actions');
  var votEl  = el(vid + '-voted');

  if (apEl)  apEl.textContent  = s.approves + ' approve';
  if (rejEl) rejEl.textContent = s.rejects  + ' reject';
  if (pctEl) pctEl.textContent = newVs.pct  + '%';
  if (barEl) {
    barEl.style.width      = newVs.pct + '%';
    barEl.style.background = newVs.passed ? '#2ecc71' : '#c0392b';
  }
  if (actEl) actEl.style.display = 'none';
  if (votEl) {
    votEl.style.display = 'block';
    votEl.className     = 'vc-voted ' + type;
    votEl.textContent   = type === 'approve' ? '✓ YOU VOTED — LEGIT' : '✕ YOU VOTED — INVALID';
  }

  showToast(type === 'approve' ? 'Vote cast: Legit' : 'Vote cast: Invalid');
  renderSubmissions();
}

// ─── LEADERBOARD ───────────────────────────────────────
function renderLeaderboard() {
  var panel = el('panel-leaderboard');
  panel.querySelectorAll('.lb-row,.lb-divider,.empty-state').forEach(function (n) { n.remove(); });

  if (leaderboard.length === 0) {
    var emp = document.createElement('div');
    emp.className = 'empty-state';
    emp.innerHTML = '<div class="empty-icon">☠</div>'
      + '<div class="empty-text">No hunters yet</div>'
      + '<div class="empty-sub">Complete a contract to appear here</div>';
    panel.appendChild(emp);
    return;
  }

  leaderboard.slice().sort(function (a, b) { return b.kills - a.kills; })
    .forEach(function (entry, i) {
      var row = document.createElement('div');
      row.className = 'lb-row';
      var rankCls = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
      row.innerHTML =
        '<div class="lb-rank ' + rankCls + '">' + (i + 1) + '</div>'
        + '<div class="lb-name">' + escHtml(entry.name) + '</div>'
        + '<div class="lb-kills">' + entry.kills + ' kill' + (entry.kills !== 1 ? 's' : '') + '</div>'
        + '<div class="lb-earned">' + escHtml(entry.earned) + '</div>';
      panel.appendChild(row);
    });
}

function recordKill(hunterName, reward) {
  var found = false;
  leaderboard.forEach(function (e) {
    if (e.name === hunterName) { e.kills++; e.earned = reward; found = true; }
  });
  if (!found) leaderboard.push({ name: hunterName, kills: 1, earned: reward });
  saveState();
  renderLeaderboard();
}
