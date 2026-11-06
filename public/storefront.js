/* PrintHaus storefront v2
 * Taxonomy (category > subcategory > group), navigation, category/search listing with
 * working filters, and the product page option selectors.
 * Loaded after the inline script in index.html; relies on its globals (DATA, esc, PH,
 * wishBtn, cheapestFrom, slugifyCat, updatePrice, USP_ICONS, getSession ...).
 */

/* ===================== Taxonomy ===================== */
const TX = { cfg: [], map: {}, idx: {}, tree: {}, order: [] };
const IND_L2 = 'Shop by industry & use';

async function loadTaxonomy(){
  try {
    const r = await fetch('taxonomy.json', { cache: 'no-cache' });
    if (r.ok){ const j = await r.json(); TX.map = j.map || {}; TX.cfg = j.l1 || []; }
  } catch (e) {}
}

function l2Rank(n){ return n.name === IND_L2 ? 2 : /^Ready to buy/i.test(n.name) ? 1 : 0; }

function buildTaxonomy(){
  const labelOf = {};
  TX.cfg.forEach(c => { labelOf[c.key] = c.label; });
  TX.idx = {};
  const tree = {};
  Object.entries(DATA).forEach(([slug, p]) => {
    const m = TX.map[slug];
    const l2 = (m && m[0]) || p.subcat || p.cat;
    const l3 = (m && m[1]) || null;
    TX.idx[slug] = { l1: p.cat, l2, l3 };
    const n1 = tree[p.cat] || (tree[p.cat] = { key: p.cat, slug: slugifyCat(p.cat), label: labelOf[p.cat] || p.cat, count: 0, map: {} });
    n1.count++;
    const n2 = n1.map[l2] || (n1.map[l2] = { name: l2, slug: slugifyCat(l2), count: 0, map: {} });
    n2.count++;
    if (l3){
      const n3 = n2.map[l3] || (n2.map[l3] = { name: l3, slug: slugifyCat(l3), count: 0 });
      n3.count++;
    }
  });
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  Object.values(tree).forEach(n1 => {
    n1.kids = Object.values(n1.map).sort((a, b) => l2Rank(a) - l2Rank(b) || byCount(a, b));
    n1.kids.forEach(n2 => { n2.kids = Object.values(n2.map).sort(byCount); });
  });
  const cfgOrder = TX.cfg.map(c => c.key).filter(k => tree[k]);
  const extra = Object.keys(tree).filter(k => !cfgOrder.includes(k)).sort();
  TX.tree = tree;
  TX.order = cfgOrder.concat(extra).map(k => tree[k]);
  CATS = TX.order.map(n => n.key);
  CAT_SUBCATS = {};
  buildFacetIndex();
}

function nodeHref(n1, n2, n3){
  return '#c' + (n1 ? '/' + n1.slug : '') + (n1 && n2 ? '/' + n2.slug : '') + (n1 && n2 && n3 ? '/' + n3.slug : '');
}
function catHref(cat){ const n = TX.tree[cat]; return n ? nodeHref(n) : '#c'; }
function catLabel(cat){ return (TX.tree[cat] && TX.tree[cat].label) || cat; }

/* Old links (#cat-<cat>[-sub-<subcat>][-mat-<material>]) keep working. */
function legacyCat(raw){
  let catSlug = raw, subSlug = null, mat = null;
  const matIdx = raw.indexOf('-mat-');
  if (matIdx !== -1){ mat = decodeURIComponent(raw.slice(matIdx + 5)); catSlug = raw.slice(0, matIdx); raw = catSlug; }
  const subIdx = raw.indexOf('-sub-');
  if (subIdx !== -1){ subSlug = raw.slice(subIdx + 5); catSlug = raw.slice(0, subIdx); }
  const n1 = TX.order.find(n => n.slug === catSlug);
  if (!n1){ location.replace('#c'); return; }
  let n2 = null, n3 = null;
  if (subSlug){
    const hits = Object.entries(DATA).filter(([, p]) => p.cat === n1.key && slugifyCat(p.subcat || '') === subSlug).map(([s]) => TX.idx[s]);
    if (hits.length){
      const l2s = new Set(hits.map(h => h.l2));
      if (l2s.size === 1){
        n2 = n1.kids.find(k => k.name === hits[0].l2) || null;
        const l3s = new Set(hits.map(h => h.l3));
        if (n2 && l3s.size === 1 && hits[0].l3) n3 = n2.kids.find(k => k.name === hits[0].l3) || null;
      }
    }
  }
  let h = nodeHref(n1, n2, n3);
  const mtok = mat && cleanTok(mat);
  if (mtok && Object.entries(DATA).some(([s, p]) => p.cat === n1.key && FX[s] && FX[s].material.has(mtok))) h += '?material=' + encodeURIComponent(mtok);
  location.replace(h);
}

function renderFootCats(){
  const el = document.getElementById('footCats');
  if (el) el.innerHTML = TX.order.slice(0, 6).map(n => `<a href="${nodeHref(n)}" data-link>${esc(n.label)}</a>`).join('');
}

/* ===================== Navigation ===================== */
const isNarrow = () => window.matchMedia('(max-width:900px)').matches;
const CARET = '<svg class="pf-caret" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

const NAV_ICONS = {
  'Sticker/Labels':'<path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/>',
  'Packaging':'<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  'Cards/Stationery':'<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h6M7 14h4"/>',
  'Marketing':'<path d="M3 11v3l12 5V6z"/><path d="M15 9a4 4 0 010 6"/>',
  'Book Print On Demand':'<path d="M4 4h7a3 3 0 013 3v13a3 3 0 00-3-3H4zM20 4h-7"/><path d="M20 4v13h-6"/>',
  'Document Printing':'<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
  'A0 Plan Printing':'<rect x="3" y="4" width="18" height="14" rx="1"/><path d="M3 9h18M9 4v14"/>',
  'B2B Pricing':'<path d="M3 20V9l5-3v14M8 20V4l6 3v13M14 20h7v-8h-7"/>',
  'Industry':'<path d="M3 21V10l6 4v-4l6 4V6h3v15z"/>'
};
const navIcon = k => `<svg class="pf-ico" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[k] || NAV_ICONS['Packaging']}</svg>`;

