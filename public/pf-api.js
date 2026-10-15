/**
 * Print Haus — backend API client
 * ---------------------------------
 * Talks to the Cloudflare Worker (src/worker.js) backed by D1, for
 * accounts, orders, and quotes. Replaces the old localStorage-only
 * prototype storage in index.html.
 *
 * Same-origin by default (the Worker serves both the static site and
 * /api/* routes), so no base URL configuration is needed when deployed
 * via `wrangler deploy`. The session token is still kept in localStorage
 * (pf_token) — only the account/order/quote DATA moved server-side.
 */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'pf_token';
  const USER_KEY = 'pf_user_cache'; // small cached copy of {name,email} for instant UI, re-synced from /api/me

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function getCachedUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; } }
  function setCachedUser(u) { try { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY); } catch (e) {} }

  async function call(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  // ---------- Session (sync wrapper kept for drop-in compatibility) ----------
  // index.html's render functions read the session synchronously in many
  // places; we keep a small cached {name,email} in localStorage updated on
  // every login/signup/logout so `getSession()` stays a cheap sync call,
  // while the real source of truth is the server-side token.
  function getSession() {
    return getToken() ? getCachedUser() : null;
  }

  async function signup(name, email, password) {
    const data = await call('/api/signup', { method: 'POST', body: { name, email, password } });
    setToken(data.token);
    setCachedUser(data.user);
    return data.user;
  }

  async function login(email, password) {
    const data = await call('/api/login', { method: 'POST', body: { email, password } });
    setToken(data.token);
    setCachedUser(data.user);
    return data.user;
  }

  async function logout() {
    try { await call('/api/logout', { method: 'POST' }); } catch (e) {}
    setToken(null);
    setCachedUser(null);
  }

  // ---------- Orders ----------
  async function placeOrder(order) {
    return call('/api/orders', { method: 'POST', body: order });
  }

  async function fetchOrders() {
    const data = await call('/api/orders');
    return data.orders.map((o) => ({
      id: o.id,
      email: getCachedUser() ? getCachedUser().email : '',
      customer: o.customer,
      phone: o.phone,
      address: o.address,
      note: o.note,
      total: o.total,
      status: o.status,
      createdAt: o.created_at,
      items: o.items.map((i) => ({ slug: i.slug, name: i.name, size: i.size, opt: i.opt, qty: i.qty, unit: i.unit_price }))
    }));
  }

  // ---------- Quotes ----------
  async function submitQuote(q) {
    return call('/api/quotes', { method: 'POST', body: q });
  }

  // ---------- Admin ----------
  const ADMIN_KEY_STORAGE = 'pf_admin_key';
  function getAdminKey() { try { return sessionStorage.getItem(ADMIN_KEY_STORAGE); } catch (e) { return null; } }
  function setAdminKey(k) { try { k ? sessionStorage.setItem(ADMIN_KEY_STORAGE, k) : sessionStorage.removeItem(ADMIN_KEY_STORAGE); } catch (e) {} }

  async function adminCall(path, opts = {}) {
    const key = getAdminKey();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (key) headers['X-Admin-Key'] = key;
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  async function adminFetchOrders() {
    const data = await adminCall('/api/admin/orders');
    return data.orders.map((o) => ({
      id: o.id, customer: o.customer, email: '', phone: o.phone, address: o.address,
      total: o.total, status: o.status, createdAt: o.created_at,
      items: new Array(1) // item count unknown without a join; dashboard only needs a rough count — see note in index.html admin rewire
    }));
  }

  async function adminFetchQuotes() {
    const data = await adminCall('/api/admin/quotes');
    return data.quotes;
  }

  async function adminSetOrderStatus(id, status) {
    return adminCall('/api/admin/orders/' + encodeURIComponent(id), { method: 'PATCH', body: { status } });
  }

  async function adminSetQuoteStatus(id, status) {
    return adminCall('/api/admin/quotes/' + encodeURIComponent(id), { method: 'PATCH', body: { status } });
  }

  // ---------- Job orders (production tracking) ----------
  async function adminFetchJobOrders() {
    const data = await adminCall('/api/admin/job-orders');
    return data.jobOrders;
  }

  async function adminCreateJobOrder(job) {
    return adminCall('/api/admin/job-orders', { method: 'POST', body: job });
  }

  async function adminUpdateJobOrder(id, patch) {
    return adminCall('/api/admin/job-orders/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
  }

  async function adminFetchJobOrderEvents(id) {
    const data = await adminCall('/api/admin/job-orders/' + encodeURIComponent(id) + '/events');
    return data.events;
  }

  global.PFApi = {
    getSession, signup, login, logout,
    placeOrder, fetchOrders,
    submitQuote,
    getAdminKey, setAdminKey,
    adminFetchOrders, adminFetchQuotes, adminSetOrderStatus, adminSetQuoteStatus,
    adminFetchJobOrders, adminCreateJobOrder, adminUpdateJobOrder, adminFetchJobOrderEvents
  };
})(window);
