setTimeout(function() {
  var t = document.getElementById('killToast');
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 5000);
}, 3000);

setTimeout(function() {
  var t = document.getElementById('survivalToast');
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 5000);
}, 9000);

if (window.Twitch && window.Twitch.ext) {
  window.Twitch.ext.onAuthorized(function(auth) {
    window.Twitch.ext.listen('broadcast', function(target, contentType, message) {
      try {
        var d = JSON.parse(message);
        if (d.type === 'kill_confirmed') {
          document.getElementById('kHunter').textContent = d.hunter;
          document.getElementById('kTarget').textContent = d.target;
          document.getElementById('kReward').textContent = d.reward;
          var kt = document.getElementById('killToast');
          kt.classList.add('show');
          setTimeout(function() { kt.classList.remove('show'); }, 5000);
        }
        if (d.type === 'contract_expired') {
          document.getElementById('sTarget').textContent = d.target;
          document.getElementById('sReward').textContent = d.payout + ' paid to target';
          var st = document.getElementById('survivalToast');
          st.classList.add('show');
          setTimeout(function() { st.classList.remove('show'); }, 5000);
        }
      } catch(e) {}
    });
  });
}
