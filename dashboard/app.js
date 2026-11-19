// LaunchLens dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// ranked pre-token board, a detail view per protocol, the already-trading reference set, and the
// value model itself. No network: every byte it shows is in data.js. Routes live in the hash:
// #/ is the board, #/p/<slug> a protocol's detail, #/?view=live the trading set, and
// #/?category=..&chain=..&watch=1&tier=..&q=..&sort=.. a filtered board.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var main = document.getElementById('board');
  var meta = document.getElementById('meta');
  var foot = document.getElementById('foot');
  if (!DATA) { main.innerHTML = '<p class="empty">No data: run main.ts first.</p>'; return; }

  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var multByCat = {};
  DATA.category_multiples.forEach(function (c) { multByCat[c.category] = c; });
  var maxImplied = DATA.rows.length ? DATA.rows[0].implied_value_usd : 1;
  DATA.rows.forEach(function (r) { if (r.implied_value_usd > maxImplied) maxImplied = r.implied_value_usd; });

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
  function fmtFee(n) {
    if (n == null) return '—';
    return n < 10 ? '$' + n.toFixed(2) : '$' + Math.round(n);
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
  function tierOf(implied) {
    if (implied >= 250e6) return 'S';
    if (implied >= 75e6) return 'A';
    if (implied >= 20e6) return 'B';
    if (implied >= 5e6) return 'C';
    return 'D';
  }
  function confCls(c) { return c >= 85 ? 'hi' : c >= 65 ? 'mid' : 'lo'; }
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
      view: q.view === 'live' ? 'live' : 'pre',
      q: q.q || '',
      category: q.category || '',
      chain: q.chain || '',
      tier: q.tier || '',
      watch: q.watch === '1',
      min: q.min ? Number(q.min) : 0,
      sort: q.sort || 'rank',
      dir: q.dir === 'asc' ? 'asc' : 'desc',
    };
  }
  function boardHref(state) {
    var parts = [];
    if (state.view === 'live') parts.push('view=live');
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.category) parts.push('category=' + encodeURIComponent(state.category));
    if (state.chain) parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.tier) parts.push('tier=' + encodeURIComponent(state.tier));
    if (state.watch) parts.push('watch=1');
    if (state.min) parts.push('min=' + state.min);
    if (state.sort && state.sort !== 'rank') parts.push('sort=' + state.sort);
    if (state.dir && state.dir !== 'desc') parts.push('dir=' + state.dir);
    return '#/' + (parts.length ? '?' + parts.join('&') : '');
  }
  function switchHtml(state) {
    var pre = state.view !== 'live';
    return '<div class="switch" role="tablist">'
      + '<a href="#/" class="' + (pre ? 'on' : '') + '">PRE-TOKEN RADAR <span class="n">' + DATA.board_size + '</span></a>'
      + '<a href="#/?view=live" class="' + (!pre ? 'on live' : '') + '">ALREADY TRADING <span class="n">' + DATA.live_total + '</span></a>'
      + '</div>';
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
    fees: function (r) { return r.farm.est_fees_usd; },
    conf: function (r) { return r.confidence; },
  };
  function filteredRows(state) {
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.tier && tierOf(r.implied_value_usd) !== state.tier) return false;
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
    var next = { view: state.view, q: state.q, category: state.category, chain: state.chain, tier: state.tier, watch: state.watch, min: state.min, sort: key, dir: state.sort === key && state.dir === 'desc' ? 'asc' : 'desc' };
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
    var wlShown = rows.filter(function (r) { return r.on_watchlist; }).length;
    var html = switchHtml(state);
    html += '<form class="filters" id="filters">'
      + '<label>Search<input type="search" id="f-q" value="' + esc(state.q) + '" placeholder="name, slug, category"></label>'
      + '<label>Category<select id="f-category">' + options(categories, state.category, 'All categories') + '</select></label>'
      + '<label>Chain<select id="f-chain">' + options(chains, state.chain, 'All chains') + '</select></label>'
      + '<label>Tier<select id="f-tier">' + options(['S', 'A', 'B', 'C', 'D'], state.tier, 'All tiers') + '</select></label>'
      + '<label>Min implied<select id="f-min">'
      + '<option value="0"' + (state.min === 0 ? ' selected' : '') + '>Any value</option>'
      + '<option value="10000000"' + (state.min === 1e7 ? ' selected' : '') + '>$10M+</option>'
      + '<option value="50000000"' + (state.min === 5e7 ? ' selected' : '') + '>$50M+</option>'
      + '<option value="250000000"' + (state.min === 2.5e8 ? ' selected' : '') + '>$250M+</option>'
      + '</select></label>'
      + '<label class="check"><input type="checkbox" id="f-watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>'
      + '<span class="count">' + rows.length + ' of ' + DATA.board_size + ' shown<small>' + wlShown + ' watchlist · ' + (rows.length - wlShown) + ' early</small></span>'
      + '</form>';
    if (rows.length === 0) {
      html += '<p class="empty">No protocol matches this filter. Loosen it: the radar tracks ' + DATA.board_size + ' pre-token protocols.</p>';
    } else {
      html += '<table><thead><tr>'
        + sortHead(state, 'rank', '#', 'rank')
        + '<th>Tier</th>'
        + sortHead(state, 'name', 'Protocol · status')
        + '<th>Category</th><th class="hideS">Chains</th>'
        + sortHead(state, 'tvl', 'TVL', 'num')
        + sortHead(state, 'change', '7d', 'num hideS')
        + sortHead(state, 'age', 'Tokenless', 'num hideS')
        + sortHead(state, 'multiple', 'Mult', 'num hideS')
        + sortHead(state, 'implied', 'Implied value', 'num')
        + sortHead(state, 'fees', 'Farm plan', 'hideS')
        + '</tr></thead><tbody>';
      rows.forEach(function (r) {
        var t = tierOf(r.implied_value_usd);
        var barW = Math.max(4, Math.round(Math.sqrt(r.implied_value_usd / maxImplied) * 100));
        html += '<tr data-slug="' + esc(r.slug) + '">'
          + '<td class="rank">' + r.rank + '</td>'
          + '<td><span class="tier ' + t + '">' + t + '</span></td>'
          + '<td class="proto"><span class="pname"><a href="' + detailHref(r.slug) + '">' + esc(r.name) + '</a></span>'
          + '<span class="badge pre">PRE-TOKEN</span>'
          + (r.on_watchlist ? '<span class="badge watch">WATCHLIST</span>' : '<span class="badge early">EARLY</span>')
          + '<br><span class="slug">' + esc(r.slug) + ' · records no token</span></td>'
          + '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td>'
          + '<td class="chains hideS" title="' + esc(r.chains.join(', ')) + '">' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>'
          + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
          + '<td class="num hideS">' + fmtPct(r.change_7d) + '</td>'
          + '<td class="num hideS">' + fmtAge(r.age_days) + '</td>'
          + '<td class="num hideS">' + r.model.category_multiple.toFixed(2) + '×</td>'
          + '<td class="num"><span class="implied">' + fmtUsd(r.implied_value_usd) + '</span><div class="bar"><i style="width:' + barW + '%"></i></div></td>'
          + '<td class="farmcell hideS"><b>$' + r.farm.capital_usd + '</b> capital · ' + fmtFee(r.farm.est_fees_usd) + ' fees<br>' + r.farm.days + ' days · 8 steps · conf ' + r.confidence + '</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
    }
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
        view: state.view,
        q: document.getElementById('f-q').value,
        category: document.getElementById('f-category').value,
        chain: document.getElementById('f-chain').value,
        tier: document.getElementById('f-tier').value,
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
    ['f-q', 'f-category', 'f-chain', 'f-tier', 'f-min', 'f-watch'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', apply);
    });
    document.getElementById('f-q').addEventListener('input', apply);
  }

  /* ---------- live (already trading) view ---------- */
  var LIVE_SORTS = {
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    mcap: function (r) { return r.mcap_usd; },
    ratio: function (r) { return r.mcap_tvl; },
    change: function (r) { return r.change_7d == null ? -1e9 : r.change_7d; },
  };
  function renderLive(state) {
    var sortKey = LIVE_SORTS[state.sort] ? state.sort : 'mcap';
    var rows = DATA.live.filter(function (r) {
      if (!state.q) return true;
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.symbol || '')).toLowerCase();
      return hay.indexOf(state.q.toLowerCase()) >= 0;
    });
    var dir = state.dir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var ka = LIVE_SORTS[sortKey](a), kb = LIVE_SORTS[sortKey](b);
      if (ka < kb) return -dir; if (ka > kb) return dir;
      return b.mcap_usd - a.mcap_usd;
    });
    function lh(key, label, cls) {
      var arrow = sortKey === key ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
      var next = { view: 'live', q: state.q, sort: key, dir: sortKey === key && state.dir === 'desc' ? 'asc' : 'desc' };
      return '<th class="' + (cls || '') + '"><a class="sortbtn" href="' + boardHref(next) + '">' + label + arrow + '</a></th>';
    }
    var html = switchHtml(state);
    html += '<form class="filters" id="lfilters">'
      + '<label>Search the trading set<input type="search" id="l-q" value="' + esc(state.q) + '" placeholder="name, symbol, category"></label>'
      + '<span class="count">top ' + rows.length + ' of ' + DATA.live_total + ' trading<small>by market cap</small></span></form>'
      + '<p class="lede">These protocols <b>already have a trading token</b>, so LaunchLens never ranks them and gives them no farm plan. They are the evidence base: each category\u2019s launch multiple is the median <code>market cap / TVL</code> of its members here. Showing the top ' + DATA.live_size + ' of ' + DATA.live_total + ' by market cap.</p>'
      + '<table><thead><tr>'
      + lh('name', 'Protocol · status') + '<th>Symbol</th><th>Category</th>'
      + lh('tvl', 'TVL', 'num') + lh('mcap', 'Market cap', 'num')
      + lh('ratio', 'MCap / TVL', 'num hideS') + lh('change', '7d', 'num hideS')
      + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr><td><span class="pname">' + esc(r.name) + '</span><span class="badge live">TRADING</span><br><span class="slug">' + esc(r.slug) + '</span></td>'
        + '<td class="num">' + esc(r.symbol || '—') + '</td>'
        + '<td>' + esc(r.category || 'Uncategorised') + '</td>'
        + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
        + '<td class="num">' + fmtUsd(r.mcap_usd) + '</td>'
        + '<td class="num hideS">' + r.mcap_tvl.toFixed(2) + '×</td>'
        + '<td class="num hideS">' + fmtPct(r.change_7d) + '</td></tr>';
    });
    html += '</tbody></table>' + renderModel();
    main.innerHTML = html;
    main.setAttribute('aria-busy', 'false');
    var lq = document.getElementById('l-q');
    document.getElementById('lfilters').addEventListener('submit', function (e) { e.preventDefault(); });
    lq.addEventListener('input', function () {
      var next = { view: 'live', q: lq.value, sort: state.sort, dir: state.dir };
      window.history.replaceState(null, '', boardHref(next));
      renderLive(next);
      var q2 = document.getElementById('l-q');
      q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length);
    });
  }

  /* ---------- detail ---------- */
  function factorRow(label, sub, valueText, widthPct, note) {
    return '<div class="factor"><div class="fl">' + label + '<small>' + sub + '</small></div>'
      + '<div class="fv">' + valueText + '</div>'
      + '<div class="fb"><i style="width:' + Math.max(2, Math.min(100, Math.round(widthPct))) + '%"></i></div>'
      + '<div class="fn">' + note + '</div></div>';
  }
  function renderDetail(slug) {
    document.body.classList.add('detail-view');
    var r = bySlug[slug];
    if (!r) { main.innerHTML = '<p class="empty">No protocol with that slug is on the board. <a class="back" href="#/">Back to the board</a></p>'; return; }
    var m = r.model;
    var cat = r.category || 'Uncategorised';
    var cm = multByCat[cat];
    var peers = cm ? cm.peers : 0;
    var catRows = DATA.rows.filter(function (x) { return (x.category || 'Uncategorised') === cat; });
    var catRank = catRows.filter(function (x) { return x.implied_value_usd > r.implied_value_usd; }).length + 1;
    var prev = DATA.rows[r.rank - 2], next = DATA.rows[r.rank];
    var hours = (r.farm.est_minutes / 60).toFixed(1);
    var html = '<a class="back" href="#/">← the board</a>'
      + '<div class="detail-head"><h2>' + esc(r.name) + '</h2>'
      + '<span class="badge pre">PRE-TOKEN</span>'
      + (r.on_watchlist ? '<span class="badge watch">WATCHLIST</span>' : '<span class="badge early">EARLY RADAR</span>')
      + '<span class="tier ' + tierOf(r.implied_value_usd) + '">' + tierOf(r.implied_value_usd) + '</span>'
      + '<span class="slug">' + esc(r.slug) + ' · rank #' + r.rank + ' of ' + DATA.board_size + ' · #' + catRank + ' in ' + esc(cat) + '</span></div>'
      + '<p class="lede">' + esc(r.name) + ' records no token yet. LaunchLens values its launch at <b>' + fmtUsd(r.implied_value_usd) + '</b> if its record stayed as the snapshot has it. This is the model\u2019s claim, not a prediction that a token will be issued.</p>'
      + '<div class="chips">' + r.chains.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>'
      + '<div class="dstats">'
      + '<div class="stat"><div class="k">Implied value</div><div class="v green">' + fmtUsd(r.implied_value_usd) + '</div></div>'
      + '<div class="stat"><div class="k">TVL</div><div class="v">' + fmtUsd(r.tvl_usd) + '</div></div>'
      + '<div class="stat"><div class="k">7d TVL change</div><div class="v">' + (r.change_7d == null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</div></div>'
      + '<div class="stat"><div class="k">Tokenless for</div><div class="v">' + fmtAge(r.age_days) + '</div><div class="s">' + (r.age_days == null ? 'no listed date' : 'since ' + esc(r.listed_at)) + '</div></div>'
      + '<div class="stat"><div class="k">Category</div><div class="v" style="font-size:15px;padding-top:4px">' + esc(cat) + '</div></div>'
      + '<div class="stat"><div class="k">Confidence</div><div class="v"><span class="conf ' + confCls(r.confidence) + '" style="font-size:21px">' + r.confidence + '</span></div><div class="s">record completeness</div></div>'
      + '</div>'
      + '<h2>The arithmetic <span class="sub">model ' + esc(DATA.model_version) + ' · every factor from this protocol\u2019s own snapshot row</span></h2>'
      + '<p class="arith">implied = TVL <b>' + fmtUsd(r.tvl_usd) + '</b> × multiple <b>' + m.category_multiple.toFixed(2) + '×</b> × growth <b>' + m.growth_factor.toFixed(2) + '×</b> × maturity <b>' + m.maturity_factor.toFixed(2) + '×</b> × reach <b>' + m.reach_factor.toFixed(2) + '×</b> × size <b>' + m.size_factor.toFixed(2) + '×</b> = <b>' + fmtUsd(r.implied_value_usd) + '</b></p>'
      + '<h2>Farm plan <span class="sub">eight steps · budget summed from the steps themselves</span></h2>'
      + '<div class="budget">'
      + '<div class="stat"><div class="k">Capital at work</div><div class="v">$' + r.farm.capital_usd + '</div></div>'
      + '<div class="stat"><div class="k">Estimated fees</div><div class="v amber">' + fmtFee(r.farm.est_fees_usd) + '</div><div class="s">network fees, whole plan</div></div>'
      + '<div class="stat"><div class="k">Hold window</div><div class="v">' + r.farm.days + ' days</div></div>'
      + '<div class="stat"><div class="k">Hands-on time</div><div class="v">≈' + hours + ' h</div><div class="s">' + r.farm.est_minutes + ' minutes in all</div></div>'
      + '</div>'
      + '<ol class="plan">'
      + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('')
      + '</ol>'
      + '<h2>Why this value <span class="sub">factor by factor</span></h2>'
      + '<div class="factors">'
      + factorRow('Category multiple', cat, m.category_multiple.toFixed(2) + '×', m.category_multiple / 1.5 * 100, cm && cm.learned ? 'median of ' + peers + ' traded peers' : 'global median (' + peers + ' traded peer' + (peers === 1 ? '' : 's') + ')')
      + factorRow('Growth', '7d TVL change ' + (r.change_7d == null ? 'n/a' : r.change_7d.toFixed(1) + '%'), m.growth_factor.toFixed(2) + '×', (m.growth_factor - 0.62) / 0.8 * 100, 'saturating curve g/(50+|g|)')
      + factorRow('Maturity', 'tracked with no token', m.maturity_factor.toFixed(2) + '×', m.maturity_factor / 1.2 * 100, r.age_days == null ? 'no listed date: 0.88' : r.age_days + ' days, sqrt curve')
      + factorRow('Reach', r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains'), m.reach_factor.toFixed(2) + '×', (m.reach_factor - 1) / 0.24 * 100, '+3% per extra chain, cap 8')
      + factorRow('Size', 'TVL scale', m.size_factor.toFixed(2) + '×', m.size_factor * 100, r.tvl_usd > 1e9 ? '(1B/TVL)^0.10 compression' : 'no compression under $1B')
      + '</div>'
      + '<p class="model-note">The category multiple is the median market-cap-to-TVL ratio of ' + esc(cat) + ' protocols whose token already trades in this same snapshot' + (cm && cm.learned ? ' (' + peers + ' traded peers)' : ' (too few traded peers, so the snapshot-wide median of ' + DATA.global_multiple.toFixed(2) + '× applies)') + '. Confidence scores how complete the record is — a reported 7-day change, a listed date, several chains, a learned multiple — and never moves the value.</p>'
      + '<div class="pager">'
      + '<span>' + (prev ? '<a class="back" href="' + detailHref(prev.slug) + '">← #' + prev.rank + ' ' + esc(prev.name) + '</a>' : '') + '</span>'
      + '<span>' + (next ? '<a class="back" href="' + detailHref(next.slug) + '">#' + next.rank + ' ' + esc(next.name) + ' →</a>' : '') + '</span>'
      + '</div>';
    main.innerHTML = html;
    main.setAttribute('aria-busy', 'false');
    window.scrollTo(0, 0);
  }

  /* ---------- model section ---------- */
  function renderModel() {
    var learned = DATA.category_multiples.filter(function (c) { return c.learned; });
    var html = '<h2>How the radar values a launch <span class="sub">model ' + esc(DATA.model_version) + ' · learned from this snapshot, nothing hardcoded</span></h2>'
      + '<p class="model-note">For each category, LaunchLens takes the median <code>market cap / TVL</code> of the protocols in that category whose token already trades in this snapshot, and applies it to the pre-token ones: <code>implied = TVL × multiple × growth × maturity × reach × size</code>. <b>Growth</b> runs the seven-day TVL change through a saturating curve, <code>1 + 0.45 × g/(50+|g|)</code> with g clamped to [−90%, +400%], so momentum counts but a 4,000% outlier cannot break the board. <b>Maturity</b> is <code>0.70 + 0.50 × √(age in days / 1825)</code>: years run with no token earn trust on a square-root curve. <b>Reach</b> adds 3% per extra chain, capped at eight. <b>Size</b> compresses gently past $1B of TVL as <code>(1B/TVL)^0.10</code>, floored at 0.65×. Categories with fewer than three traded peers use the snapshot-wide median multiple of <b>' + DATA.global_multiple.toFixed(2) + '×</b>. The board covers all ' + DATA.watchlist_size + ' watchlist protocols plus ' + DATA.early_size + ' earlier finds below the floor; the ' + DATA.live_total + ' protocols whose token already trades are never ranked — they are the reference set the multiples are learned from. No name is special-cased: one function scores every row.</p>'
      + '<div class="multgrid">';
    learned.slice(0, 24).forEach(function (c) {
      html += '<div class="multcard"><span class="mc">' + esc(c.category) + '</span><span><span class="mm">' + c.multiple.toFixed(2) + '×</span><span class="mp">' + c.peers + ' traded peers</span></span></div>';
    });
    return html + '</div>';
  }

  /* ---------- header + go ---------- */
  function renderStats() {
    var el = document.getElementById('stats');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="k">Pre-token ranked</div><div class="v green">' + DATA.board_size + '</div><div class="s">all record no token</div></div>'
      + '<div class="stat"><div class="k">Watchlist covered</div><div class="v amber">' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</div><div class="s">+ ' + DATA.early_size + ' early finds</div></div>'
      + '<div class="stat"><div class="k">TVL under watch</div><div class="v">' + fmtUsd(DATA.board_tvl_usd) + '</div><div class="s">across the board</div></div>'
      + '<div class="stat"><div class="k">Median implied</div><div class="v">' + fmtUsd(DATA.median_implied_usd) + '</div><div class="s">global multiple ' + DATA.global_multiple.toFixed(2) + '×</div></div>'
      + '<div class="stat"><div class="k">Already trading</div><div class="v">' + DATA.live_total + '</div><div class="s">kept off the board</div></div>';
    var mv = document.getElementById('mver');
    if (mv) mv.textContent = DATA.model_version;
  }
  function render() {
    var route = parseRoute();
    if (route.view !== 'detail') document.body.classList.remove('detail-view');
    if (route.view === 'detail') renderDetail(route.slug);
    else if (route.view === 'live') renderLive(route);
    else renderBoard(route);
  }
  renderStats();
  meta.textContent = 'Snapshot ' + DATA.as_of + ' · ' + DATA.board_size + ' pre-token protocols ranked (' + DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early) · ' + DATA.live_total + ' trading references · model ' + DATA.model_version;
  foot.textContent = 'Data: ' + DATA.source + '. Implied values are this entry\u2019s own model claims, not make.fun\u2019s, and not a prediction that any token will be issued. Say a protocol records no token, never that it has none.';
  window.addEventListener('hashchange', render);
  render();
})();
