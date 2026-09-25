import { supabase } from './supabase.js';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export function affiliateGoUrl(pickId, buyerToken) {
  const params = new URLSearchParams({ pick_id: pickId, buyer_token: buyerToken || '' });
  return `${BASE_URL}/go/affiliate?${params.toString()}`;
}

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
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
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

export async function addPick(pick) {
  const headers = await authHeaders();
  return request('/admin/picks', {
    method: 'POST',
    headers,
    body: JSON.stringify(pick),
  });
}

export async function getFunnel() {
  const headers = await authHeaders();
  return request('/admin/funnel', { headers });
}

export async function getPipelineStatus() {
  const headers = await authHeaders();
  return request('/admin/pipeline-status', { headers });
}

export async function getDiscoveredCandidates() {
  const headers = await authHeaders();
  return request('/admin/discovered-candidates', { headers });
}

export async function dismissCandidate(id) {
  const headers = await authHeaders();
  return request(`/admin/discovered-candidates/${id}/dismiss`, {
    method: 'POST',
    headers,
  });
}

export async function verifySlot(slot) {
  const headers = await authHeaders();
  return request('/admin/verify-slot', {
    method: 'POST',
    headers,
    body: JSON.stringify({ slot }),
  });
}

export async function deletePick(id) {
  const headers = await authHeaders();
  return request(`/admin/picks/${id}`, {
    method: 'DELETE',
    headers,
  });
}

export async function listAllPicks() {
  const headers = await authHeaders();
  return request('/admin/picks', { headers });
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

export async function subscribeEmail(email, buyerToken, source) {
  return request('/subscribe', {
    method: 'POST',
    body: JSON.stringify({ email, buyer_token: buyerToken, source }),
  });
}

export async function sendTestEmail() {
  const headers = await authHeaders();
  return request('/admin/test-email', { method: 'POST', headers });
}

export async function getRecord() {
  return request('/record');
}

export async function gradeNow() {
  const headers = await authHeaders();
  return request('/admin/grade', { method: 'POST', headers });
}

export async function getRecapPreview() {
  const headers = await authHeaders();
  return request('/admin/recap-preview', { headers });
}

export async function sendRecapTestEmail() {
  const headers = await authHeaders();
  return request('/admin/recap-test-email', { method: 'POST', headers });
}

export async function postRecapNow() {
  const headers = await authHeaders();
  return request('/admin/recap', { method: 'POST', headers });
}
