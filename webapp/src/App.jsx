import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Plus,
  Settings,
  Zap,
  FileAudio,
  Package,
  Users,
  UserPlus,
  Trash2,
  Search,
  RefreshCw,
  Copy,
  Play,
  Pause,
  FolderOpen,
  Music,
  Pencil,
  Check,
  X,
  ChevronDown,
  Clock,
  HardDrive,
  Inbox,
  FolderPlus,
  Radio,
  AlertTriangle,
  Shield,
  ShieldOff,
  ShieldCheck,
  Bell,
  Download,
  Volume2,
} from 'lucide-react';
import WaveSurfer from 'wavesurfer.js';
import Timeline from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import Hover from 'wavesurfer.js/dist/plugins/hover.esm.js';

import { ToastProvider, useToast } from './components/Toast.jsx';
import { api } from './api.js';

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function createTaskId() {
  return globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s.endsWith('Z') ? s : `${s}Z`);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString('en-GB', { hour12: false });
  } catch {
    return s;
  }
}

function parseHostPort(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ip: '', port: '' };
  const normalized = raw.replace(/^https?:\/\//i, '');
  const firstPart = normalized.split(/[/?#]/)[0];
  const match = firstPart.match(/^(.+):(\d{1,5})$/);
  if (!match) return { ip: raw, port: '' };
  const portNumber = Number(match[2]);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return { ip: raw, port: '' };
  }
  return { ip: match[1].replace(/^\[|\]$/g, ''), port: String(portNumber) };
}

function CapsuleLanLogo() {
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center shadow-lg shadow-sky-500/20" title="Capsule LAN" aria-label="Capsule LAN">
      <svg viewBox="0 0 40 40" className="w-10 h-10" role="img" aria-hidden="true">
        <defs>
          <linearGradient id="capsule-lan-logo-bg" x1="8" y1="6" x2="31" y2="34" gradientUnits="userSpaceOnUse">
            <stop stopColor="#347b9e" />
            <stop offset="1" stopColor="#245a76" />
          </linearGradient>
          <clipPath id="capsule-lan-logo-pill">
            <rect x="-14.5" y="-5.8" width="29" height="11.6" rx="5.8" />
          </clipPath>
        </defs>
        <circle cx="20" cy="20" r="20" fill="url(#capsule-lan-logo-bg)" />
        <g transform="translate(20 20) rotate(-18)">
          <g clipPath="url(#capsule-lan-logo-pill)">
            <rect x="-14.5" y="-5.8" width="14.5" height="11.6" fill="#dbe7ec" />
            <rect x="0" y="-5.8" width="14.5" height="11.6" fill="#9fb2bc" />
          </g>
          <rect x="-14.5" y="-5.8" width="29" height="11.6" rx="5.8" fill="none" stroke="#dbe7ec" strokeWidth="2.3" />
          <path d="M0 -4.8v9.6" stroke="#dbe7ec" strokeWidth="2" strokeLinecap="round" />
        </g>
      </svg>
    </div>
  );
}

