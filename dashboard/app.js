// LaunchLens dashboard: renders window.RADAR (written by main.ts as data.js).
// No network, no framework. Views: the pre-token board, one protocol's
// detail, a filtered board, and the separate already-trading view.
// The view is read from the URL hash: #detail=<slug>, #cat=<category>,
// #live=1 — the same states the screenshots were taken in.
(function () {
  var R = window.RADAR;
  var rows = R.rows, live = R.live;
  var state = { view: 'pre', q: '', cat: '', chain: '', sort: 'rank', sel: rows.length ? rows[0].slug : null };

  function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function pct(v) {
    if (v === null || v === undefined) return '<span class="sub">n/a</span>';
    var cls = v >= 0 ? 'up' : 'down';
    return '<span class="' + cls + '">' + (v >= 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(id) { return document.getElementById(id); }

  // Header stats and the model strip, straight from the model's own output.
  el('stats').innerHTML =
    '<div class="stat"><b>' + rows.length + '</b><span>pre-token ranked</span></div>' +
    '<div class="stat"><b>' + R.watchlist_size + '/' + R.watchlist_size + '</b><span>watchlist covered</span></div>' +
    '<div class="stat"><b>' + live.length + '</b><span>already trading</span></div>' +
    '<div class="stat"><b>' + R.global_multiple.toFixed(2) + 'x</b><span>global mcap/TVL</span></div>' +
    '<div class="stat"><b>' + R.as_of + '</b><span>snapshot date</span></div>';
  var pills = R.categories.slice(0, 10).map(function (c) {
    return '<span class="pill">' + esc(c.category) + ' ' + c.multiple.toFixed(2) + 'x · n=' + c.observations + '</span>';
  }).join('');
  el('model').innerHTML = '<b>How the value is derived:</b> implied value = TVL x category multiple x growth factor x track-record factor x chain factor. ' +
    'Multiples are learned from the snapshot itself — the median market-cap/TVL of protocols in the same category whose token already trades, shrunk toward the global median when a category has few prints. Growth (7d TVL change) and age pass through saturating curves, so one hot week or one extra year cannot dominate. Learned multiples: ' + pills;

  var cats = {}, chains = {};
  rows.forEach(function (r) { if (r.category) cats[r.category] = 1; r.chains.forEach(function (c) { chains[c] = 1; }); });
  Object.keys(cats).sort().forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; el('cat').appendChild(o); });
  Object.keys(chains).sort().forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; el('chain').appendChild(o); });

  function visible() {
    var list = rows.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if (r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      }
      return true;
    });
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || -999) - (a.change_7d || -999); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); }
    };
    return list.sort(by[state.sort]);
  }

  function renderBoard() {
    el('tab-pre').className = 'tab on'; el('tab-live').className = 'tab';
    var head = '<tr><th>#</th><th>Protocol</th><th class="num">Implied value</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Multiple</th><th>Status</th></tr>';
    el('board').querySelector('thead').innerHTML = head;
    var list = visible();
    el('empty').hidden = list.length > 0;
    el('board').querySelector('tbody').innerHTML = list.slice(0, 250).map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === state.sel ? ' class="sel"' : '') + '>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</span></td>' +
        '<td class="num"><b>' + fmt(r.implied_value_usd) + '</b></td>' +
        '<td class="num">' + fmt(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + r.multiple.toFixed(2) + 'x</td>' +
        '<td><span class="badge pre">pre-token</span>' + (r.watchlist ? ' <span class="badge wl">watchlist</span>' : '') + '</td></tr>';
    }).join('');
    bindRows();
  }

  function renderLive() {
    el('tab-pre').className = 'tab'; el('tab-live').className = 'tab on';
    el('board').querySelector('thead').innerHTML = '<tr><th>Protocol</th><th>Symbol</th><th class="num">Market cap</th><th class="num">TVL</th><th class="num">Observed mcap/TVL</th><th class="num">7d</th><th>Status</th></tr>';
    el('empty').hidden = true;
    el('board').querySelector('tbody').innerHTML = live.map(function (r) {
      return '<tr><td><span class="name">' + esc(r.name) + '</span><br><span class="sub">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</span></td>' +
        '<td>' + esc(r.symbol || '—') + '</td><td class="num"><b>' + fmt(r.mcap_usd) + '</b></td>' +
        '<td class="num">' + fmt(r.tvl_usd) + '</td><td class="num">' + r.observed_multiple.toFixed(2) + 'x</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td><td><span class="badge live">already trading</span></td></tr>';
    }).join('');
    el('detail').innerHTML = '<h2>Already trading</h2><p class="hint">These protocols record a token that already trades, so they are not launch candidates and never appear on the pre-token board. They are shown separately because their observed market-cap/TVL ratios are exactly what LaunchLens-2 learns its category multiples from: the model is fitted to this view, then applied to the pre-token board.</p>';
  }

  function renderDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) { el('detail').innerHTML = '<p class="hint">Pick a protocol on the board to see its detail and farm plan.</p>'; return; }
    state.sel = slug;
    var years = r.age_days === null ? 'not reported' : Math.floor(r.age_days / 365) + 'y ' + (r.age_days % 365) + 'd listed, no token recorded';
    var steps = r.farm_plan.map(function (s) {
      return '<div class="step"><b>Step ' + s.n + '.</b> ' + esc(s.action) + '<span class="meta">Cost about $' + s.cost_usd + ' · takes ' + esc(s.duration) + ' · budget line $' + s.budget_usd + '</span></div>';
    }).join('');
    el('detail').innerHTML = '<h2>' + esc(r.name) + '</h2>' +
      '<div><span class="badge pre">pre-token</span>' + (r.watchlist ? ' <span class="badge wl">on the watchlist</span>' : ' <span class="badge pre">early — below the watchlist floor</span>') + '</div>' +
      '<h3>Why this value</h3><dl class="kv">' +
      '<dt>Rank</dt><dd>#' + r.rank + ' of ' + rows.length + '</dd>' +
      '<dt>Implied launch value</dt><dd><b>' + fmt(r.implied_value_usd) + '</b></dd>' +
      '<dt>TVL (snapshot)</dt><dd>' + fmt(r.tvl_usd) + '</dd>' +
      '<dt>Category multiple (learned)</dt><dd>' + r.multiple.toFixed(2) + 'x from ' + r.multiple_observations + ' trading peers</dd>' +
      '<dt>Growth factor (saturating)</dt><dd>' + r.growth_factor.toFixed(2) + 'x on ' + (r.change_7d === null ? 'unreported' : r.change_7d.toFixed(1) + '% / 7d') + '</dd>' +
      '<dt>Track-record factor</dt><dd>' + r.age_factor.toFixed(2) + 'x · ' + years + '</dd>' +
      '<dt>Category</dt><dd>' + esc(r.category || 'Uncategorised') + '</dd>' +
      '<dt>Chains</dt><dd>' + esc(r.chains.join(', ')) + '</dd></dl>' +
      '<h3>Farm plan — 8 steps, about ' + r.farm_weeks + ' weeks</h3>' + steps +
      '<dl class="kv"><dt>Total budget (capital + costs)</dt><dd><b>' + fmt(r.farm_budget_usd) + '</b></dd></dl>' +
      '<p class="hint">The position inside the budget is the farmer\'s own capital, kept in the protocol; the step costs are gas and fees on the main chain.</p>';
  }

  function bindRows() {
    var trs = el('board').querySelectorAll('tbody tr');
    for (var i = 0; i < trs.length; i++) {
      trs[i].addEventListener('click', function () {
        var slug = this.getAttribute('data-slug');
        renderDetail(slug);
        var all = el('board').querySelectorAll('tbody tr');
        for (var j = 0; j < all.length; j++) all[j].className = all[j].getAttribute('data-slug') === slug ? 'sel' : '';
      });
    }
  }

  function render() {
    if (state.view === 'live') renderLive();
    else { renderBoard(); renderDetail(state.sel); }
  }

  el('q').addEventListener('input', function () { state.q = this.value; if (state.view === 'pre') renderBoard(); });
  el('cat').addEventListener('change', function () { state.cat = this.value; if (state.view === 'pre') renderBoard(); });
  el('chain').addEventListener('change', function () { state.chain = this.value; if (state.view === 'pre') renderBoard(); });
  el('sort').addEventListener('change', function () { state.sort = this.value; if (state.view === 'pre') renderBoard(); });
  el('tab-pre').addEventListener('click', function () { state.view = 'pre'; render(); });
  el('tab-live').addEventListener('click', function () { state.view = 'live'; render(); });

  // Hash states: the board, a detail, a filtered board, the trading view.
  function applyHash() {
    var h = location.hash.replace(/^#/, '');
    var parts = h.split('&'), changed = false;
    parts.forEach(function (kv) {
      var pair = kv.split('='), k = pair[0], v = decodeURIComponent(pair.slice(1).join('=') || '');
      if (k === 'detail' && v) { state.sel = v; changed = true; }
      if (k === 'cat') { state.cat = v; el('cat').value = v; changed = true; }
      if (k === 'chain') { state.chain = v; el('chain').value = v; changed = true; }
      if (k === 'live') { state.view = 'live'; changed = true; }
    });
    if (changed) render();
  }
  window.addEventListener('hashchange', applyHash);
  render();
  applyHash();
})();