function promoFor(n1){
  let best = null;
  Object.keys(DATA).forEach(s => { if (DATA[s].cat === n1.key && FROM[s] != null && (best === null || FROM[s] < FROM[best])) best = s; });
  if (!best) return '';
  const p = DATA[best];
  return `<a class="pf-promo" href="#product-${esc(best)}" data-link>
    <div class="pf-promo-img">${PH(p.name, p.cat)}</div>
    <b>${esc(p.name)}</b><span>From ₹${FROM[best].toFixed(2)} / unit</span><em>Shop now →</em></a>`;
}

function panelFor(n1){
  const groups = n1.kids.map(k => {
    const items = k.kids.length ? k.kids : [];
    return `<div class="pf-col">
      <a class="pf-col-h" href="${nodeHref(n1, k)}" data-link>${esc(k.name)}</a>
      ${items.length ? `<ul>${items.map(g => `<li><a href="${nodeHref(n1, k, g)}" data-link>${esc(g.name)}<span>${g.count}</span></a></li>`).join('')}</ul>` : `<ul><li class="all"><a href="${nodeHref(n1, k)}" data-link>${k.count} product${k.count === 1 ? '' : 's'} →</a></li></ul>`}
    </div>`;
  });
  return `<div class="pf-panel"><div class="pf-panel-in">
    <div class="pf-panel-grid"><div class="pf-cols">${groups.join('')}</div>${promoFor(n1)}</div>
    <div class="pf-panel-foot"><a href="${nodeHref(n1)}" data-link>Shop all ${esc(n1.label)} (${n1.count}) →</a><a href="#quote" data-link>Need something custom? Ask our print team →</a></div>
  </div></div>`;
}

function renderNav(){
  const bar = document.getElementById('pfCatbar');
  if (!bar) return;
  bar.innerHTML = `<ul class="pf-cats">
    ${TX.order.map(n => `<li class="pf-cat"><a class="pf-cat-link" href="${nodeHref(n)}" data-link aria-haspopup="true" aria-expanded="false">${navIcon(n.key)}<span>${esc(n.label)}</span>${CARET}</a>${panelFor(n)}</li>`).join('')}
  </ul>`;
  wireNav(bar);
  renderDrawer();
}

function closeNavPanels(){
  document.querySelectorAll('#pfCatbar .pf-cat.open').forEach(li => {
    li.classList.remove('open');
    const a = li.querySelector('.pf-cat-link'); if (a) a.setAttribute('aria-expanded', 'false');
  });
}
function openNavPanel(li){
  if (isNarrow()) return;
  document.querySelectorAll('#pfCatbar .pf-cat.open').forEach(o => { if (o !== li){ o.classList.remove('open'); o.querySelector('.pf-cat-link').setAttribute('aria-expanded', 'false'); } });
  if (!li.querySelector('.pf-panel')) return;
  li.classList.add('open');
  li.querySelector('.pf-cat-link').setAttribute('aria-expanded', 'true');
}

function wireNav(bar){
  bar.querySelectorAll('.pf-cat').forEach(li => {
    let t;
    li.addEventListener('mouseenter', () => { clearTimeout(t); t = setTimeout(() => openNavPanel(li), 80); });
    li.addEventListener('mouseleave', () => { clearTimeout(t); t = setTimeout(() => { li.classList.remove('open'); const a = li.querySelector('.pf-cat-link'); if (a) a.setAttribute('aria-expanded', 'false'); }, 160); });
    li.addEventListener('focusin', () => openNavPanel(li));
    li.addEventListener('focusout', (e) => { if (!li.contains(e.relatedTarget)) { li.classList.remove('open'); const a = li.querySelector('.pf-cat-link'); if (a) a.setAttribute('aria-expanded', 'false'); } });
  });
  bar.addEventListener('click', (e) => {
    if (e.target.closest('a[data-link]')) closeNavPanels();
  });
}

function renderDrawer(){
  let d = document.getElementById('pfDrawer');
  if (!d){
    d = document.createElement('div');
    d.id = 'pfDrawer'; d.className = 'pf-drawer'; d.setAttribute('aria-hidden', 'true');
    document.body.appendChild(d);
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target.closest('a[data-link]')) closeDrawer();
    });
  }
  const l3List = (n1, n2) => n2.kids.map(g => `<a class="pf-d-link l3" href="${nodeHref(n1, n2, g)}" data-link>${esc(g.name)}<span>${g.count}</span></a>`).join('');
  d.innerHTML = `
    <div class="pf-drawer-scrim" data-close></div>
    <div class="pf-drawer-sheet" role="dialog" aria-label="Menu">
      <div class="pf-drawer-head"><b>Browse products</b><button type="button" class="pf-x" data-close aria-label="Close menu">×</button></div>
      <div class="pf-drawer-body">
        <a class="pf-d-link top" href="#c" data-link>All products<span>${Object.keys(DATA).length}</span></a>
        ${TX.order.map(n1 => `
          <details class="pf-acc">
            <summary>${esc(n1.label)}<span>${n1.count}</span></summary>
            <a class="pf-d-link all" href="${nodeHref(n1)}" data-link>All ${esc(n1.label)}</a>
            ${n1.kids.map(n2 => n2.kids.length ? `
              <details class="pf-acc l2"><summary>${esc(n2.name)}<span>${n2.count}</span></summary>
                <a class="pf-d-link all" href="${nodeHref(n1, n2)}" data-link>All ${esc(n2.name)}</a>${l3List(n1, n2)}
              </details>` : `<a class="pf-d-link l2" href="${nodeHref(n1, n2)}" data-link>${esc(n2.name)}<span>${n2.count}</span></a>`).join('')}
          </details>`).join('')}
        <div class="pf-d-extra"><a href="#quote" data-link>Request a quote</a><a href="#orders" data-link>My orders</a><a href="#account" data-link>Account</a></div>
      </div>
    </div>`;
}

function openDrawer(){
  const d = document.getElementById('pfDrawer'); if (!d) return;
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
  document.body.classList.add('pf-lock');
  const mt = document.getElementById('menuToggle'); if (mt) mt.setAttribute('aria-expanded', 'true');
}
function closeDrawer(){
  const d = document.getElementById('pfDrawer'); if (!d) return;
  d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('pf-lock');
  const mt = document.getElementById('menuToggle'); if (mt) mt.setAttribute('aria-expanded', 'false');
}

