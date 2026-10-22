/**
 * Print Haus — ERPNext integration (DEPRECATED, do not use)
 * ------------------------------------------------------------
 * This file used to call the ERPNext REST API directly from the browser,
 * storing a real API key + secret in localStorage (pf_erp_config) and
 * sending `Authorization: token <key>:<secret>` from the page itself.
 * Anyone with devtools access to that browser — or any XSS on the page —
 * could read those credentials straight out of localStorage.
 *
 * ERPNext sync now happens server-side in src/worker.js instead
 * (erpConfigured() / erpCreateQuotation() / erpCreateSalesOrder()), using
 * three Worker secrets the browser never sees:
 *   wrangler secret put ERPNEXT_BASE_URL
 *   wrangler secret put ERPNEXT_API_KEY
 *   wrangler secret put ERPNEXT_API_SECRET
 *
 * This file is no longer loaded by index.html and intentionally left empty
 * of any request logic — kept only so an old reference to the file 404s
 * cleanly instead of silently reintroducing the client-side credential
 * pattern if someone copies code from here.
 */
(function (global) {
  'use strict';
  global.PFErp = {
    configure() { throw new Error('PFErp is deprecated — ERPNext sync is now server-side. See the comment at the top of this file.'); },
    isConfigured() { return false; }
  };
})(window);
