// LaunchLens dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// ranked board, a detail view per protocol and the live-token reference table. No network: every
// byte it shows is in data.js. Routes live in the hash: #/ is the board, #/p/<slug> a protocol's
// detail, and #/?category=..&chain=..&watch=1&q=..&sort=.. a filtered board.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var main = document.getElementById('board');
  var meta = document.getElementById('meta');
  var foot = document.getElementById('foot');
  if (!DATA) { main.innerHTML = '<p class="empty">No data: run main.ts first.</p>'; return; }

  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n == null) return '—';
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  }
  function fmtPct(x) {
    if (x == null) return '<span class="slug">n/a</span>';
    var cls = x > 0 ? 'up' : x < 0 ? 'down' : '';
    return '<span class="' + cls + '">' + (x > 0 ? '+' : '') + x.toFixed(1) + '%</span>';
  }
  function fmtAge(days) {
    if (days == null) return 'unknown';
    if (days < 90) return days + 'd';
    if (days < 730) return Math.round(days / 30.4) + ' mo';
    return (days / 365.25).toFixed(1) + ' yrs';
  }
  function detailHref(slug) { return '#/p/' + encodeURIComponent(slug); }

  /* ---------- routing ---------- */
  function parseRoute() {
    var hash = window.location.hash.replace(/^#/, '');
    if (hash.indexOf('/p/') === 0) return { view: 'detail', slug: decodeURIComponent(hash.slice(3)) };
    var q = {};
    var qi = hash.indexOf('?');
    if (qi >= 0) {
      hash.slice(qi + 1).split('&').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv.length === 2) q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
      });
    }
    return {
      view: 'board',
      q: q.q || '',
      category: q.category || '',
      chain: q.chain || '',
      watch: q.watch === '1',
      min: q.min ? Number(q.min) : 0,
      sort: q.sort || 'rank',
      dir: q.dir === 'asc' ? 'asc' : 'desc',
    };
  }
  function boardHref(state) {
    var parts = [];
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.category) parts.push('category=' + encodeURIComponent(state.category));
    if (state.chain) parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.watch) parts.push('watch=1');
    if (state.min) parts.push('min=' + state.min);
    if (state.sort && state.sort !== 'rank') parts.push('sort=' + state.sort);
    if (state.dir && state.dir !== 'desc') parts.push('dir=' + state.dir);
    return '#/' + (parts.length ? '?' + parts.join('&') : '');
  }

  /* ---------- board ---------- */
  var SORTS = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    change: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; },
    age: function (r) { return r.age_days == null ? -1 : r.age_days; },
    multiple: function (r) { return r.model.category_multiple; },
    implied: function (r) { return r.implied_value_usd; },
  };
  function filteredRows(state) {
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.min && r.implied_value_usd < state.min) return false;
      if (state.q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase();
        if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
      }
      return true;
    });
    var key = SORTS[state.sort] || SORTS.rank;
    var dir = state.dir === 'asc' ? 1 : -1;
    if (state.sort === 'rank') dir = 1;
    rows.sort(function (a, b) {
      var ka = key(a), kb = key(b);
      if (ka < kb) return -dir; if (ka > kb) return dir;
      return a.rank - b.rank;
    });
    return rows;
  }
  function options(values, current, allLabel) {
    var out = '<option value="">' + allLabel + '</option>';
    values.forEach(function (v) {
      out += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    return out;
  }
  function sortHead(state, key, label, cls) {
    var arrow = state.sort === key ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
    var next = { q: state.q, category: state.category, chain: state.chain, watch: state.watch, min: state.min, sort: key, dir: state.sort === key && state.dir === 'desc' ? 'asc' : 'desc' };
    return '<th class="' + (cls || '') + '"><a class="sortbtn" href="' + boardHref(next) + '">' + label + arrow + '</a></th>';
  }
  function renderBoard(state) {
    var categories = [], chains = [], seenC = {}, seenH = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Uncategorised';
      if (!seenC[c]) { seenC[c] = 1; categories.push(c); }
      r.chains.forEach(function (h) { if (!seenH[h]) { seenH[h] = 1; chains.push(h); } });
    });
    categories.sort(); chains.sort();
    var rows = filteredRows(state);
    var html = '';
    html += '<form class="filters" id="filters">'
      + '<label>Search<input type="search" id="f-q" value="' + esc(state.q) + '" placeholder="name, slug, category"></label>'
      + '<label>Category<select id="f-category">' + options(categories, state.category, 'All categories') + '</select></label>'
      + '<label>Chain<select id="f-chain">' + options(chains, state.chain, 'All chains') + '</select></label>'
      + '<label>Min implied<select id="f-min">'
      + '<option value="0"' + (state.min === 0 ? ' selected' : '') + '>Any value</option>'
      + '<option value="10000000"' + (state.min === 1e7 ? ' selected' : '') + '>$10M+</option>'
      + '<option value="50000000"' + (state.min === 5e7 ? ' selected' : '') + '>$50M+</option>'
      + '<option value="250000000"' + (state.min === 2.5e8 ? ' selected' : '') + '>$250M+</option>'
      + '<option value="1000000000"' + (state.min === 1e9 ? ' selected' : '') + '>$1B+</option>'
      + '</select></label>'
      + '<label class="check"><input type="checkbox" id="f-watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>'
      + '<span class="count">' + rows.length + ' of ' + DATA.board_size + ' protocols</span>'
      + '</form>';
    if (rows.length === 0) {
      html += '<p class="empty">No protocol matches this filter. Loosen it: the radar tracks ' + DATA.board_size + ' pre-token protocols.</p>';
    } else {
      html += '<table><thead><tr>'
        + sortHead(state, 'rank', '#', 'rank')
        + sortHead(state, 'name', 'Protocol')
        + '<th>Category</th><th class="hideS">Chains</th>'
        + sortHead(state, 'tvl', 'TVL', 'num')
        + sortHead(state, 'change', '7d', 'num hideS')
        + sortHead(state, 'age', 'Tokenless', 'num hideS')
        + sortHead(state, 'multiple', 'Multiple', 'num hideS')
        + sortHead(state, 'implied', 'Implied value', 'num')
        + '</tr></thead><tbody>';
      rows.forEach(function (r) {
        html += '<tr data-slug="' + esc(r.slug) + '">'
          + '<td class="rank">' + r.rank + '</td>'
          + '<td><span class="pname"><a href="' + detailHref(r.slug) + '">' + esc(r.name) + '</a></span>'
          + (r.on_watchlist ? '<span class="badge watch">watchlist</span>' : '<span class="badge">early</span>')
          + '<br><span class="slug">' + esc(r.slug) + '</span></td>'
          + '<td>' + esc(r.category || 'Uncategorised') + '</td>'
          + '<td class="chains hideS">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>'
          + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
          + '<td class="num hideS">' + fmtPct(r.change_7d) + '</td>'
          + '<td class="num hideS">' + fmtAge(r.age_days) + '</td>'
          + '<td class="num hideS">' + r.model.category_multiple.toFixed(2) + '×</td>'
          + '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
    }
    html += renderLive();
    html += renderModel();
    main.innerHTML = html;
    main.setAttribute('aria-busy', 'false');
    bindFilters(state);
    var tbody = main.querySelector('tbody');
    if (tbody) tbody.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-slug]');
      if (tr && !e.target.closest('a')) window.location.hash = detailHref(tr.getAttribute('data-slug'));
    });
  }
  function bindFilters(state) {
    var form = document.getElementById('filters');
    if (!form) return;
    function apply() {
      var next = {
        q: document.getElementById('f-q').value,
        category: document.getElementById('f-category').value,
        chain: document.getElementById('f-chain').value,
        watch: document.getElementById('f-watch').checked,
        min: Number(document.getElementById('f-min').value),
        sort: state.sort, dir: state.dir,
      };
      window.history.replaceState(null, '', boardHref(next));
      renderBoard(next);
      var q = document.getElementById('f-q');
      q.focus(); q.setSelectionRange(q.value.length, q.value.length);
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    ['f-q', 'f-category', 'f-chain', 'f-min', 'f-watch'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', apply);
    });
    document.getElementById('f-q').addEventListener('input', apply);
  }

  /* ---------- detail ---------- */
  function renderDetail(slug) {
    var r = bySlug[slug];
    if (!r) { main.innerHTML = '<p class="empty">No protocol with that slug is on the board. <a class="back" href="#/">Back to the board</a></p>'; return; }
    var m = r.model;
    var prev = DATA.rows[r.rank - 2], next = DATA.rows[r.rank];
    var html = '<a class="back" href="#/">← the board</a>'
      + '<div class="detail-head"><h2>' + esc(r.name) + '</h2>'
      + (r.on_watchlist ? '<span class="badge watch">watchlist</span>' : '<span class="badge">early radar</span>')
      + '<span class="slug">' + esc(r.slug) + ' · rank #' + r.rank + ' of ' + DATA.board_size + '</span></div>'
      + '<p class="lede">' + esc(r.name) + ' records no token yet. LaunchLens values its launch at <b>' + fmtUsd(r.implied_value_usd) + '</b> if its record stayed as the snapshot has it. This is the model’s claim, not a prediction that a token will be issued.</p>'
      + '<div class="stats">'
      + '<div class="stat"><div class="k">Implied value</div><div class="v green">' + fmtUsd(r.implied_value_usd) + '</div></div>'
      + '<div class="stat"><div class="k">TVL</div><div class="v">' + fmtUsd(r.tvl_usd) + '</div></div>'
      + '<div class="stat"><div class="k">7d TVL change</div><div class="v">' + (r.change_7d == null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</div></div>'
      + '<div class="stat"><div class="k">Tokenless for</div><div class="v">' + fmtAge(r.age_days) + '</div></div>'
      + '<div class="stat"><div class="k">Category</div><div class="v">' + esc(r.category || 'Uncategorised') + '</div></div>'
      + '<div class="stat"><div class="k">Chains</div><div class="v">' + r.chains.length + '</div></div>'
      + '</div>'
      + '<h2>The arithmetic <span class="sub">model ' + esc(DATA.model_version) + '</span></h2>'
      + '<p class="arith">implied = TVL <b>' + fmtUsd(r.tvl_usd) + '</b> × category multiple <b>' + m.category_multiple.toFixed(2) + '×</b> × growth <b>' + m.growth_factor.toFixed(2) + '×</b> × maturity <b>' + m.maturity_factor.toFixed(2) + '×</b> × reach <b>' + m.reach_factor.toFixed(2) + '×</b> × size <b>' + m.size_factor.toFixed(2) + '×</b> = <b>' + fmtUsd(r.implied_value_usd) + '</b></p>'
      + '<p class="model-note">The category multiple is the median market-cap-to-TVL ratio of ' + esc(r.category || 'Uncategorised') + ' protocols whose token already trades in this same snapshot. Growth follows the seven-day TVL change, maturity the time tracked with no token, reach the chain count, and size a gentle compression past $2B of TVL.</p>'
      + '<h2>Farm plan <span class="sub">seven steps, costs and times included</span></h2>'
      + '<ol class="plan">'
      + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
      + '</ol>'
      + '<p>'
      + (prev ? '<a class="back" href="' + detailHref(prev.slug) + '">← #' + prev.rank + ' ' + esc(prev.name) + '</a> &nbsp; ' : '')
      + (next ? '<a class="back" href="' + detailHref(next.slug) + '">#' + next.rank + ' ' + esc(next.name) + ' →</a>' : '')
      + '</p>';
    main.innerHTML = html;
    main.setAttribute('aria-busy', 'false');
    window.scrollTo(0, 0);
  }

  /* ---------- live set + model ---------- */
  function renderLive() {
    var html = '<h2>Already trading <span class="sub">kept off the board: the market has priced these</span></h2>'
      + '<p class="lede">These protocols record a token, so LaunchLens does not rank them. Their market caps are the evidence the category multiples are learned from.</p>'
      + '<table class="plain"><thead><tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num hideS">MCap / TVL</th><th class="num hideS">7d</th></tr></thead><tbody>';
    DATA.live.forEach(function (r) {
      html += '<tr><td><span class="pname">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>'
        + '<td>' + esc(r.category || 'Uncategorised') + '</td>'
        + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
        + '<td class="num">' + fmtUsd(r.mcap_usd) + '</td>'
        + '<td class="num hideS">' + r.mcap_tvl.toFixed(2) + '×</td>'
        + '<td class="num hideS">' + fmtPct(r.change_7d) + '</td></tr>';
    });
    return html + '</tbody></table>';
  }
  function renderModel() {
    var learned = DATA.category_multiples.filter(function (c) { return c.learned; });
    var html = '<h2>How the radar values a launch <span class="sub">model ' + esc(DATA.model_version) + '</span></h2>'
      + '<p class="model-note">For each category, LaunchLens takes the median <code>market cap / TVL</code> of the protocols in that category whose token already trades in this snapshot, and applies it to the pre-token ones: <code>implied = TVL × multiple × growth × maturity × reach × size</code>. Growth clamps the seven-day TVL change to [−50%, +150%] at weight 0.40; maturity rises with the days a protocol has run with no token; reach adds 4% per extra chain up to five; size compresses gently past $2B of TVL. Categories with fewer than three traded peers use the snapshot-wide median multiple of <b>' + DATA.global_multiple.toFixed(2) + '×</b>. No name is special-cased.</p>'
      + '<table class="plain"><thead><tr><th>Category</th><th class="num">Launch multiple</th><th class="num">Traded peers</th></tr></thead><tbody>';
    learned.slice(0, 18).forEach(function (c) {
      html += '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.multiple.toFixed(2) + '×</td><td class="num">' + c.peers + '</td></tr>';
    });
    return html + '</tbody></table>';
  }

  /* ---------- go ---------- */
  function render() {
    var route = parseRoute();
    if (route.view === 'detail') renderDetail(route.slug);
    else renderBoard(route);
  }
  meta.textContent = 'Snapshot ' + DATA.as_of + ' · ' + DATA.board_size + ' pre-token protocols ranked (' + DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early) · ' + DATA.live_size + ' live references · model ' + DATA.model_version;
  foot.textContent = 'Data: ' + DATA.source + '. Implied values are this entry’s own model claims, not make.fun’s, and not a prediction that any token will be issued. Say a protocol records no token, never that it has none.';
  window.addEventListener('hashchange', render);
  render();
})();