function initChrome(){
  const mt = document.getElementById('menuToggle');
  if (mt){
    mt.setAttribute('aria-controls', 'pfDrawer'); mt.setAttribute('aria-expanded', 'false');
    mt.addEventListener('click', () => { const d = document.getElementById('pfDrawer'); (d && d.classList.contains('open')) ? closeDrawer() : openDrawer(); });
  }
  const form = document.getElementById('headerSearch');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('globalSearch').value.trim();
    location.hash = q ? '#c?q=' + encodeURIComponent(q) : '#c';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeNavPanels(); closeDrawer(); closeFilters();
    document.querySelectorAll('.nav-drop.open').forEach(n => n.classList.remove('open'));
  });
  window.addEventListener('resize', () => { if (!isNarrow()) { closeDrawer(); closeFilters(); } else closeNavPanels(); });
}

/* ===================== Facets ===================== */
const cleanTok = (v) => (v.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() || v.trim());
const FINISH_WORDS = [['Matt', /\bmatt?e?\b/i], ['Gloss', /gloss/i], ['Velvet touch', /velvet/i], ['Spot UV', /spot\s?-?uv/i], ['Foil', /foil/i], ['Textured', /textur/i]];
const FACET_DEFS = [
  { key: 'material', name: 'Material', test: l => /^(select )?material$/i.test(l), tok: v => [cleanTok(v)] },
  { key: 'shape', name: 'Shape', test: l => /^(select )?shape$/i.test(l), tok: v => v.split(' / ').map(cleanTok) },
  { key: 'quality', name: 'Quality', test: l => /^quality$/i.test(l), tok: v => [cleanTok(v)] },
  { key: 'finish', name: 'Finish', test: l => /paper|finish/i.test(l), tok: v => FINISH_WORDS.filter(([, re]) => re.test(v)).map(([n]) => n) },
  { key: 'gsm', name: 'Paper weight', test: l => /paper|finish|board/i.test(l), tok: v => { const m = v.match(/(\d{2,4})\s*gsm/i); return m ? [m[1] + ' gsm'] : []; } },
  { key: 'sides', name: 'Printed sides', test: l => /^printed sides$/i.test(l), tok: v => [/both/i.test(v) ? 'Both sides' : 'Single side'] },
  { key: 'format', name: 'Format', test: l => /^(select )?format$/i.test(l), tok: v => [cleanTok(v)] },
  { key: 'corners', name: 'Corners', test: l => /corner/i.test(l), tok: v => [/round/i.test(v) ? 'Rounded corners' : 'Straight corners'] },
];
let FX = {}, FROM = {};

function buildFacetIndex(){
  FX = {}; FROM = {};
  Object.entries(DATA).forEach(([slug, p]) => {
    const f = {};
    FACET_DEFS.forEach(d => { f[d.key] = new Set(); });
    Object.values(p.sizes || {}).forEach(om => Object.keys(om).forEach(raw => {
      if (raw === '(default)') return;
      raw.split('|').forEach(seg => {
        const i = seg.indexOf(':'); if (i === -1) return;
        const label = seg.slice(0, i).trim(), val = seg.slice(i + 1).trim();
        FACET_DEFS.forEach(d => { if (d.test(label)) d.tok(val).forEach(t => { if (t) f[d.key].add(t); }); });
      });
    }));
    FX[slug] = f;
    FROM[slug] = cheapestFrom(p);
  });
}

/* ===================== Listing page ===================== */
const LS = { n1: null, n2: null, n3: null, base: 'c', q: '', sort: 'rec', f: {}, min: null, max: null, open: {}, scope: [] };
const SORTS = [['rec', 'Recommended'], ['name', 'Name A–Z'], ['price-asc', 'Price: low to high'], ['price-desc', 'Price: high to low']];

function routeListing(hash){
  const [path, qs = ''] = hash.split('?');
  const segs = path.split('/').slice(1).filter(Boolean).map(decodeURIComponent);
  let n1 = null, n2 = null, n3 = null, bad = false;
  if (segs[0]){ n1 = TX.order.find(n => n.slug === segs[0]) || null; if (!n1) bad = true; }
  if (!bad && segs[1]){ n2 = n1.kids.find(k => k.slug === segs[1]) || null; if (!n2) bad = true; }
  if (!bad && segs[2]){ n3 = n2.kids.find(k => k.slug === segs[2]) || null; if (!n3) bad = true; }
  const view = document.getElementById('view');
  if (bad){
    view.innerHTML = `<div class="wrap pf-empty"><h1>We couldn't find that category</h1><p>It may have been renamed. Pick one below or browse everything.</p>
      <div class="pf-subchips">${TX.order.map(n => `<a href="${nodeHref(n)}" data-link>${esc(n.label)}</a>`).join('')}<a href="#c" data-link>All products</a></div></div>`;
    return;
  }
  const sp = new URLSearchParams(qs);
  LS.n1 = n1; LS.n2 = n2; LS.n3 = n3;
  LS.base = path;
  LS.q = (sp.get('q') || '').trim();
  LS.sort = SORTS.some(s => s[0] === sp.get('sort')) ? sp.get('sort') : 'rec';
  LS.min = sp.get('min') !== null && sp.get('min') !== '' && !isNaN(+sp.get('min')) ? +sp.get('min') : null;
  LS.max = sp.get('max') !== null && sp.get('max') !== '' && !isNaN(+sp.get('max')) ? +sp.get('max') : null;
  LS.f = {};
  FACET_DEFS.forEach(d => { const vals = sp.getAll(d.key); if (vals.length) LS.f[d.key] = new Set(vals); });
  LS.scope = Object.keys(DATA).filter(s => {
    const t = TX.idx[s];
    return !(n1 && t.l1 !== n1.key) && !(n2 && t.l2 !== n2.name) && !(n3 && t.l3 !== n3.name);
  });
  renderListing();
}

function listingTitle(){
  const node = LS.n3 ? LS.n3.name : LS.n2 ? LS.n2.name : LS.n1 ? LS.n1.label : null;
  if (LS.q && !node) return `Results for “${LS.q}”`;
  return node || 'All products';
}

