/**
 * Print Haus — ERPNext integration layer
 * -----------------------------------------
 * Thin REST client for ERPNext/Frappe. Talks to a real ERPNext instance when
 * configured; otherwise every function falls back to the existing
 * localStorage-based prototype storage so the site keeps working with no
 * backend at all.
 *
 * SETUP (once you have a running ERPNext instance — e.g. Frappe Cloud, a
 * VPS, or Docker):
 *   1. In ERPNext: Settings → API Access → generate an API Key + Secret for
 *      an integration user (give it Create/Read/Write on Quotation,
 *      Sales Order, Item, BOM — not an Administrator login).
 *   2. Open the browser console on this site once and run:
 *        PFErp.configure({
 *          baseUrl: 'https://your-site.frappe.cloud',
 *          apiKey: 'xxxxxxxx',
 *          apiSecret: 'xxxxxxxx'
 *        });
 *      This is stored in localStorage (pf_erp_config) for this browser only.
 *      For a real production deploy, proxy these calls through a small
 *      server-side function instead of shipping the API secret to the
 *      browser — see "Security note" at the bottom of this file.
 *   3. Reload. Quote submissions and checkout orders will now also be
 *      created as real ERPNext documents. If step 2 is skipped, nothing
 *      changes — the site behaves exactly as it did before.
 *
 * ERPNext REST conventions used here (standard Frappe REST API):
 *   GET    /api/resource/<Doctype>
 *   POST   /api/resource/<Doctype>                body = {..fields..}
 *   GET    /api/resource/<Doctype>/<name>
 *   PUT    /api/resource/<Doctype>/<name>          body = {..fields..}
 *   Auth header: Authorization: token <api_key>:<api_secret>
 */

(function (global) {
  'use strict';

  const CONFIG_KEY = 'pf_erp_config';

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
    } catch (e) {
      return null;
    }
  }

  function configure(cfg) {
    // cfg: { baseUrl, apiKey, apiSecret }
    if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.apiSecret) {
      throw new Error('PFErp.configure needs { baseUrl, apiKey, apiSecret }');
    }
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret
    }));
    return true;
  }

  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c && c.baseUrl && c.apiKey && c.apiSecret);
  }

  async function request(method, path, body) {
    const cfg = getConfig();
    if (!cfg) throw new Error('ERPNext not configured — call PFErp.configure() first.');
    const res = await fetch(cfg.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'token ' + cfg.apiKey + ':' + cfg.apiSecret
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && (json.exception || json._server_messages)) || res.statusText;
      throw new Error('ERPNext API error (' + res.status + '): ' + msg);
    }
    return json;
  }

  // ---------- Quotations (customer quote requests) ----------
  // Maps the site's quote-form fields onto ERPNext's Quotation doctype.
  // ERPNext's Quotation needs a linked Customer/Lead; since the site collects
  // a name/email/company rather than a pre-existing CRM contact, we send the
  // contact details inside custom fields and the free-text message as the
  // quotation's "order_type"/"tc_name" notes equivalent (terms). If your
  // ERPNext has Lead creation enabled, consider creating/linking a Lead
  // first — left as a documented extension point, not required to start.
  async function createQuotation(q) {
    const payload = {
      doctype: 'Quotation',
      quotation_to: 'Customer',
      // Falls back to a generic "Website Visitor" customer name; create that
      // Customer record once in ERPNext, or adapt this to your own flow.
      party_name: q.company || q.name,
      customer_name: q.name,
      contact_email: q.email,
      contact_mobile: q.whatsapp || '',
      // Custom fields — create these as Small Text / Data fields on
      // Quotation in ERPNext (Customize Form) before going live:
      custom_department: q.department || '',
      custom_related_order: q.orderNumber || '',
      custom_product_of_interest: q.product || '',
      custom_message: q.message || '',
      items: q.product ? [{ item_code: q.product, qty: 1 }] : []
    };
    return request('POST', '/api/resource/Quotation', payload);
  }

  // ---------- Sales Orders / Job Orders (checkout) ----------
  // ERPNext doesn't have a separate "Job Order" doctype out of the box for
  // print-shop work orders — the standard pattern is:
  //   Sales Order (customer-facing order) -> Work Order (production/BOM-driven
  //   job) created from it. We create the Sales Order here; triggering the
  //   Work Order is a server-side ERPNext workflow (or a Frappe automation)
  //   you set up once in ERPNext, not something the browser should do
  //   directly against production data.
  async function createSalesOrder(order, cartItems) {
    const items = cartItems.map((i) => ({
      item_code: i.slug,
      item_name: i.name,
      description: [i.size, i.opt].filter(Boolean).join(' · '),
      qty: i.qty,
      rate: i.unit
    }));
    const payload = {
      doctype: 'Sales Order',
      customer: order.customer,
      contact_email: order.email,
      custom_phone: order.phone,
      custom_delivery_address: order.address,
      custom_order_notes: order.notes || '',
      delivery_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      items
    };
    return request('POST', '/api/resource/Sales Order', payload);
  }

  // ---------- BOM / costing lookup ----------
  // Pulls a product's Bill of Materials from ERPNext so the storefront can
  // show (or an admin can check) real production costing per item, rather
  // than only the static calc-data.json price table.
  async function getItemCosting(itemCode) {
    const bomList = await request(
      'GET',
      '/api/resource/BOM?filters=' +
        encodeURIComponent(JSON.stringify([['item', '=', itemCode], ['is_active', '=', 1]])) +
        '&fields=' + encodeURIComponent(JSON.stringify(['name', 'total_cost', 'quantity']))
    );
    if (!bomList.data || !bomList.data.length) return null;
    const bomName = bomList.data[0].name;
    return request('GET', '/api/resource/BOM/' + encodeURIComponent(bomName));
  }

  // ---------- Combined helpers used by index.html ----------
  // Each of these tries ERPNext first (if configured) and never throws past
  // this point — a failed/unconfigured ERPNext call is logged to console and
  // the caller's localStorage fallback (already in index.html) proceeds
  // exactly as it did before this file existed.
  async function trySubmitQuote(q) {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    try {
      const res = await createQuotation(q);
      return { ok: true, erpName: res.data && res.data.name };
    } catch (e) {
      console.warn('[PFErp] Quotation create failed, saved locally only:', e.message);
      return { ok: false, reason: e.message };
    }
  }

  async function trySubmitOrder(order, cartItems) {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    try {
      const res = await createSalesOrder(order, cartItems);
      return { ok: true, erpName: res.data && res.data.name };
    } catch (e) {
      console.warn('[PFErp] Sales Order create failed, saved locally only:', e.message);
      return { ok: false, reason: e.message };
    }
  }

  global.PFErp = {
    configure,
    clearConfig,
    isConfigured,
    createQuotation,
    createSalesOrder,
    getItemCosting,
    trySubmitQuote,
    trySubmitOrder
  };
})(window);

/**
 * Security note
 * -------------
 * This file calls the ERPNext REST API directly from the browser using an
 * API key + secret stored in that browser's localStorage. That's fine for
 * development/demo or an internal tool, but for a public storefront it means
 * every visitor's browser would need its own scoped credential, and anyone
 * could read the key/secret from localStorage or devtools.
 *
 * For production, replace the direct `fetch` calls in `request()` with calls
 * to a small server-side proxy (a Cloudflare Worker route, e.g. POST
 * /api/quote and /api/order) that holds the real ERPNext API key/secret as a
 * server-side secret and forwards the request. The browser-facing shape of
 * PFErp.trySubmitQuote / trySubmitOrder stays identical either way — only
 * `request()`'s target URL and auth changes.
 */
