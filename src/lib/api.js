import { supabase } from './supabase.js';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return body;
}

export async function getTodaysPicks(buyerToken) {
  const headers = await authHeaders();
  const query = buyerToken ? `?buyer_token=${encodeURIComponent(buyerToken)}` : '';
  return request(`/picks/today${query}`, { headers });
}

export async function getCurrentUser() {
  const headers = await authHeaders();
  return request('/user/me', { headers });
}

export async function addPick(pick, adminSecret) {
  return request('/admin/picks', {
    method: 'POST',
    headers: { 'x-admin-secret': adminSecret },
    body: JSON.stringify(pick),
  });
}

export async function deletePick(id, adminSecret) {
  return request(`/admin/picks/${id}`, {
    method: 'DELETE',
    headers: { 'x-admin-secret': adminSecret },
  });
}

export async function listAllPicks(adminSecret) {
  return request('/admin/picks', {
    headers: { 'x-admin-secret': adminSecret },
  });
}

export async function checkoutPick(pickId, buyerToken) {
  return request('/checkout/pick', {
    method: 'POST',
    body: JSON.stringify({ pick_id: pickId, buyer_token: buyerToken }),
  });
}

export async function checkoutBundle(pickIds, buyerToken) {
  return request('/checkout/bundle', {
    method: 'POST',
    body: JSON.stringify({ pick_ids: pickIds, buyer_token: buyerToken }),
  });
}

export async function confirmCheckout(sessionId, buyerToken) {
  return request(
    `/checkout/confirm?session_id=${encodeURIComponent(sessionId)}&buyer_token=${encodeURIComponent(buyerToken)}`
  );
}

export async function trackSource(buyerToken, source) {
  return request('/track-source', {
    method: 'POST',
    body: JSON.stringify({ buyer_token: buyerToken, source }),
  });
}