function crumbs(parts){
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${parts.map((p, i) => p.href && i < parts.length - 1 ? `<a href="${p.href}" data-link>${esc(p.label)}</a>` : `<span aria-current="${i === parts.length - 1 ? 'page' : 'false'}">${esc(p.label)}</span>`).join('<i>›</i>')}</nav>`;
}

function listingCrumbs(){
  const c = [{ label: 'Home', href: '#home' }];
  if (!LS.n1){ c.push({ label: LS.q ? 'Search' : 'All products', href: '#c' }); return c; }
  c.push({ label: 'Products', href: '#c' });
  c.push({ label: LS.n1.label, href: nodeHref(LS.n1) });
  if (LS.n2) c.push({ label: LS.n2.name, href: nodeHref(LS.n1, LS.n2) });
  if (LS.n3) c.push({ label: LS.n3.name, href: nodeHref(LS.n1, LS.n2, LS.n3) });
  return c;
}

function browseTree(){
  const cur = (a, b) => (a === b ? ' active' : '');
  if (!LS.n1){
    return `<a class="pf-b-link all active" href="#c" data-link>All products<span>${Object.keys(DATA).length}</span></a>` +
      TX.order.map(n => `<a class="pf-b-link" href="${nodeHref(n)}" data-link>${esc(n.label)}<span>${n.count}</span></a>`).join('');
  }
  const n1 = LS.n1;
  return `<a class="pf-b-link all" href="#c" data-link>‹ All products</a>
    <a class="pf-b-link l1${LS.n2 ? '' : ' active'}" href="${nodeHref(n1)}" data-link>${esc(n1.label)}<span>${n1.count}</span></a>
    <div class="pf-b-kids">${n1.kids.map(n2 => `
      <a class="pf-b-link l2${cur(n2, LS.n2)}${LS.n2 === n2 && !LS.n3 ? ' active' : ''}" href="${nodeHref(n1, n2)}" data-link>${esc(n2.name)}<span>${n2.count}</span></a>
      ${LS.n2 === n2 && n2.kids.length ? `<div class="pf-b-kids l3">${n2.kids.map(n3 => `<a class="pf-b-link l3${cur(n3, LS.n3)}" href="${nodeHref(n1, n2, n3)}" data-link>${esc(n3.name)}<span>${n3.count}</span></a>`).join('')}</div>` : ''}`).join('')}
    </div>`;
}

function subChips(){
  const kids = LS.n3 ? [] : LS.n2 ? LS.n2.kids.map(g => [g.name, nodeHref(LS.n1, LS.n2, g), g.count]) : LS.n1 ? LS.n1.kids.map(k => [k.name, nodeHref(LS.n1, k), k.count]) : TX.order.map(n => [n.label, nodeHref(n), n.count]);
  if (!kids.length) return '';
  return `<div class="pf-subchips" aria-label="Browse sub-categories">${kids.map(([name, href, n]) => `<a href="${href}" data-link>${esc(name)}<span>${n}</span></a>`).join('')}</div>`;
}

function renderListing(){
  const view = document.getElementById('view');
  const gsearch = document.getElementById('globalSearch'); if (gsearch) gsearch.value = LS.q;
  document.title = listingTitle() + ' | PrintHaus';
  view.innerHTML = `
    <div class="wrap pf-list">
      ${crumbs(listingCrumbs())}
      <div class="pf-list-head"><h1>${esc(listingTitle())}</h1><div class="pf-count" id="pfCount" role="status" aria-live="polite"></div></div>
      ${subChips()}
      <div class="pf-layout">
        <aside class="pf-rail" id="pfRail" aria-label="Filters">
          <div class="pf-rail-top"><b>Filters</b><button type="button" class="pf-x" id="pfRailClose" aria-label="Close filters">×</button></div>
          <div class="pf-rail-scroll">
            <details class="pf-browse"${isNarrow() ? '' : ' open'}><summary>Browse categories</summary>${browseTree()}</details>
            <div id="pfFacets"></div>
          </div>
          <div class="pf-rail-foot"><button type="button" class="pf-clear" id="pfClear">Clear all</button><button type="button" class="button" id="pfApply">Show results</button></div>
        </aside>
        <div class="pf-main">
          <div class="pf-toolbar">
            <button type="button" class="pf-filter-btn" id="pfFilterBtn" aria-controls="pfRail">Filters<span id="pfFilterN"></span></button>
            <input class="pf-search" id="pfSearch" type="search" aria-label="Search within results" placeholder="Search in ${esc(LS.n1 ? listingTitle() : 'all products')}" value="${esc(LS.q)}">
            <label class="pf-sort"><span class="sr">Sort</span><select id="pfSort">${SORTS.map(([v, l]) => `<option value="${v}"${LS.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          <div class="pf-chips" id="pfChips"></div>
          <div class="pf-grid" id="pfGrid"></div>
          <p class="pf-note">Product images are illustrative. Prices are per unit and update with size, options and quantity.</p>
        </div>
      </div>
    </div>
    <div class="pf-scrim" id="pfScrim"></div>`;

  const rail = document.getElementById('pfRail');
  rail.addEventListener('change', onFacetChange);
  rail.addEventListener('click', onRailClick);
  document.getElementById('pfClear').addEventListener('click', clearAll);
  document.getElementById('pfApply').addEventListener('click', closeFilters);
  document.getElementById('pfRailClose').addEventListener('click', closeFilters);
  document.getElementById('pfFilterBtn').addEventListener('click', openFilters);
  document.getElementById('pfScrim').addEventListener('click', closeFilters);
  document.getElementById('pfSort').addEventListener('change', (e) => { LS.sort = e.target.value; refreshListing(); });
  let st; document.getElementById('pfSearch').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { LS.q = e.target.value.trim(); refreshListing(); }, 160); });
  document.getElementById('pfChips').addEventListener('click', onChipClick);
  refreshListing();
}

function openFilters(){ const r = document.getElementById('pfRail'); if (!r) return; r.classList.add('open'); document.getElementById('pfScrim').classList.add('show'); document.body.classList.add('pf-lock'); }
function closeFilters(){ const r = document.getElementById('pfRail'); if (!r) return; r.classList.remove('open'); const s = document.getElementById('pfScrim'); if (s) s.classList.remove('show'); if (!document.getElementById('pfDrawer')?.classList.contains('open')) document.body.classList.remove('pf-lock'); }

