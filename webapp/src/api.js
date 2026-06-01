const API_BASE = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5005') + '/api';

function isPrivateLanHost(value) {
  if (!value) return false;
  const host = String(value).trim().toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;

  const match = host.match(/^172\.(\d+)\./);
  if (match) {
    const n = Number(match[1]);
    return n >= 16 && n <= 31;
  }

  return false;
}

function normalizeNetworkInfo(payload) {
  const info = payload?.data || payload || {};
  const urlHost = (() => {
    try {
      return new URL(API_BASE).hostname;
    } catch {
      return '';
    }
  })();

  const ip = info.ip || info.local_ip || info.host_ip || '';
  const port = Number(info.port || info.local_port || 5005);
  const allowedForLanMode = Boolean(
    info.allowed_for_lan_mode ??
    info.is_private_lan ??
    isPrivateLanHost(ip) ||
    isPrivateLanHost(urlHost)
  );

  return {
    ...info,
    ip,
    port,
    hostname: info.hostname || info.host || '',
    peer_id: info.peer_id || info.peerId || info.peer?.id || '',
    peer_fingerprint: info.peer_fingerprint || info.peerFingerprint || info.peer?.fingerprint || '',
    is_private_lan: Boolean(info.is_private_lan ?? allowedForLanMode),
    allowed_for_lan_mode: allowedForLanMode,
  };
}

async function jsonFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
  network: async () => {
    const body = await jsonFetch('/network/info');
    return { ...body, data: normalizeNetworkInfo(body) };
  },

  listCapsules: (q) =>
    jsonFetch(`/capsules${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getCapsule: (id) => jsonFetch(`/capsules/${id}`),
  deleteCapsule: (id) => jsonFetch(`/capsules/${id}`, { method: 'DELETE' }),
  renameCapsule: (id, name) =>
    jsonFetch(`/capsules/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  previewUrl: (id) => `${API_BASE}/capsules/${id}/preview`,
  openRpp: (id) => jsonFetch(`/capsules/${id}/open-rpp`, { method: 'POST' }),

  listContacts: () => jsonFetch('/contacts'),
  addContact: (payload) =>
    jsonFetch('/contacts', { method: 'POST', body: JSON.stringify(payload) }),
  deleteContact: (id) => jsonFetch(`/contacts/${id}`, { method: 'DELETE' }),
  pingContact: (payload) =>
    jsonFetch('/contacts/ping', { method: 'POST', body: JSON.stringify(payload) }),

  send: (payload) =>
    jsonFetch('/p2p/send', { method: 'POST', body: JSON.stringify(payload) }),

  // 接收模式
  getReceiveMode: () => jsonFetch('/p2p/receive-mode'),
  setReceiveMode: (mode) =>
    jsonFetch('/p2p/receive-mode', { method: 'PATCH', body: JSON.stringify({ mode }) }),
  getPendingRequests: () => jsonFetch('/p2p/pending'),
  acceptRequest: (id) => jsonFetch(`/p2p/accept/${id}`, { method: 'POST' }),
  rejectRequest: (id) => jsonFetch(`/p2p/reject/${id}`, { method: 'POST' }),

  // SSE 通知 URL
  notificationsUrl: `${API_BASE}/p2p/notifications`,

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
