let API_BASE = (import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5005') + '/api';
let apiInitialization = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBackendReady(apiBase, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${apiBase}/health`, { cache: 'no-store' });
      if (resp.ok) return;
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`Backend did not become ready: ${lastError?.message || 'timeout'}`);
}

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
  const detectedLan = isPrivateLanHost(ip) || isPrivateLanHost(urlHost);
  const allowedForLanMode = Boolean(
    info.allowed_for_lan_mode ?? info.is_private_lan ?? detectedLan
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

async function tauriInvoke(command, args = {}) {
  if (!window.__TAURI_INTERNALS__) {
    throw new Error('Automatic updates are available only in the desktop app.');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke(command, args);
  } catch (error) {
    if (error instanceof Error) throw error;
    if (typeof error === 'string') throw new Error(error);
    let message;
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
    throw new Error(message || String(error));
  }
}

export async function initializeApi() {
  if (apiInitialization) return apiInitialization;
  apiInitialization = (async () => {
    if (!window.__TAURI_INTERNALS__) return API_BASE;
    const base = await tauriInvoke('backend_api_base');
    API_BASE = `${String(base).replace(/\/+$/, '')}/api`;
    await waitForBackendReady(API_BASE);
    return API_BASE;
  })().catch((error) => {
    apiInitialization = null;
    throw error;
  });
  return apiInitialization;
}

async function jsonFetch(path, options = {}) {
  await initializeApi();
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
      throw new Error('The request timed out. Confirm that REAPER and Bridge are responding, then try again.');
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
  get base() { return API_BASE; },
  initialize: initializeApi,
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
  openFolder: (id) => jsonFetch(`/capsules/${id}/open-folder`, { method: 'POST' }),
  listCapsuleFolders: () => jsonFetch('/capsule-folders'),
  createCapsuleFolder: (name, parentId = null) =>
    jsonFetch('/capsule-folders', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId }) }),
  updateCapsuleFolder: (folderId, payload) =>
    jsonFetch(`/capsule-folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteCapsuleFolder: (folderId) =>
    jsonFetch(`/capsule-folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }),
  addCapsuleToFolder: (folderId, capsuleId) =>
    jsonFetch(`/capsule-folders/${encodeURIComponent(folderId)}/capsules`, { method: 'POST', body: JSON.stringify({ capsule_id: capsuleId }) }),
  removeCapsuleFromFolder: (folderId, capsuleId) =>
    jsonFetch(`/capsule-folders/${encodeURIComponent(folderId)}/capsules/${encodeURIComponent(capsuleId)}`, { method: 'DELETE' }),

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
  get notificationsUrl() { return `${API_BASE}/events`; },

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

  checkUpdate: () => tauriInvoke('check_update'),
  getCurrentVersion: () => tauriInvoke('current_version'),
  downloadUpdate: (payload) => tauriInvoke('download_update', payload),
  installUpdate: (payload) => tauriInvoke('install_update', payload),
};

export async function uploadCapsuleBundle(file, meta = {}) {
  await initializeApi();
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