function textMatch(slug){
  if (!LS.q) return true;
  const t = TX.idx[slug], p = DATA[slug];
  const hay = (p.name + ' ' + catLabel(p.cat) + ' ' + t.l2 + ' ' + (t.l3 || '')).toLowerCase();
  return LS.q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}
function inPrice(slug){
  const v = FROM[slug];
  if (LS.min === null && LS.max === null) return true;
  if (v === null || v === undefined) return false;
  return (LS.min === null || v >= LS.min) && (LS.max === null || v <= LS.max);
}
function matchFacets(slug, except){
  for (const d of FACET_DEFS){
    if (d.key === except) continue;
    const sel = LS.f[d.key];
    if (!sel || !sel.size) continue;
    let ok = false;
    for (const t of sel){ if (FX[slug][d.key].has(t)){ ok = true; break; } }
    if (!ok) return false;
  }
  return true;
}

function activeFilterCount(){
  let n = 0;
  Object.values(LS.f).forEach(s => { n += s.size; });
  if (LS.min !== null || LS.max !== null) n++;
  return n;
}

function stateHash(){
  const sp = new URLSearchParams();
  if (LS.q) sp.set('q', LS.q);
  if (LS.sort !== 'rec') sp.set('sort', LS.sort);
  if (LS.min !== null) sp.set('min', LS.min);
  if (LS.max !== null) sp.set('max', LS.max);
  FACET_DEFS.forEach(d => { (LS.f[d.key] ? Array.from(LS.f[d.key]) : []).forEach(v => sp.append(d.key, v)); });
  const qs = sp.toString();
  return '#' + LS.base + (qs ? '?' + qs : '');
}

function refreshListing(){
  const base = LS.scope.filter(s => textMatch(s) && inPrice(s));
  let res = base.filter(s => matchFacets(s));
  if (LS.sort === 'name') res.sort((a, b) => DATA[a].name.localeCompare(DATA[b].name));
  else if (LS.sort === 'price-asc') res.sort((a, b) => (FROM[a] ?? Infinity) - (FROM[b] ?? Infinity));
  else if (LS.sort === 'price-desc') res.sort((a, b) => (FROM[b] ?? -Infinity) - (FROM[a] ?? -Infinity));

  const n = res.length, filtered = activeFilterCount() > 0 || !!LS.q;
  document.getElementById('pfCount').textContent = n + (n === 1 ? ' product' : ' products') + (filtered && base.length !== LS.scope.length ? ` of ${LS.scope.length}` : '');
  const grid = document.getElementById('pfGrid');
  grid.innerHTML = n ? res.map(s => pfCard(s)).join('') : `<div class="pf-none"><b>No products match these filters</b><p>Try removing a filter or searching with fewer words.</p><button type="button" class="button button-small" id="pfNoneClear">Clear all filters</button></div>`;
  const nc = document.getElementById('pfNoneClear'); if (nc) nc.addEventListener('click', clearAll);
  document.getElementById('pfApply').textContent = `Show ${n} result${n === 1 ? '' : 's'}`;
  const fn = activeFilterCount();
  document.getElementById('pfFilterN').textContent = fn ? ` (${fn})` : '';
  renderChips();
  renderFacets(base);
  const h = stateHash();
  if (location.hash !== h) history.replaceState(null, '', h);
}

function renderChips(){
  const chips = [];
  Object.entries(LS.f).forEach(([k, set]) => { const d = FACET_DEFS.find(x => x.key === k); set.forEach(v => chips.push([`${d.name}: ${v}`, k, v])); });
  if (LS.min !== null || LS.max !== null) chips.push([`Price ${LS.min !== null ? '₹' + LS.min : ''}–${LS.max !== null ? '₹' + LS.max : ''}`, 'price', '']);
  if (LS.q) chips.push([`“${LS.q}”`, 'q', '']);
  document.getElementById('pfChips').innerHTML = chips.length
    ? chips.map(([label, k, v]) => `<button type="button" class="pf-chip" data-ck="${esc(k)}" data-cv="${esc(v)}">${esc(label)}<i aria-hidden="true">×</i><span class="sr"> remove filter</span></button>`).join('') + `<button type="button" class="pf-chip clear" data-ck="all">Clear all</button>`
    : '';
}

function onChipClick(e){
  const b = e.target.closest('.pf-chip'); if (!b) return;
  const k = b.dataset.ck, v = b.dataset.cv;
  if (k === 'all') return clearAll();
  if (k === 'price'){ LS.min = LS.max = null; }
  else if (k === 'q'){ LS.q = ''; const s = document.getElementById('pfSearch'); if (s) s.value = ''; const g = document.getElementById('globalSearch'); if (g) g.value = ''; }
  else if (LS.f[k]){ LS.f[k].delete(v); if (!LS.f[k].size) delete LS.f[k]; }
  refreshListing();
}

function clearAll(){
  LS.f = {}; LS.min = LS.max = null; LS.q = '';
  const s = document.getElementById('pfSearch'); if (s) s.value = '';
  const g = document.getElementById('globalSearch'); if (g) g.value = '';
  refreshListing();
}

