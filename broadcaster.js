// ─── EBS URL ───────────────────────────────────────────
// Set this after deploying your backend
var EBS_URL = 'https://your-app.up.railway.app';

document.addEventListener('DOMContentLoaded', function() {

  // LOOKUP BUTTON
  var lookupBtn = document.getElementById('bLookupBtn');
  if (lookupBtn) lookupBtn.addEventListener('click', lookupBStreamer);

  // Clear lookup card when target name is edited
  var bTargetInput = document.getElementById('bTarget');
  if (bTargetInput) bTargetInput.addEventListener('input', clearBLookup);

  // POST CONTRACT
  var postBtn = document.getElementById('bPostBtn');
  if (postBtn) postBtn.addEventListener('click', postContract);

  // SAVE SETTINGS
  var saveBtn = document.getElementById('saveSettingsBtn');
  if (saveBtn) saveBtn.addEventListener('click', function() { showNotification('Settings saved'); });

  // EXTEND / REMOVE contract buttons
  document.querySelectorAll('.btn-extend').forEach(function(btn) {
    btn.addEventListener('click', function() { extendContract(btn.getAttribute('data-id')); });
  });
  document.querySelectorAll('.btn-remove').forEach(function(btn) {
    btn.addEventListener('click', function() { removeContract(btn.getAttribute('data-id')); });
  });

  // APPROVE / REJECT kill buttons
  document.querySelectorAll('.btn-approve').forEach(function(btn) {
    btn.addEventListener('click', function() {
      approveKill(btn.getAttribute('data-id'), btn.getAttribute('data-hunter'), btn.getAttribute('data-reward'));
    });
  });
  document.querySelectorAll('.btn-reject').forEach(function(btn) {
    btn.addEventListener('click', function() {
      rejectKill(btn.getAttribute('data-id'), btn.getAttribute('data-hunter'));
    });
  });

  // PAY SURVIVAL / DISMISS
  document.querySelectorAll('.btn-pay-survival').forEach(function(btn) {
    btn.addEventListener('click', function() {
      paySurvival(btn.getAttribute('data-id'), btn.getAttribute('data-target'), btn.getAttribute('data-reward'));
    });
  });
  document.querySelectorAll('.btn-dismiss').forEach(function(btn) {
    btn.addEventListener('click', function() { dismissExpired(btn.getAttribute('data-id')); });
  });

  // SETTING TOGGLES
  document.querySelectorAll('.toggle').forEach(function(toggle) {
    toggle.addEventListener('click', function() { toggle.classList.toggle('on'); });
  });

  // REWARD TYPE SELECT
  var rewardSelect = document.getElementById('rewardType');
  if (rewardSelect) {
    rewardSelect.addEventListener('change', function() { switchReward(rewardSelect.value); });
    switchReward(rewardSelect.value);
  }

});

function clearBLookup() {
  var profile = document.getElementById('bStreamerProfile');
  var errEl   = document.getElementById('bLookupError');
  var notify  = document.getElementById('bNotifyInfo');
  var badge   = document.getElementById('bSpExtBadge');
  if (profile) profile.style.display = 'none';
  if (errEl)   errEl.style.display   = 'none';
  if (notify)  notify.style.display  = 'none';
  if (badge)   badge.style.display   = 'none';
}