function Shell() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('library');
  const [networkInfo, setNetworkInfo] = useState(null);
  const [appVersion, setAppVersion] = useState('');
  const [serverOnline, setServerOnline] = useState(false);
  const [capsules, setCapsules] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [selectedCapsules, setSelectedCapsules] = useState([]);
  const [targetContacts, setTargetContacts] = useState([]);
  const [tempPeer, setTempPeer] = useState({ ip: '', port: '5005' });
  const [showTempPeerForm, setShowTempPeerForm] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [transferProgress, setTransferProgress] = useState(null);
  const [captureStatus, setCaptureStatus] = useState(null);
  const [receiveMode, setReceiveMode] = useState('confirm');
  const [pendingRequests, setPendingRequests] = useState([]);
  const [showIncoming, setShowIncoming] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [showCaptureDebug, setShowCaptureDebug] = useState(() => localStorage.getItem('capsuleCaptureDebug') === '1');
  const [captureDebugStatus, setCaptureDebugStatus] = useState(null);
  const [captureDebugError, setCaptureDebugError] = useState('');
  const [isCheckingCaptureSetup, setIsCheckingCaptureSetup] = useState(false);
  const [autoReceiveConfirmStep, setAutoReceiveConfirmStep] = useState(0);
  const [isChangingReceiveMode, setIsChangingReceiveMode] = useState(false);
  const setupCheckedRef = useRef(false);
  const lastSetupStateRef = useRef('');

  useEffect(() => {
    if (!import.meta.env.PROD || !window.__TAURI_INTERNALS__) return undefined;
    const preventWebContextMenu = (event) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName));
      if (!isEditable) event.preventDefault();
    };
    document.addEventListener('contextmenu', preventWebContextMenu);
    return () => document.removeEventListener('contextmenu', preventWebContextMenu);
  }, []);

  const captureStepsForPhase = useCallback((phase = '', renderPreview = true) => {
    const lower = String(phase || '').toLowerCase();
    const savingDone = lower.includes('rendering preview') || lower.includes('saving capsule: done');
    const rendering = lower.includes('rendering preview: starting');
    const renderDone = lower.includes('rendering preview: finished');
    const renderSkipped = lower.includes('rendering preview: skipped') || !renderPreview;
    return [
      {
        id: 'save',
        label: 'Save Capsule',
        status: savingDone || rendering || renderDone ? 'done' : 'active',
        detail: savingDone || rendering || renderDone ? 'Capsule package saved.' : 'Exporting RPP, audio, and metadata.',
      },
      {
        id: 'preview',
        label: 'Render Preview',
        status: !renderPreview ? 'skipped' : renderDone ? 'done' : renderSkipped ? 'skipped' : rendering ? 'active' : 'pending',
        detail: !renderPreview
          ? 'No preview was requested.'
          : renderDone
            ? 'Preview render completed. Writing results.'
            : renderSkipped
              ? 'Preview render skipped.'
              : rendering
                ? 'Rendering the preview from the capsule RPP.'
                : 'Waiting for the capsule package to finish saving.',
      },
    ];
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const net = await api.network();
      setNetworkInfo(net.data);
      setServerOnline(true);
    } catch {
      setServerOnline(false);
    }
    try {
      const lib = await api.listCapsules();
      setCapsules(lib.data?.items || []);
    } catch (e) {
      toast.error(`Failed to load the capsule library: ${e.message}`);
    }
    try {
      const cs = await api.listContacts();
      setContacts(cs.data?.items || []);
    } catch (e) {
      toast.error(`Failed to load contacts: ${e.message}`);
    }
  }, [toast]);

  const refreshBridgeStatus = useCallback(async () => {
    try {
      const r = await api.getReaperBridgeStatus();
      setBridgeStatus(r.data);
      return r.data;
    } catch (e) {
      const fallback = { setup_state: 'NEED_WEBUI', webui_available: false, bridge_available: false, error: e.message, setup_message: e.message };
      setBridgeStatus(fallback);
      return fallback;
    }
  }, []);

  const refreshCaptureDebug = useCallback(async () => {
    try {
      const r = await api.getReaperBridgeStatus({ diagnostics: true });
      setCaptureDebugStatus(r.data);
      setCaptureDebugError('');
      return r.data;
    } catch (e) {
      setCaptureDebugError(e.message);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 15000);
    return () => clearInterval(t);
  }, [refreshAll]);

  useEffect(() => {
    api.getReceiveMode().then((r) => setReceiveMode(r.data?.mode || 'confirm')).catch(() => {});
  }, []);

  useEffect(() => {
    api.getCurrentVersion()
      .then((info) => setAppVersion(info?.version || ''))
      .catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem('capsuleCaptureDebug', showCaptureDebug ? '1' : '0');
    if (!showCaptureDebug) return undefined;
    let alive = true;
    let timeoutId = null;
    const captureBusy = captureStatus && !['done', 'error'].includes(captureStatus.phase);
    const poll = async () => {
      if (!alive) return;
      if (!captureBusy) await refreshCaptureDebug();
      if (alive) timeoutId = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      alive = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [showCaptureDebug, captureStatus, refreshCaptureDebug]);

  useEffect(() => {
    let alive = true;
    const captureBusy = captureStatus && !['done', 'error'].includes(captureStatus.phase);
    const checkSetup = async () => {
      if (captureBusy) return;
      const status = await refreshBridgeStatus();
      if (!alive) return;
      const state = status?.setup_state || '';
      const shouldAutoOpen = ['NOT_CONFIGURED', 'MISMATCHED_REAPER', 'NEED_REPAIR'].includes(state)
        || (state === 'NEED_BRIDGE_INSTALL' && !status?.confirmed_reaper_resource_path);
      if (!setupCheckedRef.current) {
        setupCheckedRef.current = true;
        if (!captureBusy && shouldAutoOpen) setShowSetupWizard(true);
      } else if (!captureBusy && lastSetupStateRef.current === 'READY' && shouldAutoOpen) {
        setShowSetupWizard(true);
      }
      lastSetupStateRef.current = state;
    };
    checkSetup();
    const t = setInterval(checkSetup, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshBridgeStatus, captureStatus]);

  useEffect(() => {
    let es = null;
    let cancelled = false;
    api.initialize().then(() => {
      if (cancelled) return;
      es = new EventSource(api.notificationsUrl);
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'transfer_request') {
            setPendingRequests((prev) => {
              if (prev.find((req) => req.id === data.request.id)) return prev;
              return [...prev, data.request];
            });
            setShowIncoming(true);
            toast.info(`${data.request.sender_name} requested to send "${data.request.capsule_name}"`);
          } else if (data.type === 'capsule_received') {
            toast.success(`New capsule received: ${data.capsule?.name || 'Capsule'}`);
            refreshAll();
          } else if (data.type === 'transfer_progress') {
            setTransferProgress((prev) => {
              if (data.direction === 'send' && prev?.task_id && data.task_id && prev.task_id !== data.task_id) return prev;
              if (data.direction === 'receive' && prev?.direction === 'send' && !['completed', 'error'].includes(prev.phase)) return prev;
              return { ...(prev || {}), ...data, updated_at: Date.now() };
            });
          }
        } catch {
          // Ignore malformed keepalive/event payloads.
        }
      };
      es.onerror = () => {};
    }).catch(() => {});
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [refreshAll, toast]);

  useEffect(() => {
    if (receiveMode !== 'confirm') return undefined;
    const poll = () => api.getPendingRequests().then((r) => {
      const items = r.data?.items || [];
      if (items.length > 0) {
        setPendingRequests(items);
        setShowIncoming(true);
      }
    }).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [receiveMode]);

  const handleSelectCapsuleForSend = (cap) => {
    setSelectedCapsules((prev) => {
      if (prev.some((item) => item.id === cap.id)) {
        toast.info(`"${cap.name}" is already in the transfer list.`);
        return prev;
      }
      toast.success(`Added "${cap.name}" to the transfer list.`);
      return [...prev, cap];
    });
  };

  const handleRequestCreateCapsule = async () => {
    if (isCheckingCaptureSetup) return false;
    setIsCheckingCaptureSetup(true);
    try {
      const status = await refreshBridgeStatus();
      if (status?.setup_state !== 'READY') {
        if (status?.setup_state !== 'NEED_WEBUI') setShowSetupWizard(true);
        toast.info(status?.setup_message || 'Complete the REAPER setup first.');
        return false;
      }
      if (status?.selected_item_count !== null && status?.selected_item_count !== undefined && Number(status.selected_item_count) <= 0) {
        toast.error('Select the items to capture in REAPER first.');
        return false;
      }
      return true;
    } finally {
      setIsCheckingCaptureSetup(false);
    }
  };

  const handleStartTransferTo = (contact) => {
    setTargetContacts((prev) => (prev.find((c) => c.id === contact.id) ? prev : [...prev, contact]));
    setActiveTab('transfer');
  };

  const handleSend = async () => {
    if (selectedCapsules.length === 0) return toast.error('Select at least one capsule to send.');
    const peers = [...targetContacts];
    if (tempPeer.ip) peers.push({ name: tempPeer.ip, ip: tempPeer.ip, port: Number(tempPeer.port) || 5005 });
    if (peers.length === 0) return toast.error('Select a device or enter a temporary IP.');

    setIsSending(true);
    let successCount = 0;
    let taskIndex = 0;
    const totalTasks = selectedCapsules.length * peers.length;
    for (const cap of selectedCapsules) {
      for (const peer of peers) {
        taskIndex += 1;
        const taskId = createTaskId();
        const peerName = peer.name || peer.last_ip || peer.ip;
        setTransferProgress({
          direction: 'send',
          task_id: taskId,
          capsule_id: cap.uuid || cap.id,
          capsule_name: cap.name,
          peer_name: peerName,
          phase: 'preparing',
          progress: null,
          task_index: taskIndex,
          task_total: totalTasks,
          bytes_transferred: 0,
          total_bytes: 0,
        });
        try {
          await api.send({
            task_id: taskId,
            capsule_id: cap.uuid || cap.id,
            contact_id: peer.id,
            target_peer_id: peer.peer_id,
            target_public_key: peer.public_key,
            target_ip: peer.last_ip || peer.ip,
            target_port: peer.last_port || peer.port,
            target_name: peer.name,
          });
          successCount += 1;
          setTransferProgress((prev) => ({
            ...(prev || {}),
            phase: 'completed',
            progress: 100,
            task_index: taskIndex,
            task_total: totalTasks,
          }));
        } catch (e) {
          setTransferProgress((prev) => ({
            ...(prev || {}),
            phase: 'error',
            error: e.message,
            task_index: taskIndex,
            task_total: totalTasks,
          }));
          toast.error(`Failed to send "${cap.name}" to ${peer.name}: ${e.message}`);
        }
      }
    }
    if (successCount > 0) toast.success(`Completed ${successCount} transfers`);
    setSelectedCapsules([]);
    setTargetContacts([]);
    setTempPeer({ ip: '', port: '5005' });
    refreshAll();
    setIsSending(false);
  };

  const handleCreateCapsule = async (payload) => {
    const initialSteps = captureStepsForPhase('', payload?.render_preview);
    setCaptureStatus({ phase: 'saving', message: 'Checking REAPER setup...', steps: initialSteps });
    const preflight = await refreshBridgeStatus();
    if (preflight?.setup_state !== 'READY') {
      setCaptureStatus(null);
      if (preflight?.setup_state !== 'NEED_WEBUI') setShowSetupWizard(true);
      toast.error(preflight?.setup_message || 'Complete the REAPER setup first.');
      return false;
    }
    if (preflight?.selected_item_count !== null && preflight?.selected_item_count !== undefined && Number(preflight.selected_item_count) <= 0) {
      setCaptureStatus(null);
      toast.error('Select the items to capture in REAPER first.');
      return false;
    }
    setCaptureStatus({ phase: 'saving', message: 'Connecting to REAPER Bridge...', steps: initialSteps });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), payload?.render_preview ? 150000 : 60000);
    let phasePollId = null;
    let phasePollInFlight = false;
    let renderHintTimeoutId = null;
    let captureActive = true;
    try {
      setCaptureStatus({ phase: 'saving', message: 'Saving the capsule package. REAPER may remain minimized.', steps: initialSteps });
      if (payload?.render_preview) {
        renderHintTimeoutId = setTimeout(() => {
          if (!captureActive) return;
          setCaptureStatus((prev) => {
            if (!captureActive || prev?.phase === 'done' || prev?.phase === 'error') return prev;
            return {
              phase: 'rendering',
              message: 'Capsule package submitted. Rendering preview.',
              steps: [
                { id: 'save', label: 'Save Capsule', status: 'done', detail: 'The capsule package is being added to the library.' },
                { id: 'preview', label: 'Render Preview', status: 'active', detail: 'Rendering the preview from the capsule RPP.' },
              ],
            };
          });
        }, 2500);
      }
      phasePollId = setInterval(async () => {
        if (phasePollInFlight) return;
        phasePollInFlight = true;
        try {
          const status = await api.getReaperCaptureProgress();
          if (!captureActive) return;
          const bridgePhase = status.data?.export_phase || '';
          const bridgeProgress = status.data?.capture_progress || {};
          if (!bridgePhase) return;
          const lower = bridgePhase.toLowerCase();
          if (!lower.includes('saving capsule') && !lower.includes('rendering preview')) return;
          const steps = captureStepsForPhase(bridgePhase, payload?.render_preview);
          const progress = lower.includes('copying media') ? bridgeProgress : {};
          let message = 'Saving the capsule package. REAPER may remain minimized.';
          if (lower.includes('checking selected items')) message = 'Reading the selected REAPER items.';
          else if (lower.includes('copying media')) message = 'Copying source media into the capsule.';
          else if (lower.includes('generating rpp')) message = 'Generating the portable REAPER project.';
          else if (lower.includes('writing metadata')) message = 'Writing capsule metadata and plugin information.';
          else if (lower.includes('rendering preview: preparing')) message = 'Preparing tracks and render settings for the preview.';
          else if (lower.includes('rendering preview: rendering')) message = 'Rendering the preview audio in REAPER.';
          else if (lower.includes('rendering preview')) message = 'Capsule saved. Rendering preview.';
          setCaptureStatus((prev) => {
            if (!captureActive || prev?.phase === 'done' || prev?.phase === 'error') return prev;
            const allDone = (prev?.steps || []).length > 0 && (prev.steps || []).every((step) => step.status === 'done' || step.status === 'skipped');
            if (allDone) return prev;
            const nextPhase = lower.includes('rendering preview') ? 'rendering' : 'saving';
            const next = { phase: nextPhase, message, steps, progress };
            const nextAllDone = steps.length > 0 && steps.every((step) => step.status === 'done' || step.status === 'skipped');
            if (nextAllDone) {
              return { ...next, phase: 'done', settled: true };
            }
            return next;
          });
        } catch {
          // Keep the last visible phase if polling briefly fails.
        } finally {
          phasePollInFlight = false;
        }
      }, 800);
      const resp = await fetch(`${api.base}/capsules/webui-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
      captureActive = false;
      controller.abort();
      if (phasePollId) {
        clearInterval(phasePollId);
        phasePollId = null;
      }
      if (renderHintTimeoutId) {
        clearTimeout(renderHintTimeoutId);
        renderHintTimeoutId = null;
      }
      if (!resp.ok || !body.success) {
        const flags = body.data || {};
        let message = body.error || `HTTP ${resp.status}`;
        if (flags.needs_setup) message = `${message}\n\nComplete the REAPER Setup Wizard.`;
        if (flags.selected_items_required) message = `${message}\n\nReturn to REAPER, select the items to capture, and try again.`;
        if (flags.needs_bridge_install) message = `${message}\n\nInstall REAPER Bridge from Settings.`;
        if (flags.webui_required) message = `${message}\n\nConfirm that REAPER is open and Web Interface is enabled on port 9000.`;
        if (flags.export_phase) message = `${message}\n\nBridge phase: ${flags.export_phase}`;
        if (flags.diagnostics) message = `${message}\n\nDiagnostics: ${flags.diagnostics}`;
        throw new Error(message);
      }

      const imported = body.data?.auto_imported;
      const exportResult = body.data?.export_result || {};
      const previewRequested = Boolean(payload?.render_preview || exportResult.preview_requested);
      const previewRendered = exportResult.preview_rendered === true;
      const previewAudio = exportResult.preview_audio || '';
      const doneSteps = [
        {
          id: 'save',
          label: 'Save Capsule',
          status: imported && imported.length > 0 ? 'done' : 'warning',
          detail: imported && imported.length > 0 ? 'Capsule package saved and added to the library.' : 'Export completed, but the capsule was not added automatically.',
        },
        {
          id: 'preview',
          label: 'Render Preview',
          status: !previewRequested ? 'skipped' : previewRendered ? 'done' : 'skipped',
          detail: !previewRequested
            ? 'No preview was requested.'
            : previewRendered
              ? `Preview generated${previewAudio ? `: ${previewAudio}` : '.'}`
              : (exportResult.preview_note || 'Preview was not generated; the capsule package is unaffected.'),
        },
      ];
      if (imported && imported.length > 0) {
        const previewLine = previewRequested
          ? (previewRendered ? 'Preview file generated.' : 'Preview file was not generated. The capsule was saved.')
          : 'No preview file was requested.';
        setCaptureStatus((prev) => ({ phase: 'done', message: `Capture complete: ${imported[0].name}\n${previewLine}`, steps: doneSteps, settled: true, previousPhase: prev?.phase }));
        toast.success(`Captured from REAPER: ${imported[0].name}`);
      } else {
        setCaptureStatus((prev) => ({ phase: 'done', message: 'REAPER export completed, but automatic import failed. Check the export folder.', steps: doneSteps, settled: true, previousPhase: prev?.phase }));
      }
      refreshAll();
    } catch (e) {
      const message = e.name === 'AbortError'
        ? 'REAPER Bridge did not respond within 60 seconds. Recheck the setup or restart Bridge.'
        : e.message;
      setCaptureStatus({ phase: 'error', message });
      toast.error(`REAPER capture failed: ${message}`);
    } finally {
      captureActive = false;
      if (phasePollId) clearInterval(phasePollId);
      if (renderHintTimeoutId) clearTimeout(renderHintTimeoutId);
      clearTimeout(timeoutId);
    }
  };

  const handleDeleteCapsule = async (cap) => {
    try {
      await api.deleteCapsule(cap.id);
      toast.success('Deleted');
      refreshAll();
    } catch (e) {
      toast.error(`Delete failed: ${e.message}`);
    }
  };

  const handleAddContact = async (payload) => {
    try {
      await api.addContact(payload);
      toast.success('Device added');
      setShowAddContact(false);
      refreshAll();
    } catch (e) {
      toast.error(`Add failed: ${e.message}`);
    }
  };

  const handleDeleteContact = async (contact) => {
    if (!window.confirm(`Remove device "${contact.name}"?`)) return;
    try {
      await api.deleteContact(contact.id);
      toast.success('Deleted');
      refreshAll();
    } catch (e) {
      toast.error(`Delete failed: ${e.message}`);
    }
  };

  const handlePingContact = async (contact) => {
    try {
      const r = await api.pingContact({ contact_id: contact.id, ip: contact.last_ip || contact.ip, port: contact.last_port || contact.port });
      const trusted = r.data?.identity?.peer_id ? ', identity verified' : '';
      toast[r.data?.online ? 'success' : 'error'](r.data?.online ? `${contact.name} is online (${r.data.latency_ms} ms${trusted})` : `${contact.name} is unreachable`);
      refreshAll();
    } catch (e) {
      toast.error(`Ping failed: ${e.message}`);
    }
  };

  const applyReceiveMode = async (mode) => {
    setIsChangingReceiveMode(true);
    try {
      await api.setReceiveMode(mode);
      setReceiveMode(mode);
      const labels = { off: 'Receiving Off', confirm: 'Confirm Receiving', auto: 'Automatic Receiving' };
      toast.success(`Receive mode changed to "${labels[mode]}"`);
    } catch (e) {
      toast.error(`Mode change failed: ${e.message}`);
    } finally {
      setIsChangingReceiveMode(false);
    }
  };

  const handleChangeReceiveMode = (mode) => {
    if (mode === 'auto' && receiveMode !== 'auto') {
      setAutoReceiveConfirmStep(1);
      return;
    }
    applyReceiveMode(mode);
  };

  const cancelAutoReceiveConfirmation = () => {
    setAutoReceiveConfirmStep(0);
    toast.info('Automatic receiving was not enabled.');
  };

  const confirmAutoReceive = async () => {
    if (autoReceiveConfirmStep === 1) {
      setAutoReceiveConfirmStep(2);
      return;
    }
    setAutoReceiveConfirmStep(0);
    await applyReceiveMode('auto');
  };

  const handleAcceptRequest = async (req) => {
    try {
      await api.acceptRequest(req.id);
      setPendingRequests((prev) => prev.filter((item) => item.id !== req.id));
      toast.success(`Accepted transfer from ${req.sender_name}`);
    } catch (e) {
      toast.error(`Accept failed: ${e.message}`);
    }
  };

  const handleRejectRequest = async (req) => {
    try {
      await api.rejectRequest(req.id);
      setPendingRequests((prev) => prev.filter((item) => item.id !== req.id));
      toast.info(`Rejected transfer from ${req.sender_name}`);
    } catch (e) {
      toast.error(`Reject failed: ${e.message}`);
    }
  };

  const handleRenameCapsule = async (cap, newName) => {
    try {
      await api.renameCapsule(cap.id, newName);
      toast.success(`Renamed to "${newName}"`);
      refreshAll();
    } catch (e) {
      toast.error(`Rename failed: ${e.message}`);
    }
  };

  const handleOpenRpp = async (cap) => {
    try {
      await api.openRpp(cap.id);
      toast.success('RPP project opened');
    } catch (e) {
      toast.error(`Open failed: ${e.message}`);
    }
  };

  const handleOpenFolder = async (cap) => {
    try {
      await api.openFolder(cap.id);
      toast.success('Capsule folder opened');
    } catch (e) {
      toast.error(`Open folder failed: ${e.message}`);
    }
  };

  const onlineContacts = useMemo(() => contacts.filter((c) => c.last_seen && Date.now() - new Date(c.last_seen).getTime() < 5 * 60 * 1000), [contacts]);
  const myInfoLine = networkInfo ? `${networkInfo.hostname} / ${networkInfo.ip}:${networkInfo.port}` : 'Detecting local network...';
  const shellNavItems = [
    { id: 'library', label: 'Library', meta: `${capsules.length} capsules`, icon: Package },
    { id: 'transfer', label: 'Transfer', meta: `${selectedCapsules.length} selected`, icon: Send },
    { id: 'contacts', label: 'Devices', meta: `${onlineContacts.length} online`, icon: Users },
    { id: 'settings', label: 'Settings', meta: 'System', icon: Settings },
  ];

  return (
    <div className="h-screen bg-[#080a0c] text-slate-200 font-sans overflow-hidden">
      <div className="h-full flex flex-col min-w-0">
        <header className="h-[72px] border-b border-[#20262a] flex items-center justify-between px-6 bg-[#0b0e10]">
          <div className="flex min-w-0 items-center gap-8">
            <div className="flex shrink-0 items-center gap-3">
              <CapsuleLanLogo />
              <div>
                <div className="text-sm font-bold tracking-wide text-white">Capsule LAN</div>
                <div className="text-[10px] uppercase tracking-widest text-slate-600">
                  Project Library{appVersion ? ` · v${appVersion}` : ''}
                </div>
              </div>
            </div>
            <nav className="flex items-center gap-1">
              {shellNavItems.slice(0, 3).map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${activeTab === item.id ? 'border-[#75a8c0] text-white' : 'border-transparent text-slate-600 hover:text-slate-300'}`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 border-r border-[#20262a] pr-4 xl:flex">
              <div className={`h-2 w-2 rounded-full ${serverOnline ? 'bg-[#75a8c0]' : 'bg-red-500'}`} title={serverOnline ? 'Server online' : 'Server offline'} />
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-slate-600">Local Device</div>
                <div className="mt-0.5 text-xs font-mono text-slate-400">{myInfoLine}</div>
              </div>
              {networkInfo?.ip && <button onClick={() => navigator.clipboard.writeText(`${networkInfo.ip}:${networkInfo.port}`).then(() => toast.success('Address copied'))} className="p-1.5 text-slate-600 hover:text-slate-200" title="Copy IP and port"><Copy size={14} /></button>}
            </div>
            <div className="flex items-center overflow-hidden rounded-md border border-[#252c30] bg-[#090b0d]">
              <button onClick={() => handleChangeReceiveMode('off')} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 transition-all ${receiveMode === 'off' ? 'bg-red-500/15 text-red-300' : 'text-slate-600 hover:text-slate-300'}`} title="Disable receiving"><ShieldOff size={12} /><span>Off</span></button>
              <button onClick={() => handleChangeReceiveMode('confirm')} className={`border-x border-[#252c30] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 transition-all ${receiveMode === 'confirm' ? 'bg-amber-500/15 text-amber-300' : 'text-slate-600 hover:text-slate-300'}`} title="Confirm incoming transfers"><ShieldCheck size={12} /><span>Confirm</span></button>
              <button onClick={() => handleChangeReceiveMode('auto')} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 transition-all ${receiveMode === 'auto' ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-600 hover:text-slate-300'}`} title="Automatically receive transfers"><Shield size={12} /><span>Auto</span></button>
            </div>
            {pendingRequests.length > 0 && (
              <button onClick={() => setShowIncoming(true)} className="relative p-2 text-amber-400 hover:text-amber-300 transition-colors" title={`${pendingRequests.length} pending requests`}>
                <Bell size={18} />
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{pendingRequests.length}</span>
              </button>
            )}
            <button onClick={refreshAll} className="flex h-8 w-8 items-center justify-center rounded-md border border-[#252c30] text-slate-600 hover:bg-[#151a1d] hover:text-slate-200" title="Refresh"><RefreshCw size={14} /></button>
            <button onClick={() => setActiveTab('settings')} className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${activeTab === 'settings' ? 'border-[#315c70] bg-[#142027] text-[#75a8c0]' : 'border-[#252c30] text-slate-600 hover:bg-[#151a1d] hover:text-slate-200'}`} title="Settings"><Settings size={15} /></button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-[#090b0d] p-5 custom-scrollbar">
          {activeTab === 'library' && <LibraryView capsules={capsules} onSend={handleSelectCapsuleForSend} onDelete={handleDeleteCapsule} onCreate={handleCreateCapsule} onRequestCreate={handleRequestCreateCapsule} isCheckingSetup={isCheckingCaptureSetup} onRename={handleRenameCapsule} onOpenRpp={handleOpenRpp} onOpenFolder={handleOpenFolder} />}
          {activeTab === 'contacts' && <ContactsView contacts={contacts} onlineContacts={onlineContacts} onSend={handleStartTransferTo} onDelete={handleDeleteContact} onPing={handlePingContact} showAddForm={showAddContact} setShowAddForm={setShowAddContact} onAdd={handleAddContact} />}
          {activeTab === 'transfer' && <TransferView capsules={capsules} contacts={contacts} selectedCapsules={selectedCapsules} setSelectedCapsules={setSelectedCapsules} targetContacts={targetContacts} setTargetContacts={setTargetContacts} tempPeer={tempPeer} setTempPeer={setTempPeer} showTempPeerForm={showTempPeerForm} setShowTempPeerForm={setShowTempPeerForm} isSending={isSending} transferProgress={transferProgress} onSend={handleSend} />}
          {activeTab === 'settings' && <SettingsView networkInfo={networkInfo} apiBase={api.base} appVersion={appVersion} bridgeStatus={bridgeStatus} showCaptureDebug={showCaptureDebug} onToggleCaptureDebug={setShowCaptureDebug} onRefreshBridge={refreshBridgeStatus} onOpenSetup={() => setShowSetupWizard(true)} />}
        </main>
      </div>
      {captureStatus && <CaptureOverlayV2 status={captureStatus} onClose={() => setCaptureStatus(null)} />}
      {showCaptureDebug && <CaptureDebugPanel status={captureDebugStatus || bridgeStatus} error={captureDebugError} captureStatus={captureStatus} onClose={() => setShowCaptureDebug(false)} onRefresh={refreshCaptureDebug} />}
      {showSetupWizard && <SetupWizard status={bridgeStatus} onClose={() => setShowSetupWizard(false)} onRefresh={refreshBridgeStatus} />}
      {showIncoming && pendingRequests.length > 0 && <IncomingRequestsOverlay requests={pendingRequests} onAccept={handleAcceptRequest} onReject={handleRejectRequest} onClose={() => setShowIncoming(false)} />}
      {autoReceiveConfirmStep > 0 && (
        <ConfirmationDialog
          eyebrow={`Automatic Receiving · Step ${autoReceiveConfirmStep} of 2`}
          title={autoReceiveConfirmStep === 1 ? 'Enable automatic receiving?' : 'Confirm automatic receiving'}
          description={autoReceiveConfirmStep === 1
            ? 'Incoming capsules will be accepted and saved without asking you first. Use this mode only on a trusted local network.'
            : 'Transfers from devices on this network will be written directly to your library. You can switch back to Confirm mode at any time.'}
          detail={autoReceiveConfirmStep === 1 ? 'No confirmation will appear for each incoming transfer.' : 'This changes the current device receive policy immediately.'}
          icon={Shield}
          tone="warning"
          confirmLabel={autoReceiveConfirmStep === 1 ? 'Continue' : 'Enable Auto'}
          cancelLabel="Keep Confirm Mode"
          busy={isChangingReceiveMode}
          onCancel={cancelAutoReceiveConfirmation}
          onConfirm={confirmAutoReceive}
        />
      )}
    </div>
  );
}

function LibraryView({ capsules, onSend, onDelete, onCreate, onRequestCreate, isCheckingSetup, onRename, onOpenRpp, onOpenFolder }) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [activePreview, setActivePreview] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [previewError, setPreviewError] = useState('');
  const waveformRef = useRef(null);
  const waveSurferRef = useRef(null);
  const autoplayPreviewRef = useRef(false);
  const draggingCapsuleIdRef = useRef(null);
  const draggingFolderIdRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [selectedId, setSelectedId] = useState(capsules[0]?.id || null);
  const [query, setQuery] = useState('');
  const [customFolders, setCustomFolders] = useState([]);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [createParentId, setCreateParentId] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderError, setFolderError] = useState('');
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [folderEditName, setFolderEditName] = useState('');
  const [deleteConfirmFolderId, setDeleteConfirmFolderId] = useState(null);
  const [capsulePendingDelete, setCapsulePendingDelete] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [draggingFolderId, setDraggingFolderId] = useState(null);
  const [dragOverFolder, setDragOverFolder] = useState(null);

  const parseCapsuleDate = (value) => {
    if (!value) return null;
    const raw = String(value);
    const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
    const date = new Date(hasTimezone ? raw : `${raw}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const formatCapsuleDate = (value) => {
    const date = parseCapsuleDate(value);
    if (!date) return 'Unknown';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const isReceived = (cap) => Boolean(cap.source_peer);
  const isRecentReceived = (cap) => {
    const date = parseCapsuleDate(cap.created_at);
    return isReceived(cap) && date && Date.now() - date.getTime() <= 7 * 24 * 60 * 60 * 1000;
  };
  const hasMissingPlugins = (cap) => Boolean(cap.plugin_status?.inventory_available && cap.plugin_status?.missing > 0);
  useEffect(() => {
    let cancelled = false;
    const loadFolders = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        try {
          const res = await api.listCapsuleFolders();
          if (!cancelled) {
            setCustomFolders(res.data?.items || []);
            setFolderError('');
          }
          return;
        } catch (err) {
          lastError = err;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }
      if (!cancelled) setFolderError(`Failed to load collections: ${lastError?.message || 'Unknown error'}`);
    };
    loadFolders();
    return () => { cancelled = true; };
  }, []);

  const refreshCustomFolders = async () => {
    const res = await api.listCapsuleFolders();
    setCustomFolders(res.data?.items || []);
    setFolderError('');
    return res.data?.items || [];
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      setFolderError('');
      await api.createCapsuleFolder(name, createParentId);
      await refreshCustomFolders();
      setNewFolderName('');
      setIsCreatingFolder(false);
      setCreateParentId(null);
    } catch (err) {
      setFolderError(`Failed to create collection: ${err.message}`);
    }
  };

  const startCreateFolder = (parentId = null) => {
    setCreateParentId(parentId);
    setNewFolderName('');
    setIsCreatingFolder(true);
  };

  const addToFolder = async (folderId, capsuleId) => {
    if (!folderId || !capsuleId) return;
    try {
      setFolderError('');
      await api.addCapsuleToFolder(folderId, capsuleId);
      await refreshCustomFolders();
    } catch (err) {
      setFolderError(`Failed to add to collection: ${err.message}`);
    } finally {
      setDragOverFolder(null);
      setDraggingId(null);
    }
  };

  const moveFolder = async (folderId, parentId) => {
    if (!folderId || folderId === parentId) return;
    try {
      setFolderError('');
      await api.updateCapsuleFolder(folderId, { parent_id: parentId || null });
      await refreshCustomFolders();
    } catch (err) {
      setFolderError(`Failed to move collection: ${err.message}`);
    } finally {
      setDraggingFolderId(null);
      setDragOverFolder(null);
    }
  };

  const startRenameFolder = (folder) => {
    if (!folder?.id) return;
    setEditingFolderId(folder.id);
    setFolderEditName(folder.label || '');
    setDeleteConfirmFolderId(null);
  };

  const cancelRenameFolder = () => {
    setEditingFolderId(null);
    setFolderEditName('');
  };

  const confirmRenameFolder = async (folder) => {
    const name = folderEditName.trim();
    if (!folder?.id || !name) return;
    try {
      setFolderError('');
      if (name !== folder.label) {
        await api.updateCapsuleFolder(folder.id, { name });
        await refreshCustomFolders();
      }
      cancelRenameFolder();
    } catch (err) {
      setFolderError(`Failed to rename collection: ${err.message}`);
    }
  };

  const deleteFolder = async (folder) => {
    if (!folder?.id) return;
    try {
      setFolderError('');
      const deletedIds = new Set([folder.id, ...(descendantIdsByFolderId.get(folder.id) || [])]);
      await api.deleteCapsuleFolder(folder.id);
      await refreshCustomFolders();
      if (selectedFolder.startsWith('folder:') && deletedIds.has(selectedFolder.slice('folder:'.length))) {
        setSelectedFolder('all');
      }
      if (editingFolderId && deletedIds.has(editingFolderId)) cancelRenameFolder();
      setDeleteConfirmFolderId(null);
    } catch (err) {
      setFolderError(`Failed to delete collection: ${err.message}`);
    }
  };

  const removeFromCurrentFolder = async (cap) => {
    if (!selectedFolder.startsWith('folder:')) return;
    const folderId = selectedFolder.slice('folder:'.length);
    try {
      setFolderError('');
      await api.removeCapsuleFromFolder(folderId, cap.id);
      await refreshCustomFolders();
    } catch (err) {
      setFolderError(`Failed to remove from collection: ${err.message}`);
    }
  };

  const descendantIdsByFolderId = useMemo(() => {
    const childrenByParent = new Map();
    customFolders.forEach((folder) => {
      const parentId = folder.parent_id || null;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(folder.id);
    });
    const collect = (folderId) => {
      const ids = new Set([folderId]);
      (childrenByParent.get(folderId) || []).forEach((childId) => {
        collect(childId).forEach((id) => ids.add(id));
      });
      return ids;
    };
    const result = new Map();
    customFolders.forEach((folder) => result.set(folder.id, collect(folder.id)));
    return result;
  }, [customFolders]);

  const folderPathsByCapsuleId = useMemo(() => {
    const folderById = new Map(customFolders.map((folder) => [folder.id, folder]));
    const pathFor = (folder) => {
      const chain = [];
      let current = folder;
      const seen = new Set();
      while (current && !seen.has(current.id)) {
        chain.unshift(current.name);
        seen.add(current.id);
        current = current.parent_id ? folderById.get(current.parent_id) : null;
      }
      return chain;
    };
    const result = new Map();
    customFolders.forEach((folder) => {
      const path = pathFor(folder);
      (folder.capsule_ids || []).forEach((capsuleId) => {
        if (!result.has(capsuleId)) result.set(capsuleId, []);
        result.get(capsuleId).push(path);
      });
    });
    return result;
  }, [customFolders]);

  const folderLabelsForCapsule = (cap) => {
    const paths = folderPathsByCapsuleId.get(cap.id) || [];
    const labels = [];
    paths.forEach((path) => {
      path.forEach((part) => {
        if (!labels.includes(part)) labels.push(part);
      });
    });
    return labels;
  };
  const folderSearchTextForCapsule = (cap) => {
    const paths = folderPathsByCapsuleId.get(cap.id) || [];
    const labels = folderLabelsForCapsule(cap);
    const pathText = paths.map((path) => path.join(' ')).join(' ');
    const breadcrumbText = paths.map((path) => path.join('>')).join(' ');
    return [...labels, pathText, breadcrumbText].filter(Boolean).join(' ');
  };

  const buildCustomFolderTree = (folders) => {
    const nodeById = new Map();
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    folders.forEach((folder) => {
      const descendantIds = descendantIdsByFolderId.get(folder.id) || new Set([folder.id]);
      const capsuleIds = new Set();
      descendantIds.forEach((id) => {
        (folderById.get(id)?.capsule_ids || []).forEach((capsuleId) => capsuleIds.add(capsuleId));
      });
      nodeById.set(folder.id, {
        key: `folder:${folder.id}`,
        id: folder.id,
        label: folder.name,
        icon: FolderOpen,
        count: capsuleIds.size,
        droppable: true,
        draggableFolder: true,
        predicate: (cap) => capsuleIds.has(cap.id),
        children: [],
      });
    });
    const roots = [];
    folders.forEach((folder) => {
      const node = nodeById.get(folder.id);
      const parent = folder.parent_id ? nodeById.get(folder.parent_id) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    });
    const sortNodes = (nodes) => nodes
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
      .map((node) => ({ ...node, children: sortNodes(node.children || []) }));
    return sortNodes(roots);
  };

  const folderTree = useMemo(() => {
    const customItems = buildCustomFolderTree(customFolders);
    return [
      {
        key: 'custom-root',
        label: 'Collections',
        icon: FolderOpen,
        count: customFolders.length,
        selectable: false,
        acceptsFolderDrop: true,
        children: customItems,
      },
      { key: 'all', label: 'All Capsules', icon: Package, count: capsules.length, predicate: () => true },
      { key: 'local', label: 'Local Captures', icon: HardDrive, count: capsules.filter((cap) => !isReceived(cap)).length, predicate: (cap) => !isReceived(cap) },
      { key: 'received', label: 'Received', icon: Inbox, count: capsules.filter(isReceived).length, predicate: isReceived },
      { key: 'recent-received', label: 'Received: 7 Days', icon: Clock, count: capsules.filter(isRecentReceived).length, predicate: isRecentReceived },
      { key: 'missing-plugins', label: 'Missing Plugins', icon: AlertTriangle, count: capsules.filter(hasMissingPlugins).length, predicate: hasMissingPlugins },
    ];
  }, [capsules, customFolders, descendantIdsByFolderId]);

  const allFolders = useMemo(() => {
    const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.children || [])]);
    return flatten(folderTree);
  }, [folderTree]);
  const activeFolder = allFolders.find((folder) => folder.key === selectedFolder) || allFolders.find((folder) => folder.key === 'all') || { predicate: () => true };
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCapsules = capsules.filter((cap) => {
    if (!activeFolder.predicate?.(cap)) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      cap.name,
      cap.project_name,
      cap.keywords,
      cap.description,
      cap.capsule_type,
      cap.source_peer,
      cap.rpp_file,
      folderSearchTextForCapsule(cap),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(normalizedQuery);
  });
  const selectedCapsule = filteredCapsules.find((cap) => cap.id === selectedId) || filteredCapsules[0] || null;
  const activeCustomFolder = selectedFolder.startsWith('folder:')
    ? customFolders.find((folder) => `folder:${folder.id}` === selectedFolder)
    : null;
  const createParentName = createParentId
    ? customFolders.find((folder) => folder.id === createParentId)?.name
    : null;

  useEffect(() => {
    if (!filteredCapsules.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!filteredCapsules.some((cap) => cap.id === selectedId)) {
      setSelectedId(filteredCapsules[0].id);
    }
  }, [filteredCapsules, selectedId]);

  const loadPreview = (cap, autoplay = false) => {
    if (activePreview?.id === cap.id) {
      if (autoplay) {
        if (waveSurferRef.current && previewReady) waveSurferRef.current.play();
        else autoplayPreviewRef.current = true;
      }
      return;
    }
    autoplayPreviewRef.current = autoplay;
    setPlayingId(null);
    setPreviewError('');
    setPreviewReady(false);
    setPreviewTime(0);
    setPreviewDuration(0);
    setActivePreview(cap);
  };

  const handlePlay = (cap, forcePlay = false) => {
    if (activePreview?.id !== cap.id || !waveSurferRef.current) {
      loadPreview(cap, true);
      return;
    }
    if (!previewReady) {
      autoplayPreviewRef.current = true;
      return;
    }
    if (forcePlay && !waveSurferRef.current.isPlaying()) waveSurferRef.current.play();
    else waveSurferRef.current.playPause();
  };

  const closePreview = () => {
    autoplayPreviewRef.current = false;
    setActivePreview(null);
    setPlayingId(null);
    setPreviewReady(false);
    setPreviewTime(0);
    setPreviewDuration(0);
    setPreviewError('');
  };

  const startRename = (cap) => { setEditingId(cap.id); setEditName(cap.name); };
  const confirmRename = (cap) => { if (editName.trim() && editName.trim() !== cap.name) onRename(cap, editName.trim()); setEditingId(null); };
  const stopAction = (event, fn) => {
    event.stopPropagation();
    fn();
  };

  useEffect(() => {
    if (!activePreview || !waveformRef.current) return undefined;
    const wavesurfer = WaveSurfer.create({
      container: waveformRef.current,
      url: api.previewUrl(activePreview.id),
      height: 56,
      waveColor: '#53616a',
      progressColor: '#75a8c0',
      cursorColor: '#dbe7ec',
      cursorWidth: 1,
      sampleRate: Number(activePreview.metadata?.sample_rate) || 48000,
      normalize: false,
      interact: true,
      dragToSeek: true,
      hideScrollbar: true,
      renderFunction: renderPeakEnvelope,
      plugins: [
        Timeline.create({
          height: 14,
          timeInterval: 5,
          primaryLabelInterval: 10,
          style: { fontSize: '9px', color: '#61707a' },
        }),
        Hover.create({
          lineColor: '#9fb2bc',
          lineWidth: 1,
          labelBackground: '#151a1d',
          labelColor: '#dbe7ec',
          labelSize: '10px',
        }),
      ],
    });
    waveSurferRef.current = wavesurfer;
    const unsubs = [
      wavesurfer.on('ready', (duration) => {
        setPreviewReady(true);
        setPreviewDuration(duration || wavesurfer.getDuration());
        if (autoplayPreviewRef.current) {
          autoplayPreviewRef.current = false;
          wavesurfer.play();
        }
      }),
      wavesurfer.on('play', () => setPlayingId(activePreview.id)),
      wavesurfer.on('pause', () => setPlayingId(null)),
      wavesurfer.on('finish', () => setPlayingId(null)),
      wavesurfer.on('timeupdate', (time) => setPreviewTime(time)),
      wavesurfer.on('interaction', (time) => setPreviewTime(time)),
      wavesurfer.on('error', () => {
        setPreviewError('Preview audio is unavailable for this capsule.');
        setPlayingId(null);
      }),
    ];
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      wavesurfer.destroy();
      if (waveSurferRef.current === wavesurfer) waveSurferRef.current = null;
    };
  }, [activePreview]);

  useEffect(() => {
    const handlePreviewShortcut = (event) => {
      if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isEditable = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName));
      if (isEditable || editingId || editingFolderId || isCreatingFolder || capsulePendingDelete || !selectedCapsule) return;
      event.preventDefault();
      handlePlay(selectedCapsule);
    };
    window.addEventListener('keydown', handlePreviewShortcut);
    return () => window.removeEventListener('keydown', handlePreviewShortcut);
  }, [editingFolderId, editingId, isCreatingFolder, capsulePendingDelete, selectedCapsule, activePreview, previewReady]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const openContextMenu = (event, type, item) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 220;
    const menuHeight = type === 'capsule' ? 350 : 142;
    setContextMenu({
      type,
      item,
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    });
  };

  const runContextAction = (action) => {
    const menu = contextMenu;
    setContextMenu(null);
    if (menu) action(menu.item);
  };

  const renderFolder = (folder, depth = 0) => {
    const Icon = folder.icon;
    const active = selectedFolder === folder.key;
    const hasChildren = Boolean(folder.children?.length);
    const canSelect = folder.selectable !== false;
    const canDropCapsule = Boolean(folder.droppable);
    const canDropFolder = Boolean(folder.droppable || folder.acceptsFolderDrop);
    const isDragOver = dragOverFolder === folder.key;
    const folderDropTargetId = folder.acceptsFolderDrop ? null : folder.id;
    const isEditingFolder = folder.droppable && editingFolderId === folder.id;
    const isConfirmingDelete = folder.droppable && deleteConfirmFolderId === folder.id;
    return (
      <div key={folder.key}>
        <div
          role="button"
          tabIndex={canSelect ? 0 : -1}
          onClick={() => { if (canSelect) setSelectedFolder(folder.key); }}
          onContextMenu={(event) => {
            if (folder.key === 'custom-root' || folder.droppable) openContextMenu(event, 'folder', folder);
          }}
          onKeyDown={(event) => {
            if (!canSelect) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setSelectedFolder(folder.key);
            }
          }}
          draggable={Boolean(folder.draggableFolder) && !isEditingFolder && !isConfirmingDelete}
          onDragStart={(event) => {
            if (!folder.draggableFolder || isEditingFolder || isConfirmingDelete) return;
            event.stopPropagation();
            draggingFolderIdRef.current = folder.id;
            setDraggingFolderId(folder.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-capsule-folder-id', folder.id);
            event.dataTransfer.setData('text/plain', `folder:${folder.id}`);
          }}
          onDragOver={(event) => {
            const dragTypes = Array.from(event.dataTransfer.types || []);
            const hasCapsule = dragTypes.includes('application/x-capsule-id') || Boolean(draggingCapsuleIdRef.current);
            const hasFolder = dragTypes.includes('application/x-capsule-folder-id') || Boolean(draggingFolderIdRef.current);
            if ((!hasCapsule || !canDropCapsule) && (!hasFolder || !canDropFolder)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = hasFolder ? 'move' : 'copy';
            setDragOverFolder(folder.key);
          }}
          onDragLeave={() => {
            if (isDragOver) setDragOverFolder(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const plainValue = event.dataTransfer.getData('text/plain');
            const droppedFolderId = event.dataTransfer.getData('application/x-capsule-folder-id') || draggingFolderIdRef.current || (plainValue?.startsWith('folder:') ? plainValue.slice('folder:'.length) : '');
            if (droppedFolderId && canDropFolder) {
              moveFolder(droppedFolderId, folderDropTargetId);
              return;
            }
            const capsuleId = draggingCapsuleIdRef.current || event.dataTransfer.getData('application/x-capsule-id') || (plainValue?.startsWith('capsule:') ? plainValue.slice('capsule:'.length) : plainValue);
            if (capsuleId && canDropCapsule) {
              addToFolder(folder.id, capsuleId);
            }
          }}
          onDragEnd={() => {
            if (folder.draggableFolder) {
              setDraggingFolderId(null);
              draggingFolderIdRef.current = null;
              setDragOverFolder(null);
            }
          }}
          className={`group/folder w-full h-9 px-2 rounded-lg flex items-center gap-2 text-left transition-colors ${active ? 'bg-indigo-500/15 border border-indigo-500/35 text-indigo-100' : isDragOver ? 'border border-indigo-500/50 bg-indigo-500/10 text-indigo-100' : canSelect ? 'border border-transparent text-slate-400 hover:bg-slate-800/70 hover:text-slate-200' : 'border border-transparent text-slate-500'}`}
          style={{ paddingLeft: `${8 + depth * 18}px` }}
          >
          {hasChildren ? <ChevronDown size={14} className="text-slate-500 shrink-0" /> : <span className="w-3.5 shrink-0" />}
          <Icon size={15} className={active ? 'text-indigo-300 shrink-0' : 'text-slate-500 shrink-0'} />
          {isEditingFolder ? (
            <input
              autoFocus
              value={folderEditName}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setFolderEditName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  confirmRenameFolder(folder);
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelRenameFolder();
                }
              }}
              className="min-w-0 flex-1 rounded border border-indigo-500/60 bg-[#0f1115] px-1.5 py-0.5 text-sm text-slate-100 focus:outline-none"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm" title={folder.label}>{folder.label}</span>
          )}
          {isEditingFolder ? (
            <span className="flex shrink-0 items-center gap-1">
              <span
                role="button"
                tabIndex={0}
                title="SaveCollectionsName"
                onClick={(event) => {
                  event.stopPropagation();
                  confirmRenameFolder(folder);
                }}
                className="rounded p-1 text-emerald-400 hover:bg-emerald-500/10"
              >
                <Check size={13} />
              </span>
              <span
                role="button"
                tabIndex={0}
                title="Cancel rename"
                onClick={(event) => {
                  event.stopPropagation();
                  cancelRenameFolder();
                }}
                className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
              >
                <X size={13} />
              </span>
            </span>
          ) : isConfirmingDelete ? (
            <span className="flex shrink-0 items-center gap-1">
              <span
                role="button"
                tabIndex={0}
                title="Confirm collection deletion without deleting capsules"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteFolder(folder);
                }}
                className="rounded bg-red-500/20 px-1.5 py-0.5 text-[11px] text-red-200 hover:bg-red-500 hover:text-white"
              >
                Delete
              </span>
              <span
                role="button"
                tabIndex={0}
                title="Cancel deletion"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteConfirmFolderId(null);
                }}
                className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
              >
                <X size={13} />
              </span>
            </span>
          ) : null}
          <span className="text-[11px] text-slate-500">{folder.count}</span>
        </div>
        {hasChildren && (
          <div className="mt-1 space-y-1">
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex flex-col gap-4 min-[1100px]:flex-row min-[1100px]:items-center min-[1100px]:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-white">Capsule Library</h1>
          <p className="text-slate-600 text-xs mt-1">{capsules.length} capsules in your workspace · {filteredCapsules.length} shown</p>
        </div>
        <div className="flex w-full items-center gap-2 xl:w-auto">
          <div className="relative min-w-0 flex-1 min-[1100px]:w-[320px] min-[1100px]:flex-none xl:w-[360px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search names, projects, sources, tags..."
              className="w-full bg-[#0b0e10] border border-[#252c30] rounded-md pl-9 pr-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-[#4f8198]"
            />
          </div>
          <button disabled={isCheckingSetup} onClick={async () => {
            if (showCreateForm) {
              setShowCreateForm(false);
              return;
            }
            const allowed = await onRequestCreate();
            if (allowed) setShowCreateForm(true);
          }} className="shrink-0 whitespace-nowrap bg-[#377894] hover:bg-[#438aa7] text-white px-4 py-2 rounded-md flex items-center space-x-2 shadow-lg shadow-black/20 disabled:opacity-50 disabled:cursor-not-allowed">
            {isCheckingSetup ? <RefreshCw size={18} className="animate-spin" /> : <Plus size={18} />}
            <span>{isCheckingSetup ? 'Checking...' : 'New Capture'}</span>
          </button>
        </div>
      </div>

      {showCreateForm && <CreateCapsuleForm onCancel={() => setShowCreateForm(false)} onSubmit={async (data) => { const result = await onCreate(data); if (result !== false) setShowCreateForm(false); }} />}

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-3">
          <aside className="min-h-[220px] lg:min-h-0 rounded-lg border border-[#20262a] bg-[#0b0e10] p-3 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Library</div>
                <div className="text-[11px] text-slate-600 mt-0.5">Collections and filters</div>
              </div>
              <button onClick={() => startCreateFolder(null)} className="p-2 rounded-md border border-[#252c30] text-slate-600 hover:text-slate-300 hover:bg-[#151a1d]" title="New collection">
                <FolderPlus size={16} />
              </button>
            </div>
            {isCreatingFolder && (
              <div className="mb-3 rounded-lg border border-slate-800 bg-[#0f1115] p-2">
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') createFolder();
                    if (event.key === 'Escape') { setIsCreatingFolder(false); setNewFolderName(''); setCreateParentId(null); }
                  }}
                  placeholder="Collection name"
                  className="w-full bg-transparent px-1 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none"
                />
                <div className="px-1 text-[11px] text-slate-600">{createParentName ? `Create inside: ${createParentName}` : 'Create at collection root'}</div>
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); setCreateParentId(null); }} className="px-2 py-1 text-xs text-slate-500 hover:text-slate-200">Cancel</button>
                  <button onClick={createFolder} className="rounded bg-[#377894] px-2.5 py-1 text-xs text-white hover:bg-[#438aa7]">Create</button>
                </div>
              </div>
            )}
            <div className="space-y-1 overflow-y-auto custom-scrollbar pr-1">
              {folderTree.map((folder) => renderFolder(folder))}
              {customFolders.length === 0 && (
                <button
                  onClick={() => startCreateFolder(null)}
                  className="mt-2 w-full rounded-lg border border-dashed border-slate-700 px-3 py-2 text-left text-xs text-slate-500 hover:border-indigo-500/50 hover:bg-indigo-500/10 hover:text-indigo-200"
                >
                  Create a collection, then drag capsules into it.
                </button>
              )}
            </div>
            {folderError && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-200">{folderError}</div>}
            <div className="mt-auto pt-4 text-[11px] leading-relaxed text-slate-600">
              Dragging a capsule into a collection only saves the relationship. Local files are not moved.
            </div>
          </aside>

          <section className="min-h-0 rounded-lg border border-[#20262a] bg-[#0b0e10] overflow-hidden flex flex-col">
            <div className="h-11 px-4 grid grid-cols-[minmax(150px,1fr)_76px_84px_60px_116px_minmax(100px,0.7fr)] items-center gap-3 border-b border-slate-800 bg-[#151a21] text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <span>Name</span>
              <span>Source</span>
              <span>Plugins</span>
              <span>Size</span>
              <span>Created</span>
              <span>Collections</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              {filteredCapsules.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500">
                  <Package size={28} className="mb-3" />
                  <p className="text-sm">No capsules match this view.</p>
                </div>
              ) : filteredCapsules.map((cap) => {
                const selected = selectedCapsule?.id === cap.id;
                const folderLabels = folderLabelsForCapsule(cap);
                const hiddenFolderLabels = folderLabels.slice(5);
                const folderTitle = (folderPathsByCapsuleId.get(cap.id) || []).map((path) => path.join(' > ')).join('\n');
                return (
                  <div
                    key={cap.id}
                    draggable={editingId !== cap.id}
                    onClick={() => {
                      setSelectedId(cap.id);
                      loadPreview(cap);
                    }}
                    onDoubleClick={() => handlePlay(cap, true)}
                    onContextMenu={(event) => {
                      setSelectedId(cap.id);
                      openContextMenu(event, 'capsule', cap);
                    }}
                    onDragStart={(event) => {
                      if (editingId === cap.id) {
                        event.preventDefault();
                        return;
                      }
                      draggingCapsuleIdRef.current = cap.id;
                      setDraggingId(cap.id);
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData('application/x-capsule-id', cap.id);
                      event.dataTransfer.setData('text/plain', `capsule:${cap.id}`);
                    }}
                    onDragEnd={() => {
                      draggingCapsuleIdRef.current = null;
                      setDraggingId(null);
                      setDragOverFolder(null);
                    }}
                    className={`group min-h-[48px] px-4 grid grid-cols-[minmax(150px,1fr)_76px_84px_60px_116px_minmax(100px,0.7fr)] items-center gap-3 border-b border-slate-800/70 cursor-grab transition-colors active:cursor-grabbing ${draggingId === cap.id ? 'opacity-60' : ''} ${selected ? 'bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/30' : 'bg-[#11151b] hover:bg-[#171d25]'}`}
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <button title={playingId === cap.id ? 'Pause preview' : 'Play preview'} onClick={(event) => stopAction(event, () => handlePlay(cap))} onDoubleClick={(event) => event.stopPropagation()} className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${playingId === cap.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-indigo-300 hover:bg-indigo-600/20'}`}>
                        {playingId === cap.id ? <Pause size={15} /> : <Play size={15} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        {editingId === cap.id ? (
                          <input
                            autoFocus
                            value={editName}
                            draggable={false}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => event.stopPropagation()}
                            onDrop={(event) => event.stopPropagation()}
                            onChange={(event) => setEditName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') confirmRename(cap);
                              if (event.key === 'Escape') setEditingId(null);
                            }}
                            onBlur={() => confirmRename(cap)}
                            className="w-full rounded border border-[#377894] bg-[#090b0d] px-2 py-1 text-sm text-slate-100 outline-none"
                          />
                        ) : (
                          <div className="truncate text-sm font-medium text-slate-200">{cap.name}</div>
                        )}
                      </div>
                    </div>
                    <div className="min-w-0 text-xs">
                      <div className="truncate text-slate-300">{cap.source_peer || 'Local'}</div>
                    </div>
                    <div><PluginStatusBadge status={cap.plugin_status} /></div>
                    <div className="text-xs text-slate-400">{formatBytes(cap.size_bytes)}</div>
                    <div title={parseCapsuleDate(cap.created_at)?.toLocaleString() || 'Creation time unavailable'} className="whitespace-nowrap text-[11px] text-slate-400">
                      {formatCapsuleDate(cap.created_at)}
                    </div>
                    <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                      {folderLabels.length === 0 ? (
                        <span className="text-[11px] text-slate-600">Unsorted</span>
                      ) : folderLabels.slice(0, 5).map((label) => (
                        <span key={label} title={label} className="max-w-[92px] truncate rounded border border-slate-700/70 bg-slate-800/50 px-1.5 py-0.5 text-[11px] text-slate-300">
                          {label}
                        </span>
                      ))}
                      {hiddenFolderLabels.length > 0 && <span title={folderTitle || hiddenFolderLabels.join(', ')} className="text-[11px] text-slate-500">+{hiddenFolderLabels.length}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      {activePreview && (
        <div className="mt-3 grid h-[104px] shrink-0 grid-cols-[210px_minmax(0,1fr)_72px] items-center gap-4 rounded-lg border border-[#20262a] bg-[#0b0e10] px-4">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => handlePlay(activePreview)} disabled={!previewReady || Boolean(previewError)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#377894] text-white hover:bg-[#438aa7] disabled:bg-[#171c1f] disabled:text-slate-600">
              {playingId === activePreview.id ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-200">{activePreview.name}</div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600">
                <Volume2 size={11} />
                <span>{previewError || (previewReady ? 'Preview audio' : 'Decoding waveform...')}</span>
              </div>
            </div>
          </div>
          <div className="min-w-0">
            <div ref={waveformRef} className="capsule-waveform h-[72px] w-full" />
          </div>
          <div className="flex h-full flex-col items-end justify-center gap-3">
            <div className="font-mono text-[11px] text-slate-500">{formatTime(previewTime)} / {formatTime(previewDuration)}</div>
            <button onClick={closePreview} className="flex h-7 w-7 items-center justify-center rounded-md border border-[#252c30] text-slate-600 hover:bg-[#151a1d] hover:text-slate-200" title="Close player"><X size={14} /></button>
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="fixed z-[100] w-[220px] overflow-hidden rounded-md border border-[#30383d] bg-[#111518] py-1 shadow-2xl shadow-black/60"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.type === 'folder' ? (
            <>
              <ContextMenuItem icon={FolderPlus} label={contextMenu.item.key === 'custom-root' ? 'New Collection' : 'New Subcollection'} onClick={() => runContextAction((folder) => startCreateFolder(folder.droppable ? folder.id : null))} />
              {contextMenu.item.droppable && <ContextMenuItem icon={Pencil} label="Rename Collection" onClick={() => runContextAction(startRenameFolder)} />}
              {contextMenu.item.droppable && <ContextMenuDivider />}
              {contextMenu.item.droppable && <ContextMenuItem icon={Trash2} label="Delete Collection" danger onClick={() => runContextAction((folder) => { setDeleteConfirmFolderId(folder.id); cancelRenameFolder(); })} />}
            </>
          ) : (
            <>
              <ContextMenuItem icon={playingId === contextMenu.item.id ? Pause : Play} label={playingId === contextMenu.item.id ? 'Pause Preview' : 'Play Preview'} onClick={() => runContextAction(handlePlay)} />
              <ContextMenuItem icon={Send} label="Add to Transfer List" onClick={() => runContextAction(onSend)} />
              <ContextMenuDivider />
              <ContextMenuItem icon={Music} label="Open RPP" onClick={() => runContextAction(onOpenRpp)} />
              <ContextMenuItem icon={FolderOpen} label="Open Folder" onClick={() => runContextAction(onOpenFolder)} />
              <ContextMenuItem icon={Pencil} label="Rename Capsule" onClick={() => runContextAction(startRename)} />
              {activeCustomFolder?.capsule_ids?.includes(contextMenu.item.id) && <ContextMenuItem icon={X} label={`Remove from ${activeCustomFolder.name}`} onClick={() => runContextAction(removeFromCurrentFolder)} />}
              <ContextMenuDivider />
              <ContextMenuItem icon={Trash2} label="Delete Capsule" danger onClick={() => runContextAction(setCapsulePendingDelete)} />
            </>
          )}
        </div>
      )}
      {capsulePendingDelete && (
        <ConfirmationDialog
          eyebrow="Permanent Action"
          title="Delete this capsule?"
          description={`"${capsulePendingDelete.name}" will be removed from this device and all collections.`}
          detail="The capsule files will be deleted. This action cannot be undone."
          icon={Trash2}
          tone="danger"
          confirmLabel="Delete Capsule"
          cancelLabel="Cancel"
          onCancel={() => setCapsulePendingDelete(null)}
          onConfirm={async () => {
            const capsule = capsulePendingDelete;
            setCapsulePendingDelete(null);
            await onDelete(capsule);
          }}
        />
      )}
    </div>
  );
}

function ConfirmationDialog({
  eyebrow,
  title,
  description,
  detail,
  icon: Icon = AlertTriangle,
  tone = 'warning',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  onCancel,
  onConfirm,
}) {
  const confirmButtonRef = useRef(null);
  const danger = tone === 'danger';

  useEffect(() => {
    confirmButtonRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-description"
        className="w-full max-w-[430px] overflow-hidden rounded-lg border border-[#30383d] bg-[#111518] shadow-2xl shadow-black/70"
      >
        <div className="flex items-start gap-4 px-5 pb-4 pt-5">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border ${danger ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
            <Icon size={19} />
          </div>
          <div className="min-w-0 pt-0.5">
            <div className={`text-[10px] font-bold uppercase tracking-widest ${danger ? 'text-red-400' : 'text-amber-400'}`}>{eyebrow}</div>
            <h2 id="confirmation-dialog-title" className="mt-1.5 text-base font-semibold text-slate-100">{title}</h2>
            <p id="confirmation-dialog-description" className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
          </div>
        </div>
        {detail && (
          <div className="mx-5 mb-5 flex items-start gap-2.5 rounded-md border border-[#252c30] bg-[#0b0e10] px-3 py-2.5 text-xs leading-5 text-slate-500">
            <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${danger ? 'text-red-400' : 'text-amber-400'}`} />
            <span>{detail}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[#252c30] bg-[#0d1012] px-5 py-3.5">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-9 rounded-md border border-[#30383d] px-4 text-xs font-semibold text-slate-300 hover:bg-[#1b2226] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex h-9 min-w-[112px] items-center justify-center gap-2 rounded-md px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-[#377894] hover:bg-[#438aa7]'}`}
          >
            {busy && <RefreshCw size={13} className="animate-spin" />}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ContextMenuItem({ icon: Icon, label, onClick, danger = false }) {
  return <button onClick={onClick} className={`flex h-9 w-full items-center gap-3 px-3 text-left text-xs ${danger ? 'text-red-300 hover:bg-red-500/10' : 'text-slate-300 hover:bg-[#1b2226] hover:text-white'}`}><Icon size={14} className="shrink-0" /><span className="truncate">{label}</span></button>;
}

function ContextMenuDivider() {
  return <div className="my-1 h-px bg-[#252c30]" />;
}

function PluginStatusBadge({ status }) {
  if (!status || !status.total) return null;
  if (!status.inventory_available) {
    return (
      <span title="REAPER plugin inventory was not found, so plugin readiness cannot be verified." className="inline-flex items-center rounded border border-slate-700/70 bg-slate-800/40 px-1.5 py-0.5 text-[10px] text-slate-400">
        Plugins Unverified
      </span>
    );
  }
  if (status.missing > 0) {
    const missing = status.missing_plugins || [];
    const extra = Math.max(0, status.missing - missing.length);
    const title = missing.length
      ? `Missing plugins: ${missing.join(', ')}${extra ? ` and ${status.missing} total` : ''}`
      : `Missing ${status.missing} plugins`;
    return (
      <span title={title} className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        Missing {status.missing} plugins
      </span>
    );
  }
  return (
    <span title={`Matched ${status.available}/${status.total} plugins`} className="inline-flex items-center rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
      Plugins Ready
    </span>
  );
}

function MissingPluginPreview({ status }) {
  const missing = status?.missing_plugins || [];
  if (!status?.inventory_available || !missing.length) return null;
  const shown = missing.slice(0, 3);
  const extra = Math.max(0, missing.length - shown.length);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] text-amber-300/80">Missing</span>
      {shown.map((name) => (
        <span key={name} title={name} className="max-w-[180px] truncate rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
          {name}
        </span>
      ))}
      {extra > 0 && <span className="text-[10px] text-slate-500">+{extra}</span>}
    </div>
  );
}

function ContactsView({ contacts, onlineContacts, onSend, onDelete, onPing, showAddForm, setShowAddForm, onAdd }) {
  const trustedCount = contacts.filter((contact) => contact.peer_id && contact.public_key).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Devices</h1>
          <p className="mt-1 text-xs text-slate-600">Manage trusted workstations and LAN transfer endpoints.</p>
        </div>
        <button onClick={() => setShowAddForm(true)} className="flex items-center gap-2 rounded-md bg-[#377894] px-4 py-2 text-sm text-white hover:bg-[#438aa7]"><UserPlus size={16} /><span>Add Device</span></button>
      </div>
      {showAddForm && <AddContactForm onCancel={() => setShowAddForm(false)} onSubmit={onAdd} />}
      <div className="mb-4 grid grid-cols-3 border-y border-[#20262a] bg-[#0b0e10]">
        <DeviceStat label="Saved Devices" value={contacts.length} />
        <DeviceStat label="Online Now" value={onlineContacts.length} accent />
        <DeviceStat label="Trusted Identity" value={trustedCount} />
      </div>
      <section className="min-h-0 flex-1 overflow-hidden rounded-lg border border-[#20262a] bg-[#0b0e10]">
        <div className="grid h-11 grid-cols-[minmax(220px,1.2fr)_110px_minmax(180px,1fr)_120px_150px_112px] items-center gap-4 border-b border-[#252c30] bg-[#151a1d] px-4 text-[11px] font-bold uppercase tracking-wider text-slate-500">
          <span>Device</span><span>Status</span><span>Address</span><span>Identity</span><span>Last Seen</span><span className="text-right">Actions</span>
        </div>
        <div className="h-[calc(100%-44px)] overflow-y-auto custom-scrollbar">
        {contacts.map((contact) => {
          const online = contact.last_seen && Date.now() - new Date(contact.last_seen).getTime() < 5 * 60 * 1000;
          const trusted = Boolean(contact.peer_id && contact.public_key);
          const address = `${contact.last_ip || contact.ip}:${contact.last_port || contact.port}`;
          return (
            <div key={contact.id} className="grid min-h-[68px] grid-cols-[minmax(220px,1.2fr)_110px_minmax(180px,1fr)_120px_150px_112px] items-center gap-4 border-b border-[#20262a] px-4 hover:bg-[#101518]">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#2a3338] bg-[#151a1d] text-sm font-bold uppercase text-slate-400">
                  {(contact.name || '?')[0]}
                  <div className={`absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-[#0b0e10] ${online ? 'bg-[#75a8c0]' : 'bg-slate-700'}`} />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-200">{contact.name}</div>
                  <div className="mt-0.5 truncate text-[10px] font-mono text-slate-600">{trusted ? `Peer ${contact.peer_id?.slice(0, 8)}` : 'Unverified endpoint'}</div>
                </div>
              </div>
              <div className={`flex items-center gap-2 text-xs ${online ? 'text-[#75a8c0]' : 'text-slate-600'}`}><span className={`h-2 w-2 rounded-full ${online ? 'bg-[#75a8c0]' : 'bg-slate-700'}`} />{online ? 'Online' : 'Offline'}</div>
              <div className="truncate text-xs font-mono text-slate-400">{address}</div>
              <div><span className={`rounded border px-2 py-1 text-[10px] ${trusted ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/25 bg-amber-500/10 text-amber-300'}`}>{trusted ? 'Trusted' : 'IP Only'}</span></div>
              <div className="truncate text-xs text-slate-600">{contact.last_seen ? formatDate(contact.last_seen) : 'Not detected'}</div>
              <div className="flex justify-end gap-1">
                <button onClick={() => onSend(contact)} className="flex h-8 w-8 items-center justify-center rounded-md bg-[#377894] text-white hover:bg-[#438aa7]" title="Start transfer"><Send size={14} /></button>
                <button onClick={() => onPing(contact)} className="flex h-8 w-8 items-center justify-center rounded-md border border-[#252c30] text-slate-500 hover:bg-[#151a1d] hover:text-white" title="Verify address"><RefreshCw size={14} /></button>
                <button onClick={() => onDelete(contact)} className="flex h-8 w-8 items-center justify-center rounded-md border border-[#252c30] text-slate-600 hover:bg-red-500/10 hover:text-red-300" title="Delete device"><Trash2 size={14} /></button>
              </div>
            </div>
          );
        })}
        {contacts.length === 0 && <button onClick={() => setShowAddForm(true)} className="flex h-48 w-full flex-col items-center justify-center text-slate-600 hover:text-slate-400"><Users size={28} /><span className="mt-3 text-sm">Add your first LAN device</span></button>}
        </div>
      </section>
    </div>
  );
}

function formatTime(seconds = 0) {
  if (!Number.isFinite(seconds)) return '0:00';
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

function renderPeakEnvelope(channelData, context) {
  const channels = channelData?.filter(Boolean) || [];
  if (!channels.length) return;
  const { width, height } = context.canvas;
  const center = height / 2;
  const samplesPerPixel = Math.max(1, channels[0].length / width);
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#53616a';

  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * samplesPerPixel);
    const end = Math.min(channels[0].length, Math.ceil((x + 1) * samplesPerPixel));
    let min = 1;
    let max = -1;
    for (const channel of channels) {
      for (let index = start; index < end; index += 1) {
        const sample = channel[index] || 0;
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
    }
    const top = Math.max(0, center - max * center);
    const bottom = Math.min(height, center - min * center);
    context.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

function DeviceStat({ label, value, accent = false }) {
  return (
    <div className="border-r border-[#20262a] px-5 py-3 last:border-r-0">
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-600">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${accent ? 'text-[#75a8c0]' : 'text-slate-200'}`}>{value}</div>
    </div>
  );
}

function AddContactForm({ onCancel, onSubmit }) {
  const [form, setForm] = useState({ name: '', ip: '', port: '', note: '' });
  const updateIp = (value) => {
    const parsed = parseHostPort(value);
    setForm((prev) => ({ ...prev, ip: parsed.ip, port: parsed.port || prev.port }));
  };
  return <div className="mb-4 rounded-lg border border-[#2a3338] bg-[#0b0e10] p-4"><h3 className="mb-4 text-sm font-bold text-slate-200">Add Device</h3><div className="grid grid-cols-1 gap-3 md:grid-cols-4"><FormField label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></FormField><FormField label="Current IP"><input value={form.ip} placeholder="Paste IP:port" onChange={(e) => updateIp(e.target.value)} /></FormField><FormField label="Port"><input value={form.port} placeholder="Default 5005" onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '').slice(0, 5) })} /></FormField><FormField label="Note"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></FormField></div><div className="mt-4 flex items-center justify-between"><p className="text-xs text-slate-600">The device identity will be verified and bound to its peer ID when available.</p><div className="flex gap-2"><button onClick={onCancel} className="px-3 py-2 text-sm text-slate-500 hover:text-white">Cancel</button><button onClick={() => form.name && form.ip && onSubmit({ ...form, port: Number(form.port) || 5005 })} className="rounded-md bg-[#377894] px-4 py-2 text-sm text-white hover:bg-[#438aa7]">Save Device</button></div></div></div>;
}

function FormField({ label, children }) {
  return <label className="block"><span className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">{label}</span>{React.cloneElement(children, { className: 'w-full bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500' })}</label>;
}

function TransferView({ capsules, contacts, selectedCapsules, setSelectedCapsules, targetContacts, setTargetContacts, tempPeer, setTempPeer, showTempPeerForm, setShowTempPeerForm, isSending, transferProgress, onSend }) {
  const toggleCapsule = (cap) => setSelectedCapsules((prev) => (prev.find((c) => c.id === cap.id) ? prev.filter((c) => c.id !== cap.id) : [...prev, cap]));
  const toggleTarget = (contact) => setTargetContacts((prev) => (prev.find((c) => c.id === contact.id) ? prev.filter((c) => c.id !== contact.id) : [...prev, contact]));
  const recipientCount = targetContacts.length + (tempPeer.ip ? 1 : 0);
  const totalTasks = selectedCapsules.length * recipientCount;
  const selectedBytes = selectedCapsules.reduce((sum, capsule) => sum + (capsule.size_bytes || 0), 0);
  const progressValue = Number.isFinite(Number(transferProgress?.progress))
    ? Math.max(0, Math.min(100, Number(transferProgress.progress)))
    : null;
  const transferPhaseLabels = {
    preparing: 'Preparing package',
    waiting_for_acceptance: 'Waiting for acceptance',
    transferring: transferProgress?.direction === 'receive' ? 'Receiving' : 'Sending',
    completed: 'Transfer complete',
    error: 'Transfer failed',
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-white">Transfer</h1>
        <p className="mt-1 text-xs text-slate-600">Prepare capsules and send them directly to devices on your LAN.</p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 min-[1100px]:grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)_276px] xl:grid-cols-[minmax(340px,1fr)_minmax(340px,1fr)_300px]">
        <TransferPanel title="Capsules" meta={`${selectedCapsules.length} selected`}>
          <div className="grid h-10 grid-cols-[1fr_auto] items-center border-b border-[#20262a] px-4 text-[10px] font-bold uppercase tracking-widest text-slate-600">
            <span>Project Capsule</span><span>Size</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
            {capsules.map((cap) => {
              const selected = selectedCapsules.some((item) => item.id === cap.id);
              return (
                <button key={cap.id} onClick={() => toggleCapsule(cap)} className={`grid min-h-[60px] w-full grid-cols-[1fr_auto] items-center gap-4 border-b px-4 text-left transition-colors ${selected ? 'border-[#315c70] bg-[#142027]' : 'border-[#20262a] hover:bg-[#101518]'}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-[#377894] bg-[#377894] text-white' : 'border-[#30383d] bg-[#111518] text-transparent'}`}><Check size={12} /></span>
                    <FileAudio size={16} className={selected ? 'text-[#75a8c0]' : 'text-slate-600'} />
                    <div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-200">{cap.name}</div><div className="mt-1 text-[10px] text-slate-600">{cap.project_file || 'REAPER project package'}</div></div>
                  </div>
                  <span className="text-[10px] text-slate-500">{formatBytes(cap.size_bytes)}</span>
                </button>
              );
            })}
            {capsules.length === 0 && <div className="flex h-48 items-center justify-center text-xs text-slate-600">The capsule library is empty.</div>}
          </div>
        </TransferPanel>

        <TransferPanel title="Destination Devices" meta={`${recipientCount} selected`}>
          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
            {contacts.map((contact) => {
              const selected = targetContacts.some((item) => item.id === contact.id);
              const trusted = Boolean(contact.peer_id && contact.public_key);
              const online = contact.last_seen && Date.now() - new Date(contact.last_seen).getTime() < 5 * 60 * 1000;
              return (
                <button key={contact.id} onClick={() => toggleTarget(contact)} className={`flex min-h-[68px] w-full items-center gap-3 border-b px-4 text-left transition-colors ${selected ? 'border-[#315c70] bg-[#142027]' : 'border-[#20262a] hover:bg-[#101518]'}`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-[#377894] bg-[#377894] text-white' : 'border-[#30383d] bg-[#111518] text-transparent'}`}><Check size={12} /></span>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#2a3338] bg-[#151a1d] text-xs font-bold text-slate-400">{(contact.name || '?')[0]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="truncate text-xs font-semibold text-slate-200">{contact.name}</span><span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-[#75a8c0]' : 'bg-slate-700'}`} /></div>
                    <div className="mt-1 truncate text-[10px] font-mono text-slate-600">{contact.last_ip || contact.ip}:{contact.last_port || contact.port}</div>
                  </div>
                  <span className={`rounded border px-2 py-1 text-[9px] ${trusted ? 'border-emerald-500/25 text-emerald-300' : 'border-amber-500/25 text-amber-300'}`}>{trusted ? 'Trusted' : 'IP Only'}</span>
                </button>
              );
            })}
            {contacts.length === 0 && <div className="flex h-32 items-center justify-center text-xs text-slate-600">No saved devices.</div>}
          </div>
          <div className="border-t border-[#20262a] p-3">
            <button onClick={() => setShowTempPeerForm((value) => !value)} className="flex w-full items-center justify-center gap-2 rounded-md border border-[#2a3338] bg-[#111518] py-2 text-xs text-slate-400 hover:border-[#315c70] hover:text-slate-200"><Plus size={14} />Temporary IP</button>
            {showTempPeerForm && <div className="mt-3 grid grid-cols-[1fr_90px] gap-2"><input className="rounded-md border border-[#2a3338] bg-[#090b0d] px-3 py-2 text-xs text-slate-200 outline-none focus:border-[#377894]" placeholder="Remote IP" value={tempPeer.ip} onChange={(e) => setTempPeer({ ...tempPeer, ip: e.target.value })} /><input className="rounded-md border border-[#2a3338] bg-[#090b0d] px-3 py-2 text-xs text-slate-200 outline-none focus:border-[#377894]" placeholder="Port" value={tempPeer.port} onChange={(e) => setTempPeer({ ...tempPeer, port: e.target.value })} /></div>}
          </div>
        </TransferPanel>

        <aside className="flex min-h-0 flex-col rounded-lg border border-[#20262a] bg-[#0b0e10]">
          <div className="border-b border-[#20262a] px-5 py-4"><h2 className="text-sm font-bold text-slate-200">Transfer Summary</h2><p className="mt-1 text-[10px] text-slate-600">Review the delivery before sending.</p></div>
          <div className="flex-1 space-y-5 px-5 py-5">
            <SummaryRow label="Capsules" value={selectedCapsules.length} />
            <SummaryRow label="Destinations" value={recipientCount} />
            <SummaryRow label="Total Size" value={formatBytes(selectedBytes)} />
            <SummaryRow label="Transfer Tasks" value={totalTasks} />
            {transferProgress && <div className="rounded-lg border border-[#2a3338] bg-[#101518] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-slate-200">
                    {transferProgress.direction === 'receive' ? 'Receiving' : 'Sending'} {transferProgress.capsule_name || 'Capsule'}
                  </div>
                  <div className="mt-1 truncate text-[10px] text-slate-500">
                    {transferProgress.direction === 'receive' ? 'from' : 'to'} {transferProgress.peer_name || transferProgress.target_ip || 'device'}
                  </div>
                </div>
                {transferProgress.task_total > 1 && <span className="shrink-0 text-[10px] text-slate-500">Task {transferProgress.task_index || 1}/{transferProgress.task_total}</span>}
              </div>
              <div className="mt-3 flex items-center justify-between text-[10px]">
                <span className={transferProgress.phase === 'error' ? 'text-red-300' : transferProgress.phase === 'completed' ? 'text-emerald-300' : 'text-[#75a8c0]'}>
                  {transferPhaseLabels[transferProgress.phase] || 'Working'}
                </span>
                <span className="font-mono text-slate-400">{progressValue === null ? '...' : `${progressValue.toFixed(progressValue >= 10 ? 0 : 1)}%`}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#090b0d]">
                {progressValue === null
                  ? <div className="h-full w-1/3 animate-pulse rounded-full bg-[#377894]" />
                  : <div className={`h-full rounded-full transition-[width] duration-200 ${transferProgress.phase === 'error' ? 'bg-red-500' : transferProgress.phase === 'completed' ? 'bg-emerald-500' : 'bg-[#377894]'}`} style={{ width: `${progressValue}%` }} />}
              </div>
              <div className="mt-2 flex justify-between gap-3 text-[10px] text-slate-500">
                <span>{transferProgress.total_bytes ? `${formatBytes(transferProgress.bytes_transferred)} / ${formatBytes(transferProgress.total_bytes)}` : 'Calculating size...'}</span>
                <span>{transferProgress.bytes_per_second ? `${formatBytes(transferProgress.bytes_per_second)}/s` : ''}</span>
              </div>
              {transferProgress.error && <div className="mt-2 text-[10px] leading-relaxed text-red-300">{transferProgress.error}</div>}
            </div>}
            <div className="border-t border-[#20262a] pt-5">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-widest text-slate-600">Selected Content</div>
              <div className="space-y-2">
                {selectedCapsules.slice(0, 4).map((capsule) => <div key={capsule.id} className="truncate text-xs text-slate-400">{capsule.name}</div>)}
                {selectedCapsules.length > 4 && <div className="text-xs text-slate-600">+{selectedCapsules.length - 4} more capsules</div>}
                {selectedCapsules.length === 0 && <div className="text-xs text-slate-600">No capsules selected</div>}
              </div>
            </div>
          </div>
          <div className="border-t border-[#20262a] p-4">
            <button disabled={selectedCapsules.length === 0 || totalTasks === 0 || isSending} onClick={onSend} className={`flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold ${isSending || selectedCapsules.length === 0 || totalTasks === 0 ? 'cursor-not-allowed bg-[#171c1f] text-slate-600' : 'bg-[#377894] text-white hover:bg-[#438aa7]'}`}>{isSending ? <><RefreshCw size={16} className="animate-spin" />Sending...</> : <><Send size={16} />Send Now</>}</button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function TransferPanel({ title, meta, children }) {
  return <section className="flex min-h-[360px] flex-col overflow-hidden rounded-lg border border-[#20262a] bg-[#0b0e10]"><div className="flex h-12 shrink-0 items-center justify-between border-b border-[#20262a] px-4"><h2 className="text-sm font-bold text-slate-200">{title}</h2><span className="text-[10px] text-slate-600">{meta}</span></div>{children}</section>;
}

function SummaryRow({ label, value }) {
  return <div className="flex items-baseline justify-between"><span className="text-xs text-slate-600">{label}</span><span className="text-sm font-semibold text-slate-200">{value}</span></div>;
}

function SettingsView({ networkInfo, apiBase, appVersion, bridgeStatus, showCaptureDebug, onToggleCaptureDebug, onRefreshBridge, onOpenSetup }) {
  const [checkingBridge, setCheckingBridge] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatePhase, setUpdatePhase] = useState('');
  const toast = useToast();

  useEffect(() => {
    onRefreshBridge();
  }, [onRefreshBridge]);

  const refresh = async () => {
    setCheckingBridge(true);
    try {
      await onRefreshBridge();
    } finally {
      setCheckingBridge(false);
    }
  };

  const bridgeOk = bridgeStatus?.setup_state === 'READY';
  const bridgeLabel = bridgeOk
    ? `Connected v${bridgeStatus.bridge_version || ''}`
    : bridgeStatus?.setup_message || 'REAPER setup is incomplete';

  const checkForUpdate = async () => {
    setUpdateBusy(true);
    setUpdatePhase('checking');
    try {
      const info = await api.checkUpdate();
      setUpdateInfo(info);
      if (!info.enabled) {
        toast.info(info.message);
      } else if (info.update_available) {
        toast.success(`New version available: ${info.latest_version}`);
      } else {
        toast.success(info.message || 'You are on the latest version.');
      }
    } catch (e) {
      toast.error(`Update check failed: ${e.message}`);
    } finally {
      setUpdateBusy(false);
      setUpdatePhase('');
    }
  };

  const installUpdate = async () => {
    if (!updateInfo?.package_url || !updateInfo?.sha256 || !updateInfo?.latest_version || !updateInfo?.latest_build) return;
    setUpdateBusy(true);
    try {
      setUpdatePhase('copying');
      const downloaded = await api.downloadUpdate({
        packageUrl: updateInfo.package_url,
        sha256: updateInfo.sha256,
        version: updateInfo.latest_version,
        build: updateInfo.latest_build,
      });
      setUpdatePhase('installing');
      toast.info('The app will close and install the update.');
      await api.installUpdate({
        packagePath: downloaded.package_path,
        version: downloaded.version,
        build: downloaded.build,
      });
      toast.success('Updater started. The app will close to finish installation.');
      setUpdatePhase('installing');
    } catch (e) {
      toast.error(`Update installation failed: ${e.message}`);
      setUpdateBusy(false);
      setUpdatePhase('');
    }
  };

  const updateButtonLabel = updatePhase === 'checking'
    ? 'Checking...'
    : updatePhase === 'copying'
      ? 'Copying update package...'
      : updatePhase === 'installing'
        ? 'Installing...'
        : 'Check for Updates';

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-200">Software Update</h3>
              {appVersion && <span className="rounded border border-[#315c70] bg-[#142027] px-2 py-0.5 font-mono text-[10px] text-[#75a8c0]">v{appVersion}</span>}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {updateInfo ? `Current version ${updateInfo.current_version} · ${updateInfo.message}` : 'Check the configured update source.'}
            </p>
          </div>
          <button onClick={checkForUpdate} disabled={updateBusy} className="px-3 py-2 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg disabled:opacity-40 shrink-0 flex items-center space-x-2">
            <RefreshCw size={14} className={updateBusy ? 'animate-spin' : ''} />
            <span>{updateButtonLabel}</span>
          </button>
        </div>
        {updateInfo?.update_available && (
          <div className="mt-4 rounded-xl border border-indigo-500/25 bg-indigo-500/10 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-bold text-indigo-200">Update available: {updateInfo.latest_version}</div>
                <div className="text-xs text-slate-400 mt-1">Package size: {formatBytes(updateInfo.size || 0)}</div>
                {updateInfo.notes?.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-slate-300 list-disc list-inside">
                    {updateInfo.notes.slice(0, 4).map((note, idx) => <li key={`${note}-${idx}`}>{note}</li>)}
                  </ul>
                )}
              </div>
              <button onClick={installUpdate} disabled={updateBusy} className="px-4 py-2 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40 shrink-0 flex items-center space-x-2">
                <Download size={14} />
                <span>Update Now</span>
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6">
        <h3 className="text-sm font-bold text-slate-200 mb-4">REAPER Setup</h3>
        <div className={`rounded-xl border p-4 mb-4 ${bridgeOk ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-amber-500/10 border-amber-500/25'}`}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center space-x-3 min-w-0">
              <Radio size={18} className={bridgeOk ? 'text-emerald-400' : 'text-amber-400'} />
              <div className="min-w-0">
                <div className="text-sm font-bold text-slate-200">{bridgeLabel}</div>
                <div className="text-xs text-slate-500 mt-1">Capture verifies WebUI, Bridge, the resource path, and selected items.</div>
              </div>
            </div>
            <button onClick={refresh} disabled={checkingBridge} className="px-3 py-2 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg disabled:opacity-40 shrink-0">{checkingBridge ? 'Checking...' : 'Recheck'}</button>
          </div>
          {bridgeStatus?.error && <div className="mt-3 text-xs text-amber-300 flex items-start space-x-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{bridgeStatus.error}</span></div>}
          {bridgeStatus?.bridge_update_available && <div className="mt-3 text-xs text-sky-300">Bridge v{bridgeStatus.desired_bridge_version} is available. The current Bridge remains compatible, so capture is not blocked.</div>}
        </div>
        <button onClick={onOpenSetup} className="w-full px-4 py-3 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl flex items-center justify-center space-x-2">
          <Settings size={16} />
          <span>{bridgeOk ? 'Manage REAPER Connection' : 'Open Setup Wizard'}</span>
        </button>
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-200">Capture Debug Window</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Shows Bridge phase, copy progress, preview diagnostics, and raw command/result state while capturing.
            </p>
          </div>
          <button
            onClick={() => onToggleCaptureDebug(!showCaptureDebug)}
            className={`shrink-0 rounded-lg px-4 py-2 text-xs font-semibold ${showCaptureDebug ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {showCaptureDebug ? 'Debug On' : 'Debug Off'}
          </button>
        </div>
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6 space-y-3 text-sm">
        <h3 className="text-sm font-bold text-slate-200 mb-4">Connected REAPER</h3>
        <Row k="Status" v={bridgeStatus?.setup_state || 'Unknown'} />
        <Row k="WebUI Port" v={bridgeStatus?.webui_port} />
        <Row k="Version" v={bridgeStatus?.bridge_app_version} />
        <Row k="Application Path" v={bridgeStatus?.bridge_exe_path} />
        <Row k="Resource Path" v={bridgeStatus?.bridge_resource_path} />
        <Row k="Selected Items" v={bridgeStatus?.selected_item_count ?? 'Unknown'} />
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6 space-y-3 text-sm">
        <h3 className="text-sm font-bold text-slate-200 mb-4">Saved Binding</h3>
        <Row k="Version" v={bridgeStatus?.confirmed_reaper_app_version} />
        <Row k="Application Path" v={bridgeStatus?.confirmed_reaper_exe_path} />
        <Row k="Resource Path" v={bridgeStatus?.confirmed_reaper_resource_path} />
        <Row k="Confirmed At" v={bridgeStatus?.confirmed_at ? formatDate(bridgeStatus.confirmed_at) : ''} />
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 space-y-3 text-sm"><Row k="API Address" v={apiBase} /><Row k="Hostname" v={networkInfo?.hostname} /><Row k="Device ID" v={networkInfo?.peer_id} /><Row k="Identity Fingerprint" v={networkInfo?.peer_fingerprint} /><Row k="Primary IP" v={networkInfo?.ip} /><Row k="Listening Port" v={networkInfo?.port} /><Row k="All IPs" v={(networkInfo?.all_ips || []).join('  ·  ')} /><Row k="Shared Token" v={networkInfo?.shared_token_required ? 'Enabled' : 'Disabled'} /></div>
      <p className="text-xs text-slate-500 mt-4 leading-relaxed">Run this app only on a trusted LAN. When a shared token is enabled, senders must include the same <code className="text-slate-300">X-Capsule-Token</code>.</p>
    </div>
  );
}

function SetupWizard({ status, onClose, onRefresh }) {
  const [current, setCurrent] = useState(status);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [port, setPort] = useState(String(status?.webui_port || 9000));
  const toast = useToast();

  useEffect(() => {
    setCurrent(status);
    if (status?.webui_port) setPort(String(status.webui_port));
  }, [status]);

  const refresh = async () => {
    setChecking(true);
    try {
      const next = await onRefresh();
      setCurrent(next);
      return next;
    } finally {
      setChecking(false);
    }
  };

  const savePortAndRefresh = async () => {
    const nextPort = Number(port) || 9000;
    try {
      await api.updateSettings({ webui_port: nextPort });
      toast.success(`WebUI port set to ${nextPort}`);
      await refresh();
    } catch (e) {
      toast.error(`Failed to save port: ${e.message}`);
    }
  };

  const openScriptFolder = async () => {
    try {
      await api.openReaperBridgeScriptFolder();
      toast.success('Script folder opened');
    } catch (e) {
      toast.error(`Failed to open script folder: ${e.message}`);
    }
  };

  const confirmCurrentReaper = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const r = await api.confirmReaperBridge({ webui_port: Number(port) || 9000 });
      setCurrent(r.data);
      toast.success('REAPER setup saved');
      onRefresh();
      onClose();
    } catch (e) {
      toast.error(`Save failed: ${e.message}`);
    } finally {
      setConfirming(false);
    }
  };

  const state = current?.setup_state || 'NEED_WEBUI';
  const currentStep = !current?.webui_available ? 0 : (!current?.bridge_available || state === 'NEED_REPAIR' ? 1 : 2);
  const canConfirm = current?.webui_available && current?.bridge_available && current?.bridge_resource_path;

  const steps = [
    { title: 'Open the target REAPER and enable WebUI', done: Boolean(current?.webui_available) },
    { title: 'Run the Bridge installer in the current REAPER', done: Boolean(current?.bridge_available) && state !== 'NEED_REPAIR' },
    { title: 'Confirm and save the current REAPER', done: state === 'READY' },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto custom-scrollbar bg-[#161920] border border-slate-700 rounded-2xl shadow-2xl">
        <div className="sticky top-0 bg-[#161920] border-b border-slate-800 p-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white">REAPER Setup Wizard</h2>
            <p className="text-sm text-slate-500 mt-1">{current?.setup_message || 'Complete the REAPER setup steps.'}</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-200"><X size={18} /></button>
        </div>

        <div className="p-5">
          <div className="grid grid-cols-3 gap-3 mb-6">
            {steps.map((step, index) => (
              <div key={step.title} className={`border rounded-xl p-3 ${step.done ? 'border-emerald-500/30 bg-emerald-500/10' : index === currentStep ? 'border-indigo-500/40 bg-indigo-500/10' : 'border-slate-800 bg-[#0f1115]'}`}>
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step.done ? 'bg-emerald-500 text-white' : index === currentStep ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-500'}`}>{step.done ? <Check size={13} /> : index + 1}</div>
                  <div className="text-xs font-semibold text-slate-200 leading-tight">{step.title}</div>
                </div>
              </div>
            ))}
          </div>

          {currentStep === 0 && (
            <div className="space-y-4">
              <div className="bg-[#0f1115] border border-slate-800 rounded-xl p-5">
                <h3 className="text-sm font-bold text-slate-100 mb-3">1. Open the REAPER instance you want to use with Capsule Transfer</h3>
                <div className="text-sm text-slate-400 leading-7">
                  On Windows, open the target REAPER instance, not another portable or test installation. Then go to:
                  <div className="mt-2 font-mono text-xs text-slate-200 bg-black/20 border border-slate-800 rounded-lg p-3">Options → Preferences → Control/OSC/Web → Add → Web browser interface → Port {port}</div>
                </div>
                <div className="flex items-center gap-3 mt-4">
                  <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} className="w-28 bg-[#161920] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200" />
                  <button onClick={savePortAndRefresh} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">Save Port and Check</button>
                  <button onClick={refresh} disabled={checking} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40">{checking ? 'Checking...' : 'Recheck'}</button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="space-y-4">
              <div className="bg-[#0f1115] border border-slate-800 rounded-xl p-5">
                <h3 className="text-sm font-bold text-slate-100 mb-3">2. Run the installer in the current REAPER</h3>
                <div className="text-sm text-slate-400 leading-7">
                  For the first installation, open Actions, choose Load ReaScript, then load and run:
                  <div className="mt-2 font-mono text-xs text-slate-200 bg-black/20 border border-slate-800 rounded-lg p-3 break-all">{current?.installer_script || 'install_capsule_bridge.lua'}</div>
                  The installer keeps one canonical Action entry, replaces the installed files, and switches the running Bridge without requiring a REAPER restart. Compatible app updates do not require rerunning it.
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-4">
                  <button onClick={openScriptFolder} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg flex items-center gap-2"><FolderOpen size={15} />Open Script Folder</button>
                  <button onClick={refresh} disabled={checking} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40">{checking ? 'Checking...' : 'I Ran It, Recheck'}</button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-4">
              {state === 'MISMATCHED_REAPER' && <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-200">The connected REAPER uses a different resource path from the saved instance. Close the wrong instance, open the correct REAPER, and recheck.</div>}
              <div className="bg-[#0f1115] border border-slate-800 rounded-xl p-5 space-y-3 text-sm">
                <h3 className="text-sm font-bold text-slate-100 mb-3">3. Confirm the Target REAPER</h3>
                <Row k="Version" v={current?.bridge_app_version} />
                <Row k="Application Path" v={current?.bridge_exe_path} />
                <Row k="Resource Path" v={current?.bridge_resource_path} />
                <Row k="Saved Resource Path" v={current?.confirmed_reaper_resource_path} />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button onClick={refresh} disabled={checking || confirming} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg disabled:opacity-40">{checking ? 'Checking...' : 'Recheck'}</button>
                <button onClick={confirmCurrentReaper} disabled={!canConfirm || confirming || checking} className="px-5 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-40 flex items-center gap-2">
                  {confirming && <RefreshCw size={14} className="animate-spin" />}
                  <span>{confirming ? 'Saving...' : 'Confirm and Save'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return <div className="flex justify-between border-b border-slate-800 pb-2"><span className="text-slate-500">{k}</span><span className="text-slate-200 font-mono text-right break-all">{v ?? '—'}</span></div>;
}

function IncomingRequestsOverlay({ requests, onAccept, onReject, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-6 w-[420px] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-white">Pending Transfers</h3>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-slate-200"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
          {requests.map((req) => (
            <div key={req.id} className="bg-[#0f1115] border border-slate-800 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-200 truncate">{req.capsule_name || 'Capsule'}</div>
                  <div className="text-xs text-slate-500 mt-1">From {req.sender_name || req.sender_ip || 'Unknown Device'}</div>
                  <div className="text-[10px] text-slate-600 mt-1">{formatBytes(req.size_bytes || 0)}{req.capsule_type ? ` · ${req.capsule_type}` : ''}</div>
                </div>
              </div>
              <div className="flex justify-end space-x-2 mt-4">
                <button onClick={() => onReject(req)} className="px-4 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg">Reject</button>
                <button onClick={() => onAccept(req)} className="px-4 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shadow-lg shadow-indigo-600/20">Accept</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CaptureOverlay({ status, onClose }) {
  const isWorking = ['exporting', 'saving', 'rendering'].includes(status.phase);
  const isDone = status.phase === 'done';
  const isError = status.phase === 'error';
  const steps = status.steps || [];
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"><div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-8 w-[380px] shadow-2xl text-center">{isWorking && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-indigo-600/20 flex items-center justify-center"><RefreshCw size={28} className="text-indigo-400 animate-spin" /></div><h3 className="text-lg font-bold text-white mb-2">Capturing Capsule</h3><p className="text-sm text-slate-400 leading-relaxed whitespace-pre-line">{status.message}</p><div className="mt-5 h-1 bg-slate-800 rounded-full overflow-hidden"><div className="h-full w-2/3 bg-indigo-500 rounded-full animate-pulse" /></div></>}{isDone && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-emerald-600/20 flex items-center justify-center"><Zap size={28} className="text-emerald-400" fill="currentColor" /></div><h3 className="text-lg font-bold text-white mb-2">Capture Complete</h3><p className="text-sm text-slate-400 whitespace-pre-line">{status.message}</p></>}{isError && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-red-600/20 flex items-center justify-center"><FileAudio size={28} className="text-red-400" /></div><h3 className="text-lg font-bold text-white mb-2">Capture Failed</h3><p className="text-sm text-red-300 leading-relaxed whitespace-pre-line">{status.message}</p><button onClick={onClose} className="mt-5 px-5 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg">Close</button></>}</div></div>;
}

function CaptureOverlayV2({ status, onClose }) {
  const isWorking = ['exporting', 'saving', 'rendering'].includes(status.phase);
  const isDone = status.phase === 'done';
  const isError = status.phase === 'error';
  const showWorkingLayout = isWorking || (isDone && status.settled);
  const steps = status.steps || [];
  const progress = status.progress || {};
  const bytesTotal = Number(progress.bytes_total) || 0;
  const bytesDone = Number(progress.bytes_done) || 0;
  const fileTotal = Number(progress.total) || 0;
  const fileCurrent = Number(progress.current) || 0;
  const capturePercent = bytesTotal > 0
    ? Math.max(0, Math.min(100, bytesDone * 100 / bytesTotal))
    : fileTotal > 0
      ? Math.max(0, Math.min(100, fileCurrent * 100 / fileTotal))
      : null;
  const stepStyle = (step) => {
    if (step.status === 'done') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25';
    if (step.status === 'active') return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25';
    if (step.status === 'warning') return 'bg-amber-500/15 text-amber-300 border-amber-500/25';
    if (step.status === 'skipped') return 'bg-slate-800 text-slate-500 border-slate-700';
    return 'bg-slate-900 text-slate-500 border-slate-800';
  };
  const stepIcon = (step) => {
    if (step.status === 'done') return <Check size={13} />;
    if (step.status === 'active') return <RefreshCw size={13} className="animate-spin" />;
    if (step.status === 'warning') return <AlertTriangle size={13} />;
    if (step.status === 'skipped') return <X size={13} />;
    return <span className="block w-1.5 h-1.5 rounded-full bg-current" />;
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-8 w-[420px] shadow-2xl text-center">
        {showWorkingLayout && <>
          <div className={`w-14 h-14 mx-auto mb-5 rounded-full flex items-center justify-center ${isDone ? 'bg-emerald-600/20' : 'bg-indigo-600/20'}`}>{isDone ? <Check size={28} className="text-emerald-400" /> : <RefreshCw size={28} className="text-indigo-400 animate-spin" />}</div>
          <h3 className="text-lg font-bold text-white mb-2">{isDone ? 'Capture Complete' : 'Capturing Capsule'}</h3>
          <p className="text-sm text-slate-400 leading-relaxed whitespace-pre-line">{status.message}</p>
          {isWorking && progress.phase === 'copying_media' && <div className="mt-5 rounded-xl border border-slate-700 bg-[#11151b] p-3 text-left">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-slate-300">{progress.current_file ? `Copying ${progress.current_file}` : 'Media files copied'}</span>
              {fileTotal > 0 && <span className="shrink-0 font-mono text-slate-500">{Math.min(fileCurrent, fileTotal)}/{fileTotal}</span>}
            </div>
            {bytesTotal > 0 && <div className="mt-2 flex justify-between text-[10px] text-slate-500"><span>{formatBytes(bytesDone)} / {formatBytes(bytesTotal)}</span><span>{capturePercent?.toFixed(0)}%</span></div>}
          </div>}
        </>}
        {isDone && !status.settled && <>
          <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-emerald-600/20 flex items-center justify-center"><Zap size={28} className="text-emerald-400" fill="currentColor" /></div>
          <h3 className="text-lg font-bold text-white mb-2">Capture Complete</h3>
          <p className="text-sm text-slate-400 whitespace-pre-line">{status.message}</p>
        </>}
        {isError && <>
          <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-red-600/20 flex items-center justify-center"><FileAudio size={28} className="text-red-400" /></div>
          <h3 className="text-lg font-bold text-white mb-2">Capture Failed</h3>
          <p className="text-sm text-red-300 leading-relaxed whitespace-pre-line">{status.message}</p>
        </>}
        {steps.length > 0 && <div className="mt-6 space-y-2 text-left">
          {steps.map((step) => (
            <div key={step.id} className={`border rounded-xl px-3 py-2.5 flex items-start space-x-3 ${stepStyle(step)}`}>
              <div className="w-5 h-5 rounded-full border border-current/30 flex items-center justify-center mt-0.5 shrink-0">{stepIcon(step)}</div>
              <div className="min-w-0">
                <div className="text-sm font-semibold">{step.label}</div>
                {step.detail && <div className="text-xs opacity-75 mt-0.5 leading-relaxed">{step.detail}</div>}
              </div>
            </div>
          ))}
        </div>}
        {isWorking && <div className="mt-5 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          {capturePercent === null
            ? <div className="h-full w-2/3 bg-indigo-500 rounded-full animate-pulse" />
            : <div className="h-full bg-indigo-500 rounded-full transition-[width] duration-300" style={{ width: `${capturePercent}%` }} />}
        </div>}
        {(isDone || isError) && <button onClick={onClose} className="mt-5 px-5 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg">Close</button>}
      </div>
    </div>
  );
}

function parseDebugValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function compactDebugValue(value) {
  const parsed = parseDebugValue(value);
  if (parsed === null || parsed === undefined || parsed === '') return '';
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  return text.length > 1800 ? `${text.slice(0, 1800)}\n... truncated` : text;
}

function DebugRow({ label, value, mono = false }) {
  const display = value === undefined || value === null || value === '' ? '—' : value;
  return (
    <div className="grid grid-cols-[108px_minmax(0,1fr)] gap-3 text-xs">
      <div className="text-slate-600">{label}</div>
      <div className={`min-w-0 break-words text-slate-300 ${mono ? 'font-mono text-[11px]' : ''}`}>{display}</div>
    </div>
  );
}

function CaptureDebugPanel({ status, error, captureStatus, onClose, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const captureBusy = captureStatus && !['done', 'error'].includes(captureStatus.phase);
  const progress = captureStatus?.progress || status?.capture_progress || {};
  const rawItems = [
    ['Command', status?.command_v2 || status?.command || status?.last_command_debug],
    ['Result', status?.result_v2 || status?.result || status?.last_result_debug],
    ['Preview Render', status?.preview_render_debug],
    ['Preview Search', status?.preview_search_debug],
  ].filter(([, value]) => Boolean(value));

  const refresh = async () => {
    if (captureBusy) return;
    setRefreshing(true);
    try {
      await onRefresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[70] w-[440px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-slate-700 bg-[#11151b]/95 shadow-2xl shadow-black/50 backdrop-blur">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-[#151a21] px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-100">Capture Debug</div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">{captureStatus?.message || status?.setup_message || 'Bridge diagnostics'}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={refresh} disabled={refreshing || captureBusy} className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40">
            {captureBusy ? 'Live capture' : refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-200" title="Close debug window"><X size={14} /></button>
        </div>
      </div>
      <div className="max-h-[70vh] overflow-y-auto custom-scrollbar p-4">
        {error && <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div>}
        <div className="space-y-2">
          <DebugRow label="Setup" value={status?.setup_state || status?.status} />
          <DebugRow label="WebUI" value={status?.webui_available ? `OK :${status?.webui_port || status?.detected_webui_port || 9000}` : 'Unavailable'} />
          <DebugRow label="Bridge" value={status?.bridge_available ? `OK v${status?.bridge_version || ''}` : 'Unavailable'} />
          <DebugRow label="Phase" value={captureBusy ? captureStatus?.message || captureStatus?.phase : status?.export_phase || captureStatus?.phase} mono />
          <DebugRow label="Selected" value={status?.selected_item_count ?? 'Unknown'} />
          <DebugRow label="Heartbeat" value={status?.heartbeat_age_seconds !== undefined && status?.heartbeat_age_seconds !== null ? `${Number(status.heartbeat_age_seconds).toFixed(1)}s ago` : ''} />
          <DebugRow label="Progress" value={progress.phase ? `${progress.phase}${progress.current_file ? ` · ${progress.current_file}` : ''}` : ''} />
          <DebugRow label="Files" value={progress.total ? `${progress.current || 0}/${progress.total}` : ''} />
          <DebugRow label="Bytes" value={progress.bytes_total ? `${formatBytes(progress.bytes_done || 0)} / ${formatBytes(progress.bytes_total || 0)}` : ''} />
          <DebugRow label="Error" value={status?.error} />
        </div>
        {rawItems.length > 0 && (
          <div className="mt-4">
            <button onClick={() => setExpanded((v) => !v)} className="text-xs font-semibold text-indigo-300 hover:text-indigo-200">
              {expanded ? 'Hide raw diagnostics' : 'Show raw diagnostics'}
            </button>
            {expanded && <div className="mt-3 space-y-3">
              {rawItems.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-800 bg-[#0b0e10] p-3">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-300">{compactDebugValue(value)}</pre>
                </div>
              ))}
            </div>}
          </div>
        )}
        <div className="mt-4 text-[11px] leading-relaxed text-slate-600">
          {captureBusy
            ? 'Full diagnostics polling is paused during capture to avoid competing with REAPER WebUI. Phase and progress remain live.'
            : 'This window reads Bridge EXTSTATE diagnostics every five seconds without overlapping requests.'}
        </div>
      </div>
    </div>
  );
}

function CreateCapsuleForm({ onCancel, onSubmit }) {
  const [capsuleType, setCapsuleType] = useState('magic');
  const [renderPreview, setRenderPreview] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const CAPSULE_TYPES = [{ id: 'magic', label: 'Magic' }, { id: 'impact', label: 'Impact' }, { id: 'atmosphere', label: 'Atmosphere' }, { id: 'texture', label: 'Texture' }];
  const submit = async () => { setIsExporting(true); try { await onSubmit({ capsule_type: capsuleType, render_preview: renderPreview, webui_port: 9000 }); } finally { setIsExporting(false); } };

  return <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-5 mb-6"><h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center space-x-2"><FileAudio size={16} className="text-indigo-400" /><span>Capture from REAPER</span></h3><p className="text-xs text-slate-500 mb-5 leading-relaxed">Make sure REAPER is open, Bridge is installed, and the items to export are selected. Capture runs through Bridge in the background without changing focus.</p><div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5"><div><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Capsule Type</label><div className="grid grid-cols-2 gap-2">{CAPSULE_TYPES.map((t) => <button key={t.id} onClick={() => setCapsuleType(t.id)} className={`px-3 py-2 rounded-lg text-sm font-medium border ${capsuleType === t.id ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-[#0f1115] border-slate-800 text-slate-400 hover:border-slate-600'}`}>{t.label}</button>)}</div></div><div><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Render Preview Audio</label><button onClick={() => setRenderPreview((v) => !v)} className="flex items-center space-x-3 bg-[#0f1115] border border-slate-800 rounded-lg px-4 py-2.5 w-full"><div className={`w-10 h-5 rounded-full relative ${renderPreview ? 'bg-indigo-600' : 'bg-slate-700'}`}><div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${renderPreview ? 'left-5' : 'left-0.5'}`} /></div><span className="text-sm text-slate-300">{renderPreview ? 'Generate Preview WAV' : 'No Preview'}</span></button></div></div><div className="flex justify-end space-x-2"><button onClick={onCancel} disabled={isExporting} className="px-4 py-2 text-sm text-slate-400 hover:text-white disabled:opacity-40">Cancel</button><button onClick={submit} disabled={isExporting} className="px-5 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg flex items-center space-x-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-indigo-600/20">{isExporting ? <><RefreshCw size={14} className="animate-spin" /><span>Capturing...</span></> : <><Zap size={14} fill="currentColor" /><span>Start Capture</span></>}</button></div></div>;
}

export default function App() {
  return <ToastProvider><Shell /></ToastProvider>;
}