function renderFacets(base){
  const box = document.getElementById('pfFacets'); if (!box) return;
  const ae = document.activeElement;
  const keep = ae && ae.dataset && ae.dataset.fk ? [ae.dataset.fk, ae.dataset.fv] : null;
  const keepPrice = ae && (ae.id === 'pfMin' || ae.id === 'pfMax') ? ae.id : null;
  const scroller = box.closest('.pf-rail-scroll'); const top = scroller ? scroller.scrollTop : 0;
  let html = '';
  FACET_DEFS.forEach(d => {
    const pool = base.filter(s => matchFacets(s, d.key));
    const counts = new Map();
    pool.forEach(s => FX[s][d.key].forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    const sel = LS.f[d.key] || new Set();
    sel.forEach(t => { if (!counts.has(t)) counts.set(t, 0); });
    let vals = Array.from(counts.entries());
    if (vals.length < 2 && !sel.size) return;
    if (vals.length && vals.every(([, c]) => c === pool.length) && !sel.size) return;
    vals.sort(d.key === 'gsm' ? (a, b) => parseInt(a[0]) - parseInt(b[0]) : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const LIMIT = 7, expanded = LS.open[d.key];
    const shown = expanded ? vals : vals.slice(0, LIMIT);
    html += `<details class="pf-group" open><summary>${esc(d.name)}${sel.size ? `<em>${sel.size}</em>` : ''}</summary>
      ${shown.map(([t, c]) => `<label class="pf-opt${c === 0 && !sel.has(t) ? ' zero' : ''}"><input type="checkbox" data-fk="${d.key}" data-fv="${esc(t)}"${sel.has(t) ? ' checked' : ''}><span>${esc(t)}</span><em>${c}</em></label>`).join('')}
      ${vals.length > LIMIT ? `<button type="button" class="pf-more" data-more="${d.key}">${expanded ? 'Show fewer' : `Show all ${vals.length}`}</button>` : ''}
    </details>`;
  });
  const prices = base.map(s => FROM[s]).filter(v => v !== null && v !== undefined);
  if (prices.length > 1){
    const lo = Math.floor(Math.min(...prices)), hi = Math.ceil(Math.max(...prices));
    html += `<details class="pf-group" open><summary>Unit price (from)${(LS.min !== null || LS.max !== null) ? '<em>1</em>' : ''}</summary>
      <div class="pf-price"><label><span class="sr">Minimum price</span><input id="pfMin" type="number" min="0" step="any" inputmode="decimal" placeholder="₹${lo}" value="${LS.min !== null ? LS.min : ''}"></label><i>–</i>
      <label><span class="sr">Maximum price</span><input id="pfMax" type="number" min="0" step="any" inputmode="decimal" placeholder="₹${hi}" value="${LS.max !== null ? LS.max : ''}"></label></div></details>`;
  }
  box.innerHTML = html || '<p class="pf-nofacets">No more filters for this selection.</p>';
  if (scroller) scroller.scrollTop = top;
  if (keep){ const el = box.querySelector(`[data-fk="${keep[0]}"][data-fv="${CSS.escape(keep[1])}"]`); if (el) el.focus({ preventScroll: true }); }
  if (keepPrice){ const el = document.getElementById(keepPrice); if (el){ el.focus({ preventScroll: true }); const v = el.value; el.value = ''; el.value = v; } }
}

function onFacetChange(e){
  const t = e.target;
  if (t.dataset && t.dataset.fk){
    const k = t.dataset.fk, v = t.dataset.fv;
    const set = LS.f[k] || (LS.f[k] = new Set());
    if (t.checked) set.add(v); else set.delete(v);
    if (!set.size) delete LS.f[k];
    refreshListing();
  } else if (t.id === 'pfMin' || t.id === 'pfMax'){
    const val = t.value === '' ? null : Math.max(0, +t.value);
    if (t.id === 'pfMin') LS.min = val; else LS.max = val;
    if (LS.min !== null && LS.max !== null && LS.min > LS.max){ const x = LS.min; LS.min = LS.max; LS.max = x; }
    refreshListing();
  }
}
function onRailClick(e){
  const m = e.target.closest('[data-more]');
  if (m){ LS.open[m.dataset.more] = !LS.open[m.dataset.more]; refreshListing(); return; }
  if (e.target.closest('a[data-link]')) closeFilters();
}

function pfCard(slug){
  const p = DATA[slug], t = TX.idx[slug], from = FROM[slug];
  const meta = t.l3 || (t.l2 && t.l2 !== IND_L2 ? t.l2 : catLabel(p.cat));
  return `<a class="pf-card" href="#product-${esc(slug)}" data-link>
    <div class="pf-card-img">${PH(p.name, p.cat)}${wishBtn(slug)}</div>
    <div class="pf-card-body"><span class="pf-card-meta">${esc(meta)}</span><b>${esc(p.name)}</b>
    <span class="pf-card-price">${from !== null && from !== undefined ? `From <strong>₹${from.toFixed(2)}</strong> / unit` : 'Get a quote'}</span></div></a>`;
}

/* ===================== Product page ===================== */
const PDP = { slug: null, attrs: [], sel: {}, key: null };

function parseOpt(raw){
  if (raw === '(default)') return [{ label: 'Option', value: 'Standard' }];
  let blanks = 0;
  return raw.split('|').map(seg => {
    const i = seg.indexOf(':');
    if (i === -1){ blanks++; return { label: blanks > 1 ? 'Option ' + blanks : 'Option', value: seg.trim() }; }
    return { label: seg.slice(0, i).trim(), value: seg.slice(i + 1).trim() };
  });
}
const prettyVal = (v) => v.replace(/\s\/\s/g, ', ').replace(/\/\s+/g, '/');
const niceLabel = (l) => l.replace(/^select\s+/i, '').replace(/^\w/, c => c.toUpperCase());

function currentSize(){ return document.getElementById('sizeSwatches')?.value; }
function currentOpt(){ return PDP.key; }

function buildAttrs(slug, size){
  const keys = Object.keys((DATA[slug].sizes[size]) || {});
  const rows = keys.map(k => ({ raw: k, vals: Object.fromEntries(parseOpt(k).map(s => [s.label, s.value])) }));
  const attrs = [];
  rows.forEach(r => Object.keys(r.vals).forEach(l => {
    let a = attrs.find(x => x.label === l);
    if (!a){ a = { label: l, values: [] }; attrs.push(a); }
    if (!a.values.includes(r.vals[l])) a.values.push(r.vals[l]);
  }));
  PDP.rows = rows; PDP.attrs = attrs;
}

function rowMatches(r, sel, skip){
  return Object.keys(sel).every(l => l === skip || r.vals[l] === undefined || r.vals[l] === sel[l]);
}

function resolveSel(){
  const hit = PDP.rows.find(r => PDP.attrs.every(a => r.vals[a.label] === undefined || r.vals[a.label] === PDP.sel[a.label]));
  if (hit){ PDP.key = hit.raw; return; }
  const first = PDP.rows[0];
  PDP.sel = first ? Object.assign({}, first.vals) : {};
  PDP.key = first ? first.raw : null;
}

function renderOptionGroups(slug){
  const box = document.getElementById('optGroups'); if (!box) return;
  const multi = PDP.attrs.filter(a => a.values.length > 1);
  const fixed = PDP.attrs.filter(a => a.values.length === 1 && !(a.label === 'Option' && a.values[0] === 'Standard'));
  box.innerHTML = multi.map(a => `
    <div class="option-group pf-attr" data-attr="${esc(a.label)}">
      <label id="lbl-${esc(slugifyCat(a.label))}">${esc(niceLabel(a.label))}</label>
      <div class="pf-pills" role="radiogroup" aria-labelledby="lbl-${esc(slugifyCat(a.label))}">
        ${a.values.map(v => {
          const avail = PDP.rows.some(r => r.vals[a.label] === v && rowMatches(r, PDP.sel, a.label));
          const on = PDP.sel[a.label] === v;
          return `<button type="button" role="radio" aria-checked="${on}" class="pf-pill${on ? ' on' : ''}${avail ? '' : ' unavail'}" data-v="${esc(v)}">${esc(prettyVal(v))}</button>`;
        }).join('')}
      </div>
    </div>`).join('') + (fixed.length ? `<p class="pf-fixed">${fixed.map(a => `<span><b>${esc(niceLabel(a.label))}:</b> ${esc(prettyVal(a.values[0]))}</span>`).join('')}</p>` : '');
  box.querySelectorAll('.pf-attr').forEach(g => {
    g.addEventListener('click', (e) => {
      const b = e.target.closest('.pf-pill'); if (!b) return;
      pickOption(slug, g.dataset.attr, b.dataset.v);
    });
  });
}

function pickOption(slug, label, value){
  const want = Object.assign({}, PDP.sel, { [label]: value });
  let hit = PDP.rows.find(r => PDP.attrs.every(a => r.vals[a.label] === undefined || r.vals[a.label] === want[a.label]));
  if (!hit){
    let best = -1;
    PDP.rows.forEach(r => {
      if (r.vals[label] !== value) return;
      const score = PDP.attrs.reduce((n, a) => n + (r.vals[a.label] !== undefined && r.vals[a.label] === PDP.sel[a.label] ? 1 : 0), 0);
      if (score > best){ best = score; hit = r; }
    });
  }
  if (!hit) return;
  const changed = PDP.attrs.some(a => a.label !== label && hit.vals[a.label] !== undefined && hit.vals[a.label] !== PDP.sel[a.label]);
  PDP.sel = Object.assign({}, hit.vals); PDP.key = hit.raw;
  renderOptionGroups(slug);
  const note = document.getElementById('optNote');
  if (note) note.textContent = changed ? 'We adjusted your other choices to a combination we offer.' : '';
  populateQty(slug);
}

function populateSizes(slug){
  const p = DATA[slug];
  const sizes = Object.keys(p.sizes);
  const sel = document.getElementById('sizeSwatches');
  sel.innerHTML = sizes.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  sel.onchange = () => populateOptionsForSize(slug, true);
  populateOptionsForSize(slug, false);
}

function populateOptionsForSize(slug, keepPrev){
  const prev = keepPrev ? Object.assign({}, PDP.sel) : {};
  buildAttrs(slug, currentSize());
  PDP.sel = {};
  const first = PDP.rows[0];
  if (first) Object.assign(PDP.sel, first.vals);
  if (keepPrev) PDP.attrs.forEach(a => { if (prev[a.label] !== undefined && a.values.includes(prev[a.label])) PDP.sel[a.label] = prev[a.label]; });
  resolveSel();
  renderOptionGroups(slug);
  populateQty(slug);
}

function populateQty(slug){
  const p = DATA[slug];
  const rows = ((p.sizes[currentSize()] || {})[PDP.key] || []).slice().sort((a, b) => a[0] - b[0]);
  const qtySel = document.getElementById('qtySel');
  const prev = qtySel.value;
  qtySel.innerHTML = rows.map(r => `<option value="${r[0]}">${r[0].toLocaleString()} pcs · ₹${r[1].toFixed(2)} each</option>`).join('');
  if (rows.some(r => String(r[0]) === prev)) qtySel.value = prev;
  qtySel.onchange = () => updatePrice(slug);
  updatePrice(slug);
}

function pdpRelated(slug){
  const t = TX.idx[slug];
  const rank = (s) => { const o = TX.idx[s]; return o.l1 !== t.l1 ? 9 : o.l2 !== t.l2 ? 2 : (t.l3 && o.l3 !== t.l3) ? 1 : 0; };
  return Object.keys(DATA).filter(s => s !== slug && TX.idx[s].l1 === t.l1).sort((a, b) => rank(a) - rank(b)).slice(0, 4);
}

function renderProduct(slug){
  const p = DATA[slug];
  const view = document.getElementById('view');
  if (!p){ view.innerHTML = '<div class="wrap pf-empty"><h1>Product not found</h1><p>It may have been removed or renamed.</p><a class="button button-small" href="#c" data-link>Browse all products</a></div>'; return; }
  const t = TX.idx[slug], n1 = TX.tree[t.l1];
  const n2 = n1 && n1.kids.find(k => k.name === t.l2), n3 = n2 && t.l3 ? n2.kids.find(k => k.name === t.l3) : null;
  document.title = p.name + ' | PrintHaus';
  const sizes = Object.keys(p.sizes);
  const related = pdpRelated(slug);
  const trail = [{ label: 'Home', href: '#home' }];
  if (n1) trail.push({ label: n1.label, href: nodeHref(n1) });
  if (n1 && n2) trail.push({ label: n2.name, href: nodeHref(n1, n2) });
  if (n1 && n2 && n3) trail.push({ label: n3.name, href: nodeHref(n1, n2, n3) });
  trail.push({ label: p.name });
  const tick = '<i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></i>';
  view.innerHTML = `
    <main class="wrap pf-pdp">
      ${crumbs(trail)}
      <section class="pf-pdp-top">
        <div class="pf-gallery">
          <div class="pf-gallery-img" id="mainImage">${PH(p.name, p.cat)}</div>
          <p class="image-note">Illustrative product preview — final print may vary</p>
        </div>
        <div class="pf-buy">
          <h1>${esc(p.name)}</h1>
          <p class="pf-sub">${esc(t.l3 || t.l2 || '')}${n1 ? ' · ' + esc(n1.label) : ''}</p>
          <div class="summary-panel">
            <div class="option-group"><label for="sizeSwatches">Size</label><select id="sizeSwatches"></select></div>
            <div id="optGroups"></div>
            <p class="pf-optnote" id="optNote" role="status" aria-live="polite"></p>
            <div class="option-group"><label for="qtySel">Quantity</label><select id="qtySel"></select></div>

            <div class="option-group pf-artwork">
              <label for="artworkFile">Artwork <span>(optional)</span></label>
              <input id="artworkFile" type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,.ai,.eps,.psd,.cdr">
              <small id="artworkFileHint">PNG, JPG, PDF, AI, EPS or PSD — up to 25MB. Sign in to upload.</small>
              <div id="artworkFileProgress" hidden class="pf-progress"><div></div></div>
              <div id="artworkFileStatus" class="pf-upstatus"></div>
              <details><summary>or paste a link instead</summary>
                <input id="artworkLink" type="url" placeholder="https://…">
              </details>
            </div>

            <div class="design-support" hidden>
              <input type="checkbox" id="designSupport">
              <div class="avatar"></div>
              <div class="ds-copy"><b>Need Design Support?</b><small>Get a professional design from our team</small></div>
              <div class="ds-price">+ ₹299</div>
            </div>

            <div id="priceArea"></div>
            <div class="purchase-actions"><button class="button" id="addCartBtn" type="button">Add to cart</button></div>
            <p class="cart-message" id="cartMsg" role="status"></p>
            <a class="button button-outline pf-quote-btn" href="#quote-${esc(slug)}" data-link>Request a quote</a>
          </div>
          <div class="product-perks">
            <div><i>${USP_ICONS.dispatch}</i><span><b>Premium<br>Print Quality</b></span></div>
            <div><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg></i><span><b>Custom Sizes<br>&amp; Finishes</b></span></div>
            <div><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></i><span><b>Fast<br>Turnaround</b></span></div>
            <div><i>${USP_ICONS.moq}</i><span><b>Bulk Orders &amp;<br>Business Support</b></span></div>
          </div>
        </div>
      </section>

      <section class="pf-tabs-wrap">
        <div class="detail-tabs" role="tablist">
          <a class="tab-active" role="tab" data-tab="description-${esc(slug)}" href="#">Description</a>
          <a role="tab" data-tab="specifications-${esc(slug)}" href="#">Specifications</a>
          <a role="tab" data-tab="artwork-${esc(slug)}" href="#">Artwork guidelines</a>
          <a role="tab" data-tab="delivery-${esc(slug)}" href="#">Delivery &amp; returns</a>
        </div>
        <div class="description-panel tab-panel" id="description-${esc(slug)}">
          <p>Our ${esc(p.name.toLowerCase())} are printed using high-quality paper and advanced printing technology to ensure sharp details and a professional finish. Perfect for businesses, freelancers and events.</p>
          <ul class="check-grid">
            <li>${tick}High-quality printing</li><li>${tick}Ideal for business branding</li><li>${tick}Multiple paper types and finishes</li>
            <li>${tick}Fast production and delivery</li><li>${tick}Custom sizes available</li><li>${tick}Option for professional design support</li>
          </ul>
        </div>
        <div class="specs tab-panel" id="specifications-${esc(slug)}" hidden>
          <h2>Specifications</h2>
          <p><b>Category:</b> ${[n1 && n1.label, t.l2, t.l3].filter(Boolean).map(esc).join(' › ')}</p>
          <p><b>Available sizes:</b> ${sizes.map(esc).join(', ')}</p>
          <p><b>Quantity range:</b> ${esc(p.qtyRange || 'varies by option')}</p>
        </div>
        <div class="specs tab-panel" id="artwork-${esc(slug)}" hidden>
          <h2>Artwork guidelines</h2>
          <p>Upload-ready PDF recommended (AI, PSD, PNG and JPG also accepted). Use CMYK color mode for accurate print colors — RGB files will be auto-converted and may shift slightly. Add a 3mm bleed on any edge-to-edge design, and keep key text and logos at least 3mm inside the trim edge.</p>
          <p>No design file? Request a quote and ask for design support — our team will create one for a quoted fee.</p>
        </div>
        <div class="specs tab-panel" id="delivery-${esc(slug)}" hidden>
          <h2>Delivery &amp; returns</h2>
          <p><b>Production time:</b> Dispatched within 3 business days of artwork approval and payment confirmation (longer for bulk/custom orders — the exact timeline is confirmed at checkout).</p>
          <p><b>Shipping:</b> Pan-India delivery via our logistics partners; tracking details are shared once your order ships.</p>
          <p><b>Returns &amp; reprints:</b> Since every order is printed to your specification, we don't accept returns for correct, as-approved orders. If there's a genuine print-quality defect or production error on our side, we reprint or refund at no extra cost.</p>
        </div>
      </section>

      ${related.length ? `<section class="pf-related"><h2>You may also like</h2><div class="pf-grid">${related.map(pfCard).join('')}</div></section>` : ''}
    </main>
    <section class="quote-strip"><div class="wrap">
      <div><h2>Need a custom quote?</h2><p>Have a large order or special requirement? Tell us what you need.</p></div>
      <a class="button button-light" href="#quote" data-link>Request a Custom Quote →</a>
    </div></section>
    <div class="pf-buybar" role="region" aria-label="Order summary"><div><small>Total incl. GST</small><b id="pfBarTotal">—</b></div><button type="button" class="button" id="pfBarAdd">Add to cart</button></div>`;

  document.querySelectorAll('.detail-tabs a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.detail-tabs a').forEach(x => x.classList.remove('tab-active'));
      a.classList.add('tab-active');
      const target = a.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(panel => { panel.hidden = panel.id !== target; });
    });
  });
  document.getElementById('pfBarAdd').addEventListener('click', () => document.getElementById('addCartBtn').click());
  const cm = document.getElementById('cartMsg');
  new MutationObserver(() => { if (cm.textContent) notify(cm.textContent); }).observe(cm, { childList: true, characterData: true, subtree: true });
  PDP.slug = slug;
  populateSizes(slug);
}

/* Boot: runs once, after index.html's inline script has defined its globals. */
initChrome();
