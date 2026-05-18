(function(){
  var out = document.getElementById('out');
  function set(v){ if (out) out.textContent = String(v); }
  try {
    set('step 1: external js running');
    setTimeout(function(){
      set([
        'step 2: timeout ok',
        'ua=' + navigator.userAgent,
        'url=' + location.href,
        'time=' + new Date().toISOString()
      ].join('\n'));
    }, 300);
  } catch (e) {
    set('error: ' + (e && e.stack ? e.stack : e));
  }
})();
