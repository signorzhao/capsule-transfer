const API_BASE = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5005') + '/api';

async function jsonFetch(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      headers,
      signal: fetchOptions.signal || controller?.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('请求超时，请确认 REAPER 和 Bridge 正在响应后重试。');
    }
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    body = { success: false, error: `HTTP ${resp.status}` };
  }
  if (!resp.ok || body.success === false) {
    const msg = body?.error || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  base: API_BASE,
  health: () => jsonFetch('/health'),
  network: () => jsonFetch('/network/info'),

  listCapsules: (q) =>
    jsonFetch(`/capsules${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getCapsule: (id) => jsonFetch(`/capsules/${id}`),
  deleteCapsule: (id) => jsonFetch(`/capsules/${id}`, { method: 'DELETE' }),
  renameCapsule: (id, name) =>
    jsonFetch(`/capsules/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  previewUrl: (id) => `${API_BASE}/capsules/${id}/preview`,
  openRpp: (id) => jsonFetch(`/capsules/${id}/open-rpp`, { method: 'POST' }),
  openFolder: (id) => jsonFetch(`/capsules/${id}/open-folder`, { method: 'POST' }),

  listContacts: () => jsonFetch('/contacts'),
  addContact: (payload) =>
    jsonFetch('/contacts', { method: 'POST', body: JSON.stringify(payload) }),
  deleteContact: (id) => jsonFetch(`/contacts/${id}`, { method: 'DELETE' }),
  pingContact: (payload) =>
    jsonFetch('/contacts/ping', { method: 'POST', body: JSON.stringify(payload) }),

  send: (payload) =>
    jsonFetch('/p2p/send', { method: 'POST', body: JSON.stringify(payload) }),
  getReceiveMode: () => jsonFetch('/p2p/receive-mode'),
  setReceiveMode: (mode) =>
    jsonFetch('/p2p/receive-mode', { method: 'PATCH', body: JSON.stringify({ mode }) }),
  getPendingRequests: () => jsonFetch('/p2p/pending'),
  acceptRequest: (id) => jsonFetch(`/p2p/accept/${id}`, { method: 'POST' }),
  rejectRequest: (id) => jsonFetch(`/p2p/reject/${id}`, { method: 'POST' }),
  notificationsUrl: `${API_BASE}/events`,

  getReaperBridgeStatus: () => jsonFetch('/reaper/bridge/status', { timeoutMs: 12000 }),
  pingReaperBridge: () => jsonFetch('/reaper/bridge/ping', { method: 'POST' }),
  confirmReaperBridge: (payload = {}) =>
    jsonFetch('/reaper/bridge/confirm', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 15000 }),
  openReaperBridgeScriptFolder: () => jsonFetch('/reaper/bridge/script-folder', { method: 'POST' }),
  identity: () => jsonFetch('/identity'),
  discoverPeers: (payload = {}) =>
    jsonFetch('/peers/discover', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 8000 }),

  getSettings: () => jsonFetch('/settings'),
  updateSettings: (payload) =>
    jsonFetch('/settings', { method: 'PATCH', body: JSON.stringify(payload) }),
};

export async function uploadCapsuleBundle(file, meta = {}) {
  const fd = new FormData();
  fd.append('bundle', file);
  if (meta && Object.keys(meta).length) {
    fd.append('meta', JSON.stringify(meta));
  }
  const resp = await fetch(`${API_BASE}/capsules`, { method: 'POST', body: fd });
  const body = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
  if (!resp.ok || body.success === false) {
    throw new Error(body?.error || `HTTP ${resp.status}`);
  }
  return body;
}