function lookupBStreamer() {
  var input   = document.getElementById('bTarget').value.trim();
  if (!input) { showNotification('Enter a Twitch username first'); return; }
  clearBLookup();

  // Show loading state
  var profile = document.getElementById('bStreamerProfile');
  var badge   = document.getElementById('bSpExtBadge');
  var notify  = document.getElementById('bNotifyInfo');
  document.getElementById('bSpAvatar').textContent = '⏳';
  document.getElementById('bSpName').textContent   = input;
  var statusEl = document.getElementById('bSpStatus');
  statusEl.textContent = 'Looking up...';
  statusEl.className   = 'sp-status';
  document.getElementById('bSpLink').textContent = 'twitch.tv/' + input;
  if (profile) profile.style.display = 'flex';

  if (EBS_URL && EBS_URL.indexOf('your-app') === -1) {
    fetch(EBS_URL + '/api/lookup?username=' + encodeURIComponent(input))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.found) {
          document.getElementById('bSpAvatar').textContent = '❓';
          statusEl.textContent = 'User not found on Twitch';
          statusEl.className   = 'sp-status offline';
          return;
        }
        document.getElementById('bSpAvatar').textContent = data.is_live ? '🔴' : '🎮';
        document.getElementById('bSpName').textContent   = data.display_name || input;
        document.getElementById('bSpLink').textContent   = 'twitch.tv/' + data.login;
        if (data.is_live) {
          statusEl.textContent = '🔴 LIVE — ' + Number(data.viewer_count).toLocaleString() + ' viewers' + (data.game ? ' · ' + data.game : '');
          statusEl.className   = 'sp-status live';
        } else {
          statusEl.textContent = '⚫ OFFLINE';
          statusEl.className   = 'sp-status offline';
        }
        if (badge)  badge.style.display  = 'inline-block';
        if (notify) notify.style.display = 'block';
      })
      .catch(function() {
        document.getElementById('bSpAvatar').textContent = '🎮';
        statusEl.textContent = '⚠ Backend offline — verify status on Twitch';
        statusEl.className   = 'sp-status offline';
        if (badge)  badge.style.display  = 'inline-block';
        if (notify) notify.style.display = 'block';
      });
  } else {
    // No backend configured — show manual state
    document.getElementById('bSpAvatar').textContent = '🎮';
    statusEl.textContent = '⚫ OFFLINE (backend not configured)';
    statusEl.className   = 'sp-status offline';
    if (badge)  badge.style.display  = 'inline-block';
    if (notify) notify.style.display = 'block';
  }
}

function switchReward(val) {
  var cash = document.getElementById('reward-cash');
  var bits = document.getElementById('reward-bits');
  var both = document.getElementById('reward-both');
  if (cash) cash.style.display = (val === 'cash' || val === 'both') ? 'block' : 'none';
  if (bits) bits.style.display = val === 'bits' ? 'block' : 'none';
  if (both) both.style.display = val === 'both' ? 'block' : 'none';
}

function postContract() {
  var target  = document.getElementById('bTarget').value.trim();
  var game    = document.getElementById('bGame').value.trim();
  var profile = document.getElementById('bStreamerProfile');
  if (!target) { showNotification('Enter a Twitch username'); return; }
  if (!profile || profile.style.display === 'none') { showNotification('Look up the streamer first'); return; }
  if (!game) { showNotification('Enter the game'); return; }
  document.getElementById('bTarget').value = '';
  document.getElementById('bGame').value   = '';
  var els = ['bStreamerProfile','bLookupError','bNotifyInfo','bSpExtBadge'];
  els.forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; });
  showNotification('Contract posted — ' + target + ' has been notified');
}

function paySurvival(id, target, reward) {
  var el = document.getElementById(id);
  if (el) el.remove();
  showNotification('Survival payout sent: ' + reward + ' to ' + target);
}

function dismissExpired(id) {
  var el = document.getElementById(id);
  if (el) el.remove();
  showNotification('Dismissed.');
}

function removeContract(id) {
  var el = document.getElementById(id);
  if (el) el.remove();
  showNotification('Contract removed.');
}

function extendContract(id) {
  showNotification('+1 hour added to contract.');
}

function approveKill(id, hunter, reward) {
  var el = document.getElementById(id);
  if (el) el.remove();
  showNotification('Kill approved. Paying ' + reward + ' to ' + hunter);
}

function rejectKill(id, hunter) {
  var el = document.getElementById(id);
  if (el) el.remove();
  showNotification('Kill rejected. ' + hunter + ' notified.');
}

function showNotification(msg) {
  var n = document.getElementById('notification');
  if (!n) return;
  n.textContent = msg;
  n.classList.add('show');
  setTimeout(function() { n.classList.remove('show'); }, 2800);
}
