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
} from 'lucide-react';

import NavIcon from './components/NavIcon.jsx';
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

function formatDate(s) {
  if (!s) return '';
  try {
    const d = new Date(s.endsWith('Z') ? s : `${s}Z`);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString('zh-CN', { hour12: false });
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
  const [serverOnline, setServerOnline] = useState(false);
  const [capsules, setCapsules] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [selectedCapsules, setSelectedCapsules] = useState([]);
  const [targetContacts, setTargetContacts] = useState([]);
  const [tempPeer, setTempPeer] = useState({ ip: '', port: '5005' });
  const [showTempPeerForm, setShowTempPeerForm] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [captureStatus, setCaptureStatus] = useState(null);
  const [receiveMode, setReceiveMode] = useState('confirm');
  const [pendingRequests, setPendingRequests] = useState([]);
  const [showIncoming, setShowIncoming] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [isCheckingCaptureSetup, setIsCheckingCaptureSetup] = useState(false);
  const setupCheckedRef = useRef(false);
  const lastSetupStateRef = useRef('');

  const captureStepsForPhase = useCallback((phase = '', renderPreview = true) => {
    const lower = String(phase || '').toLowerCase();
    const savingDone = lower.includes('rendering preview') || lower.includes('saving capsule: done');
    const rendering = lower.includes('rendering preview: starting');
    const renderDone = lower.includes('rendering preview: finished');
    const renderSkipped = lower.includes('rendering preview: skipped') || !renderPreview;
    return [
      {
        id: 'save',
        label: '保存胶囊',
        status: savingDone || rendering || renderDone ? 'done' : 'active',
        detail: savingDone || rendering || renderDone ? '胶囊本体已保存。' : '正在导出 RPP、Audio 和 metadata。',
      },
      {
        id: 'preview',
        label: '渲染预览文件',
        status: !renderPreview ? 'skipped' : renderDone ? 'done' : renderSkipped ? 'skipped' : rendering ? 'active' : 'pending',
        detail: !renderPreview
          ? '本次未请求预览。'
          : renderDone
            ? '预览渲染已完成，正在写入结果。'
            : renderSkipped
              ? '预览渲染已跳过。'
              : rendering
                ? '正在通过胶囊 RPP 渲染预览。'
                : '等待保存胶囊完成后开始。',
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
      toast.error(`读取胶囊库失败：${e.message}`);
    }
    try {
      const cs = await api.listContacts();
      setContacts(cs.data?.items || []);
    } catch (e) {
      toast.error(`读取联系人失败：${e.message}`);
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

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 15000);
    return () => clearInterval(t);
  }, [refreshAll]);

  useEffect(() => {
    api.getReceiveMode().then((r) => setReceiveMode(r.data?.mode || 'confirm')).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const checkSetup = async () => {
      const status = await refreshBridgeStatus();
      if (!alive) return;
      const state = status?.setup_state || '';
      const captureBusy = captureStatus && !['done', 'error'].includes(captureStatus.phase);
      if (!setupCheckedRef.current) {
        setupCheckedRef.current = true;
        if (!captureBusy && state && state !== 'READY') setShowSetupWizard(true);
      } else if (!captureBusy && lastSetupStateRef.current === 'READY' && state && state !== 'READY') {
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
    const es = new EventSource(api.notificationsUrl);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'transfer_request') {
          setPendingRequests((prev) => {
            if (prev.find((req) => req.id === data.request.id)) return prev;
            return [...prev, data.request];
          });
          setShowIncoming(true);
          toast.info(`${data.request.sender_name} 请求发送 "${data.request.capsule_name}"`);
        } else if (data.type === 'capsule_received') {
          toast.success(`收到新胶囊：${data.capsule?.name || '胶囊'}`);
          refreshAll();
        }
      } catch {
        // Ignore malformed keepalive/event payloads.
      }
    };
    es.onerror = () => {};
    return () => es.close();
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
    setSelectedCapsules((prev) => (prev.find((c) => c.id === cap.id) ? prev : [...prev, cap]));
    setActiveTab('transfer');
  };

  const handleRequestCreateCapsule = async () => {
    if (isCheckingCaptureSetup) return false;
    setIsCheckingCaptureSetup(true);
    try {
      const status = await refreshBridgeStatus();
      if (status?.setup_state !== 'READY') {
        setShowSetupWizard(true);
        toast.info(status?.setup_message || '请先完成 REAPER 设置。');
        return false;
      }
      if (status?.selected_item_count !== null && status?.selected_item_count !== undefined && Number(status.selected_item_count) <= 0) {
        toast.error('请先在 REAPER 中选中要保存为胶囊的 Item。');
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
    if (selectedCapsules.length === 0) return toast.error('请先选择要发送的胶囊');
    const peers = [...targetContacts];
    if (tempPeer.ip) peers.push({ name: tempPeer.ip, ip: tempPeer.ip, port: Number(tempPeer.port) || 5005 });
    if (peers.length === 0) return toast.error('请选择联系人或填写临时 IP');

    setIsSending(true);
    let successCount = 0;
    for (const cap of selectedCapsules) {
      for (const peer of peers) {
        try {
          await api.send({
            capsule_id: cap.uuid || cap.id,
            contact_id: peer.id,
            target_peer_id: peer.peer_id,
            target_public_key: peer.public_key,
            target_ip: peer.last_ip || peer.ip,
            target_port: peer.last_port || peer.port,
            target_name: peer.name,
          });
          successCount += 1;
        } catch (e) {
          toast.error(`发送 "${cap.name}" → ${peer.name} 失败：${e.message}`);
        }
      }
    }
    if (successCount > 0) toast.success(`已完成 ${successCount} 项发送`);
    setSelectedCapsules([]);
    setTargetContacts([]);
    setTempPeer({ ip: '', port: '5005' });
    refreshAll();
    setIsSending(false);
  };

  const handleCreateCapsule = async (payload) => {
    const initialSteps = captureStepsForPhase('', payload?.render_preview);
    setCaptureStatus({ phase: 'saving', message: '正在检测 REAPER 设置...', steps: initialSteps });
    const preflight = await refreshBridgeStatus();
    if (preflight?.setup_state !== 'READY') {
      setCaptureStatus(null);
      setShowSetupWizard(true);
      toast.error(preflight?.setup_message || '请先完成 REAPER 设置。');
      return false;
    }
    if (preflight?.selected_item_count !== null && preflight?.selected_item_count !== undefined && Number(preflight.selected_item_count) <= 0) {
      setCaptureStatus(null);
      toast.error('请先在 REAPER 中选中要保存为胶囊的 Item。');
      return false;
    }
    setCaptureStatus({ phase: 'saving', message: '正在连接 REAPER Bridge...', steps: initialSteps });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), payload?.render_preview ? 150000 : 60000);
    let phasePollId = null;
    let phasePollInFlight = false;
    let renderHintTimeoutId = null;
    let captureActive = true;
    try {
      setCaptureStatus({ phase: 'saving', message: '正在保存胶囊本体，REAPER 可保持最小化。', steps: initialSteps });
      if (payload?.render_preview) {
        renderHintTimeoutId = setTimeout(() => {
          if (!captureActive) return;
          setCaptureStatus((prev) => {
            if (!captureActive || prev?.phase === 'done' || prev?.phase === 'error') return prev;
            return {
              phase: 'rendering',
              message: '胶囊本体已提交，正在渲染预览文件。',
              steps: [
                { id: 'save', label: '保存胶囊', status: 'done', detail: '胶囊本体正在完成入库。' },
                { id: 'preview', label: '渲染预览文件', status: 'active', detail: '正在通过胶囊 RPP 渲染预览。' },
              ],
            };
          });
        }, 2500);
      }
      phasePollId = setInterval(async () => {
        if (phasePollInFlight) return;
        phasePollInFlight = true;
        try {
          const status = await api.getReaperBridgeStatus();
          if (!captureActive) return;
          const bridgePhase = status.data?.export_phase || '';
          if (!bridgePhase) return;
          const lower = bridgePhase.toLowerCase();
          if (!lower.includes('saving capsule') && !lower.includes('rendering preview')) return;
          const steps = captureStepsForPhase(bridgePhase, payload?.render_preview);
          const message = lower.includes('rendering preview')
            ? '胶囊已保存，正在渲染预览文件。'
            : '正在保存胶囊本体，REAPER 可保持最小化。';
          setCaptureStatus((prev) => {
            if (!captureActive || prev?.phase === 'done' || prev?.phase === 'error') return prev;
            const allDone = (prev?.steps || []).length > 0 && (prev.steps || []).every((step) => step.status === 'done' || step.status === 'skipped');
            if (allDone) return prev;
            const nextPhase = lower.includes('rendering preview') ? 'rendering' : 'saving';
            const next = { phase: nextPhase, message, steps };
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
        if (flags.needs_setup) message = `${message}\n\n请完成 REAPER Setup Wizard。`;
        if (flags.selected_items_required) message = `${message}\n\n请回到 REAPER 选中要保存的 Item 后再捕获。`;
        if (flags.needs_bridge_install) message = `${message}\n\n请到“设置 / 信息”安装 REAPER Bridge。`;
        if (flags.webui_required) message = `${message}\n\n请确认 REAPER 已打开并启用 Web Interface（默认端口 9000）。`;
        if (flags.export_phase) message = `${message}\n\nBridge 阶段：${flags.export_phase}`;
        if (flags.diagnostics) message = `${message}\n\n诊断：${flags.diagnostics}`;
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
          label: '保存胶囊',
          status: imported && imported.length > 0 ? 'done' : 'warning',
          detail: imported && imported.length > 0 ? '胶囊本体已保存并入库。' : '导出完成，但未能自动入库。',
        },
        {
          id: 'preview',
          label: '渲染预览文件',
          status: !previewRequested ? 'skipped' : previewRendered ? 'done' : 'skipped',
          detail: !previewRequested
            ? '本次未请求预览。'
            : previewRendered
              ? `预览已生成${previewAudio ? `：${previewAudio}` : '。'}`
              : (exportResult.preview_note || '预览未生成；胶囊本体不受影响。'),
        },
      ];
      if (imported && imported.length > 0) {
        const previewLine = previewRequested
          ? (previewRendered ? '预览文件已生成。' : '预览文件未生成，胶囊已保存。')
          : '未请求预览文件。';
        setCaptureStatus((prev) => ({ phase: 'done', message: `捕获成功：${imported[0].name}\n${previewLine}`, steps: doneSteps, settled: true, previousPhase: prev?.phase }));
        toast.success(`已从 REAPER 捕获：${imported[0].name}`);
      } else {
        setCaptureStatus((prev) => ({ phase: 'done', message: 'REAPER 导出完成，但未能自动入库，请检查导出目录。', steps: doneSteps, settled: true, previousPhase: prev?.phase }));
      }
      refreshAll();
    } catch (e) {
      const message = e.name === 'AbortError'
        ? '等待 REAPER Bridge 超过 60 秒，请到“设置 / 信息”重新检测或重新启动 Bridge。'
        : e.message;
      setCaptureStatus({ phase: 'error', message });
      toast.error(`REAPER 捕获失败：${message}`);
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
      toast.success('已删除');
      refreshAll();
    } catch (e) {
      toast.error(`删除失败：${e.message}`);
    }
  };

  const handleAddContact = async (payload) => {
    try {
      await api.addContact(payload);
      toast.success('已添加联系人');
      setShowAddContact(false);
      refreshAll();
    } catch (e) {
      toast.error(`添加失败：${e.message}`);
    }
  };

  const handleDeleteContact = async (contact) => {
    if (!window.confirm(`移除联系人 "${contact.name}"？`)) return;
    try {
      await api.deleteContact(contact.id);
      toast.success('已删除');
      refreshAll();
    } catch (e) {
      toast.error(`删除失败：${e.message}`);
    }
  };

  const handlePingContact = async (contact) => {
    try {
      const r = await api.pingContact({ contact_id: contact.id, ip: contact.last_ip || contact.ip, port: contact.last_port || contact.port });
      const trusted = r.data?.identity?.peer_id ? '，身份已验证' : '';
      toast[r.data?.online ? 'success' : 'error'](r.data?.online ? `${contact.name} 在线（${r.data.latency_ms} ms${trusted}）` : `${contact.name} 不可达`);
      refreshAll();
    } catch (e) {
      toast.error(`Ping 失败：${e.message}`);
    }
  };

  const handleChangeReceiveMode = async (mode) => {
    if (mode === 'auto' && receiveMode !== 'auto') {
      const firstConfirm = window.confirm('开启自动接收后，收到传输请求时不会再弹出确认窗口，胶囊会直接保存到本机。请只在可信局域网内使用。\n\n是否继续开启自动接收？');
      if (!firstConfirm) {
        toast.info('已取消开启自动接收');
        return;
      }
      const secondConfirm = window.confirm('再次确认：自动接收会降低操作阻力，但也意味着可信网络内的发送请求会直接落盘。你可以随时切回「验证」模式。\n\n确认开启自动接收？');
      if (!secondConfirm) {
        toast.info('已取消开启自动接收');
        return;
      }
    }
    try {
      await api.setReceiveMode(mode);
      setReceiveMode(mode);
      const labels = { off: '关闭接收', confirm: '验证接收', auto: '自动接收' };
      toast.success(`已切换为「${labels[mode]}」`);
    } catch (e) {
      toast.error(`切换失败：${e.message}`);
    }
  };

  const handleAcceptRequest = async (req) => {
    try {
      await api.acceptRequest(req.id);
      setPendingRequests((prev) => prev.filter((item) => item.id !== req.id));
      toast.success(`已接受 ${req.sender_name} 的传输`);
    } catch (e) {
      toast.error(`接受失败：${e.message}`);
    }
  };

  const handleRejectRequest = async (req) => {
    try {
      await api.rejectRequest(req.id);
      setPendingRequests((prev) => prev.filter((item) => item.id !== req.id));
      toast.info(`已拒绝 ${req.sender_name} 的传输`);
    } catch (e) {
      toast.error(`拒绝失败：${e.message}`);
    }
  };

  const handleRenameCapsule = async (cap, newName) => {
    try {
      await api.renameCapsule(cap.id, newName);
      toast.success(`已重命名为 "${newName}"`);
      refreshAll();
    } catch (e) {
      toast.error(`重命名失败：${e.message}`);
    }
  };

  const handleOpenRpp = async (cap) => {
    try {
      await api.openRpp(cap.id);
      toast.success('已打开 RPP 工程');
    } catch (e) {
      toast.error(`打开失败：${e.message}`);
    }
  };

  const handleOpenFolder = async (cap) => {
    try {
      await api.openFolder(cap.id);
      toast.success('已打开胶囊文件夹');
    } catch (e) {
      toast.error(`打开文件夹失败：${e.message}`);
    }
  };

  const onlineContacts = useMemo(() => contacts.filter((c) => c.last_seen && Date.now() - new Date(c.last_seen).getTime() < 5 * 60 * 1000), [contacts]);
  const myInfoLine = networkInfo ? `${networkInfo.hostname} · ${networkInfo.ip}:${networkInfo.port}` : '正在探测本机网络…';

  return (
    <div className="flex h-screen bg-[#0f1115] text-slate-200 font-sans overflow-hidden">
      <aside className="w-16 bg-[#161920] border-r border-slate-800 flex flex-col items-center py-6 space-y-8">
        <CapsuleLanLogo />
        <div className="flex flex-col space-y-4">
          <NavIcon active={activeTab === 'library'} onClick={() => setActiveTab('library')} icon={<Package size={20} />} label="库" />
          <NavIcon active={activeTab === 'contacts'} onClick={() => setActiveTab('contacts')} icon={<Users size={20} />} label="联系人" />
          <NavIcon active={activeTab === 'transfer'} onClick={() => setActiveTab('transfer')} icon={<Send size={20} />} label="发送" />
        </div>
        <div className="mt-auto"><NavIcon active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<Settings size={20} />} label="设置" /></div>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-[#0f1115]/80 backdrop-blur-md">
          <div className="flex items-center space-x-4">
            <div className={`flex items-center space-x-2 px-3 py-1 rounded-full border ${serverOnline ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/30'}`}>
              <div className={`w-2 h-2 rounded-full ${serverOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className={`text-[10px] font-mono uppercase tracking-widest font-bold ${serverOnline ? 'text-emerald-500' : 'text-red-400'}`}>{serverOnline ? 'Local Server Online' : 'Server Offline'}</span>
            </div>
            <div className="text-sm font-mono text-slate-400">{myInfoLine}</div>
            {networkInfo?.ip && <button onClick={() => navigator.clipboard.writeText(`${networkInfo.ip}:${networkInfo.port}`).then(() => toast.success('已复制本机地址'))} className="text-slate-500 hover:text-slate-200" title="复制 IP:端口"><Copy size={14} /></button>}
          </div>
          <div className="flex items-center space-x-3">
            <div className="flex items-center bg-[#161920] border border-slate-800 rounded-lg overflow-hidden">
              <button onClick={() => handleChangeReceiveMode('off')} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 transition-all ${receiveMode === 'off' ? 'bg-red-500/20 text-red-400 border-r border-red-500/30' : 'text-slate-500 hover:text-slate-300 border-r border-slate-800'}`} title="关闭接收"><ShieldOff size={12} /><span>关闭</span></button>
              <button onClick={() => handleChangeReceiveMode('confirm')} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 transition-all ${receiveMode === 'confirm' ? 'bg-amber-500/20 text-amber-400 border-r border-amber-500/30' : 'text-slate-500 hover:text-slate-300 border-r border-slate-800'}`} title="验证接收"><ShieldCheck size={12} /><span>验证</span></button>
              <button onClick={() => handleChangeReceiveMode('auto')} className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 transition-all ${receiveMode === 'auto' ? 'bg-emerald-500/20 text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`} title="自动接收"><Shield size={12} /><span>自动</span></button>
            </div>
            {pendingRequests.length > 0 && (
              <button onClick={() => setShowIncoming(true)} className="relative p-2 text-amber-400 hover:text-amber-300 transition-colors" title={`${pendingRequests.length} 个待确认请求`}>
                <Bell size={18} />
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{pendingRequests.length}</span>
              </button>
            )}
            <button onClick={refreshAll} className="text-slate-500 hover:text-slate-200 flex items-center space-x-1 text-xs"><RefreshCw size={14} /><span>刷新</span></button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {activeTab === 'library' && <LibraryView capsules={capsules} onSend={handleSelectCapsuleForSend} onDelete={handleDeleteCapsule} onCreate={handleCreateCapsule} onRequestCreate={handleRequestCreateCapsule} isCheckingSetup={isCheckingCaptureSetup} onRename={handleRenameCapsule} onOpenRpp={handleOpenRpp} onOpenFolder={handleOpenFolder} />}
          {activeTab === 'contacts' && <ContactsView contacts={contacts} onlineContacts={onlineContacts} onSend={handleStartTransferTo} onDelete={handleDeleteContact} onPing={handlePingContact} showAddForm={showAddContact} setShowAddForm={setShowAddContact} onAdd={handleAddContact} />}
          {activeTab === 'transfer' && <TransferView capsules={capsules} contacts={contacts} selectedCapsules={selectedCapsules} setSelectedCapsules={setSelectedCapsules} targetContacts={targetContacts} setTargetContacts={setTargetContacts} tempPeer={tempPeer} setTempPeer={setTempPeer} showTempPeerForm={showTempPeerForm} setShowTempPeerForm={setShowTempPeerForm} isSending={isSending} onSend={handleSend} />}
          {activeTab === 'settings' && <SettingsView networkInfo={networkInfo} apiBase={api.base} bridgeStatus={bridgeStatus} onRefreshBridge={refreshBridgeStatus} onOpenSetup={() => setShowSetupWizard(true)} />}
        </main>
      </div>
      {captureStatus && <CaptureOverlayV2 status={captureStatus} onClose={() => setCaptureStatus(null)} />}
      {showSetupWizard && <SetupWizard status={bridgeStatus} onClose={() => setShowSetupWizard(false)} onRefresh={refreshBridgeStatus} />}
      {showIncoming && pendingRequests.length > 0 && <IncomingRequestsOverlay requests={pendingRequests} onAccept={handleAcceptRequest} onReject={handleRejectRequest} onClose={() => setShowIncoming(false)} />}
    </div>
  );
}

function LibraryView({ capsules, onSend, onDelete, onCreate, onRequestCreate, isCheckingSetup, onRename, onOpenRpp, onOpenFolder }) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [selectedId, setSelectedId] = useState(capsules[0]?.id || null);
  const [query, setQuery] = useState('');
  const [customFolders, setCustomFolders] = useState([]);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [createParentId, setCreateParentId] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderError, setFolderError] = useState('');
  const [draggingId, setDraggingId] = useState(null);
  const [draggingFolderId, setDraggingFolderId] = useState(null);
  const [dragOverFolder, setDragOverFolder] = useState(null);

  const parseCapsuleDate = (value) => {
    if (!value) return null;
    const raw = String(value);
    const date = new Date(raw.endsWith('Z') ? raw : `${raw}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const isReceived = (cap) => Boolean(cap.source_peer);
  const isRecentReceived = (cap) => {
    const date = parseCapsuleDate(cap.created_at);
    return isReceived(cap) && date && Date.now() - date.getTime() <= 7 * 24 * 60 * 60 * 1000;
  };
  const hasMissingPlugins = (cap) => Boolean(cap.plugin_status?.inventory_available && cap.plugin_status?.missing > 0);
  useEffect(() => {
    let cancelled = false;
    api.listCapsuleFolders()
      .then((res) => {
        if (!cancelled) setCustomFolders(res.data?.items || []);
      })
      .catch((err) => {
        if (!cancelled) setFolderError(`读取分类失败：${err.message}`);
      });
    return () => { cancelled = true; };
  }, []);

  const refreshCustomFolders = async () => {
    const res = await api.listCapsuleFolders();
    setCustomFolders(res.data?.items || []);
    return res.data?.items || [];
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      setFolderError('');
      const res = await api.createCapsuleFolder(name, createParentId);
      const folder = res.data || res;
      await refreshCustomFolders();
      setSelectedFolder(`folder:${folder.id}`);
      setNewFolderName('');
      setIsCreatingFolder(false);
      setCreateParentId(null);
    } catch (err) {
      setFolderError(`创建分类失败：${err.message}`);
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
      setFolderError(`加入分类失败：${err.message}`);
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
      setFolderError(`移动分类失败：${err.message}`);
    } finally {
      setDraggingFolderId(null);
      setDragOverFolder(null);
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
      setFolderError(`移出分类失败：${err.message}`);
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
        label: '分类',
        icon: FolderOpen,
        count: customFolders.length,
        selectable: false,
        acceptsFolderDrop: true,
        children: customItems,
      },
      { key: 'all', label: '全部胶囊', icon: Package, count: capsules.length, predicate: () => true },
      { key: 'local', label: '本机捕获', icon: HardDrive, count: capsules.filter((cap) => !isReceived(cap)).length, predicate: (cap) => !isReceived(cap) },
      { key: 'received', label: '接收胶囊', icon: Inbox, count: capsules.filter(isReceived).length, predicate: isReceived },
      { key: 'recent-received', label: '最近 7 天接收', icon: Clock, count: capsules.filter(isRecentReceived).length, predicate: isRecentReceived },
      { key: 'missing-plugins', label: '插件缺失', icon: AlertTriangle, count: capsules.filter(hasMissingPlugins).length, predicate: hasMissingPlugins },
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
  const selectedIsDirectlyInActiveFolder = Boolean(
    selectedCapsule && activeCustomFolder?.capsule_ids?.includes(selectedCapsule.id),
  );
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

  const handlePlay = (cap) => {
    if (playingId === cap.id) { audioRef.current?.pause(); setPlayingId(null); return; }
    audioRef.current?.pause();
    const audio = new Audio(api.previewUrl(cap.id));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    audio.play();
    audioRef.current = audio;
    setPlayingId(cap.id);
  };

  const startRename = (cap) => { setEditingId(cap.id); setEditName(cap.name); };
  const confirmRename = (cap) => { if (editName.trim() && editName.trim() !== cap.name) onRename(cap, editName.trim()); setEditingId(null); };
  const requestDelete = (cap) => { setDeleteConfirmId(cap.id); };
  const cancelDelete = () => { setDeleteConfirmId(null); };
  const confirmDelete = (cap) => { setDeleteConfirmId(null); onDelete(cap); };
  const stopAction = (event, fn) => {
    event.stopPropagation();
    fn();
  };

  useEffect(() => () => audioRef.current?.pause(), []);

  const renderFolder = (folder, depth = 0) => {
    const Icon = folder.icon;
    const active = selectedFolder === folder.key;
    const hasChildren = Boolean(folder.children?.length);
    const canSelect = folder.selectable !== false;
    const canDropCapsule = Boolean(folder.droppable);
    const canDropFolder = Boolean(folder.droppable || folder.acceptsFolderDrop);
    const isDragOver = dragOverFolder === folder.key;
    const folderDropTargetId = folder.acceptsFolderDrop ? null : folder.id;
    return (
      <div key={folder.key}>
        <button
          onClick={() => { if (canSelect) setSelectedFolder(folder.key); }}
          draggable={Boolean(folder.draggableFolder)}
          onDragStart={(event) => {
            if (!folder.draggableFolder) return;
            event.stopPropagation();
            setDraggingFolderId(folder.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-capsule-folder-id', folder.id);
          }}
          onDragOver={(event) => {
            const hasCapsule = Array.from(event.dataTransfer.types).includes('text/plain');
            const hasFolder = Array.from(event.dataTransfer.types).includes('application/x-capsule-folder-id');
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
            const droppedFolderId = event.dataTransfer.getData('application/x-capsule-folder-id') || draggingFolderId;
            if (droppedFolderId && canDropFolder) {
              moveFolder(droppedFolderId, folderDropTargetId);
              return;
            }
            const capsuleId = event.dataTransfer.getData('text/plain') || draggingId;
            if (capsuleId && canDropCapsule) addToFolder(folder.id, capsuleId);
          }}
          onDragEnd={() => {
            if (folder.draggableFolder) {
              setDraggingFolderId(null);
              setDragOverFolder(null);
            }
          }}
          className={`group/folder w-full h-9 px-2 rounded-lg flex items-center gap-2 text-left transition-colors ${active ? 'bg-indigo-500/15 border border-indigo-500/35 text-indigo-100' : isDragOver ? 'border border-indigo-500/50 bg-indigo-500/10 text-indigo-100' : canSelect ? 'border border-transparent text-slate-400 hover:bg-slate-800/70 hover:text-slate-200' : 'border border-transparent text-slate-500'}`}
          style={{ paddingLeft: `${8 + depth * 18}px` }}
        >
          {hasChildren ? <ChevronDown size={14} className="text-slate-500 shrink-0" /> : <span className="w-3.5 shrink-0" />}
          <Icon size={15} className={active ? 'text-indigo-300 shrink-0' : 'text-slate-500 shrink-0'} />
          <span className="min-w-0 flex-1 truncate text-sm">{folder.label}</span>
          {(folder.key === 'custom-root' || folder.droppable) && (
            <span
              role="button"
              tabIndex={0}
              title={folder.key === 'custom-root' ? '新建根分类' : '新建子分类'}
              onClick={(event) => {
                event.stopPropagation();
                startCreateFolder(folder.droppable ? folder.id : null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  startCreateFolder(folder.droppable ? folder.id : null);
                }
              }}
              className="opacity-0 group-hover/folder:opacity-100 rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
            >
              <FolderPlus size={13} />
            </span>
          )}
          <span className="text-[11px] text-slate-500">{folder.count}</span>
        </button>
        {hasChildren && (
          <div className="mt-1 space-y-1">
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full min-h-[720px] flex flex-col">
      <div className="flex flex-col gap-4 mb-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-white">胶囊库</h1>
          <p className="text-slate-500 text-sm mt-1">资源管理器视图 · 共 {capsules.length} 个胶囊 · 当前显示 {filteredCapsules.length} 个</p>
        </div>
        <div className="flex w-full items-center gap-2 xl:w-auto">
          <div className="relative min-w-0 flex-1 xl:w-[340px] xl:flex-none">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称、工程、来源、标签..."
              className="w-full bg-[#0f1115] border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button disabled={isCheckingSetup} onClick={async () => {
            if (showCreateForm) {
              setShowCreateForm(false);
              return;
            }
            const allowed = await onRequestCreate();
            if (allowed) setShowCreateForm(true);
          }} className="shrink-0 whitespace-nowrap bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg flex items-center space-x-2 shadow-lg shadow-indigo-600/20 disabled:opacity-50 disabled:cursor-not-allowed">
            {isCheckingSetup ? <RefreshCw size={18} className="animate-spin" /> : <Plus size={18} />}
            <span>{isCheckingSetup ? '检测中...' : '新捕获'}</span>
          </button>
        </div>
      </div>

      {showCreateForm && <CreateCapsuleForm onCancel={() => setShowCreateForm(false)} onSubmit={async (data) => { const result = await onCreate(data); if (result !== false) setShowCreateForm(false); }} />}

      <div className="grid flex-1 min-h-0 grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(420px,1fr)] xl:grid-cols-[260px_minmax(480px,1fr)_292px]">
          <aside className="min-h-[220px] lg:min-h-0 rounded-xl border border-slate-800 bg-[#161920] p-4 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-sm font-semibold text-slate-200">目录</div>
                <div className="text-[11px] text-slate-600 mt-0.5">分类与快速视图</div>
              </div>
              <button onClick={() => startCreateFolder(null)} className="p-2 rounded-lg border border-slate-800 text-slate-500 hover:text-slate-300 hover:bg-slate-800" title="新建分类">
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
                  placeholder="分类名称"
                  className="w-full bg-transparent px-1 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none"
                />
                <div className="px-1 text-[11px] text-slate-600">{createParentName ? `创建到：${createParentName}` : '创建到：分类根目录'}</div>
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => { setIsCreatingFolder(false); setNewFolderName(''); setCreateParentId(null); }} className="px-2 py-1 text-xs text-slate-500 hover:text-slate-200">取消</button>
                  <button onClick={createFolder} className="rounded bg-indigo-600 px-2.5 py-1 text-xs text-white hover:bg-indigo-500">创建</button>
                </div>
              </div>
            )}
            <div className="space-y-1 overflow-y-auto custom-scrollbar pr-1">
              {folderTree.map((folder) => renderFolder(folder))}
            </div>
            {folderError && <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-200">{folderError}</div>}
            <div className="mt-auto pt-4 text-[11px] leading-relaxed text-slate-600">
              拖拽胶囊到“分类”下的文件夹中，只会保存分类关系，不会移动本地胶囊文件。
            </div>
          </aside>

          <section className="min-h-0 rounded-xl border border-slate-800 bg-[#11151b] overflow-hidden flex flex-col">
            <div className="h-11 px-4 grid grid-cols-[minmax(190px,1fr)_84px_92px_70px_minmax(240px,1.3fr)] items-center gap-3 border-b border-slate-800 bg-[#151a21] text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <span>名称</span>
              <span>来源</span>
              <span>插件</span>
              <span>大小</span>
              <span>分类</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              {filteredCapsules.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500">
                  <Package size={28} className="mb-3" />
                  <p className="text-sm">当前目录没有匹配的胶囊。</p>
                </div>
              ) : filteredCapsules.map((cap) => {
                const selected = selectedCapsule?.id === cap.id;
                const folderLabels = folderLabelsForCapsule(cap);
                const hiddenFolderLabels = folderLabels.slice(5);
                const folderTitle = (folderPathsByCapsuleId.get(cap.id) || []).map((path) => path.join(' > ')).join('\n');
                return (
                  <div
                    key={cap.id}
                    draggable
                    onClick={() => setSelectedId(cap.id)}
                    onDragStart={(event) => {
                      setDraggingId(cap.id);
                      event.dataTransfer.effectAllowed = 'copy';
                      event.dataTransfer.setData('text/plain', cap.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDragOverFolder(null);
                    }}
                    className={`group min-h-[48px] px-4 grid grid-cols-[minmax(190px,1fr)_84px_92px_70px_minmax(240px,1.3fr)] items-center gap-3 border-b border-slate-800/70 cursor-grab transition-colors active:cursor-grabbing ${draggingId === cap.id ? 'opacity-60' : ''} ${selected ? 'bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/30' : 'bg-[#11151b] hover:bg-[#171d25]'}`}
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      <button title={playingId === cap.id ? '暂停预览' : '播放预览'} onClick={(event) => stopAction(event, () => handlePlay(cap))} className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${playingId === cap.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-indigo-300 hover:bg-indigo-600/20'}`}>
                        {playingId === cap.id ? <Pause size={15} /> : <Play size={15} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-200">{cap.name}</div>
                      </div>
                    </div>
                    <div className="min-w-0 text-xs">
                      <div className="truncate text-slate-300">{cap.source_peer || '本机'}</div>
                    </div>
                    <div><PluginStatusBadge status={cap.plugin_status} /></div>
                    <div className="text-xs text-slate-400">{formatBytes(cap.size_bytes)}</div>
                    <div className="min-w-0 flex flex-wrap items-center gap-1.5">
                      {folderLabels.length === 0 ? (
                        <span className="text-[11px] text-slate-600">未分类</span>
                      ) : folderLabels.slice(0, 5).map((label) => (
                        <span key={label} title={label} className="max-w-[92px] truncate rounded border border-slate-700/70 bg-slate-800/50 px-1.5 py-0.5 text-[11px] text-slate-300">
                          {label}
                        </span>
                      ))}
                      {hiddenFolderLabels.length > 0 && <span title={folderTitle || hiddenFolderLabels.join('、')} className="text-[11px] text-slate-500">+{hiddenFolderLabels.length}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <aside className="hidden xl:block min-h-0 rounded-xl border border-slate-800 bg-[#161920] p-4 overflow-y-auto custom-scrollbar">
            {!selectedCapsule ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-500">
                <Package size={30} className="mb-3" />
                <p className="text-sm">选择一个胶囊查看详情。</p>
              </div>
            ) : (
              <div className="space-y-5">
                <div>
                  <div className="w-12 h-12 rounded-xl bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center text-indigo-300 mb-4">
                    <FileAudio size={22} />
                  </div>
                  {editingId === selectedCapsule.id ? (
                    <div className="flex items-center gap-2">
                      <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(selectedCapsule); if (e.key === 'Escape') setEditingId(null); }} className="min-w-0 flex-1 bg-[#0f1115] border border-indigo-500 rounded px-2 py-1 text-sm text-slate-200" />
                      <button onClick={() => confirmRename(selectedCapsule)} className="p-1 text-emerald-400"><Check size={15} /></button>
                    </div>
                  ) : (
                    <h2 className="text-base font-bold leading-snug text-white break-words">{selectedCapsule.name}</h2>
                  )}
                  <div className="mt-2 text-xs text-slate-500">{selectedCapsule.source_peer ? `来自 ${selectedCapsule.source_peer}` : '本机捕获'}</div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => handlePlay(selectedCapsule)} className={`h-9 rounded-lg flex items-center justify-center gap-2 text-sm ${playingId === selectedCapsule.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-indigo-300 hover:bg-indigo-600/20'}`}>
                    {playingId === selectedCapsule.id ? <Pause size={15} /> : <Play size={15} />}
                    <span>{playingId === selectedCapsule.id ? '暂停' : '预览'}</span>
                  </button>
                  <button onClick={() => onSend(selectedCapsule)} className="h-9 rounded-lg bg-indigo-600 text-white flex items-center justify-center gap-2 text-sm hover:bg-indigo-500"><Send size={15} /><span>发送</span></button>
                  <button onClick={() => onOpenRpp(selectedCapsule)} className="h-9 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center gap-2 text-sm hover:text-orange-300"><Music size={15} /><span>RPP</span></button>
                  <button onClick={() => onOpenFolder(selectedCapsule)} className="h-9 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center gap-2 text-sm hover:text-amber-300"><FolderOpen size={15} /><span>目录</span></button>
                </div>

                <div className="space-y-3 text-sm">
                  <DetailRow label="创建时间" value={formatDate(selectedCapsule.created_at)} />
                  <DetailRow label="大小" value={formatBytes(selectedCapsule.size_bytes)} />
                  <DetailRow label="工程" value={selectedCapsule.project_name || selectedCapsule.rpp_file || '未记录'} />
                  <DetailRow label="类型" value={selectedCapsule.capsule_type || 'reaper'} />
                </div>

                <div>
                  <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">插件状态</div>
                  <PluginStatusBadge status={selectedCapsule.plugin_status} />
                  <MissingPluginPreview status={selectedCapsule.plugin_status} />
                </div>

                {selectedCapsule.description && (
                  <div>
                    <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">描述</div>
                    <p className="text-xs leading-relaxed text-slate-400">{selectedCapsule.description}</p>
                  </div>
                )}

                <div className="border-t border-slate-800 pt-4">
                  {activeCustomFolder && selectedIsDirectlyInActiveFolder && (
                    <button onClick={() => removeFromCurrentFolder(selectedCapsule)} className="mb-2 h-9 w-full rounded-lg bg-slate-800 text-sm text-slate-300 hover:text-amber-300">
                      从“{activeCustomFolder.name}”移出
                    </button>
                  )}
                  {deleteConfirmId === selectedCapsule.id ? (
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => confirmDelete(selectedCapsule)} className="h-9 rounded-lg bg-red-500/15 text-red-300 hover:bg-red-500 hover:text-white text-sm">确认删除</button>
                      <button onClick={cancelDelete} className="h-9 rounded-lg bg-slate-800 text-slate-400 hover:text-slate-200 text-sm">取消</button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => startRename(selectedCapsule)} className="h-9 rounded-lg bg-slate-800 text-slate-300 hover:text-indigo-300 text-sm flex items-center justify-center gap-2"><Pencil size={15} />重命名</button>
                      <button onClick={() => requestDelete(selectedCapsule)} className="h-9 rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500 hover:text-white text-sm flex items-center justify-center gap-2"><Trash2 size={15} />删除</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-800/70 pb-2">
      <span className="shrink-0 text-xs text-slate-500">{label}</span>
      <span className="min-w-0 text-right text-xs text-slate-300 break-words">{value}</span>
    </div>
  );
}

function PluginStatusBadge({ status }) {
  if (!status || !status.total) return null;
  if (!status.inventory_available) {
    return (
      <span title="未找到 REAPER 插件索引，暂时无法判断插件是否完整。" className="inline-flex items-center rounded border border-slate-700/70 bg-slate-800/40 px-1.5 py-0.5 text-[10px] text-slate-400">
        插件待检测
      </span>
    );
  }
  if (status.missing > 0) {
    const missing = status.missing_plugins || [];
    const extra = Math.max(0, status.missing - missing.length);
    const title = missing.length
      ? `缺失插件：${missing.join('、')}${extra ? ` 等 ${status.missing} 个` : ''}`
      : `缺失 ${status.missing} 个插件`;
    return (
      <span title={title} className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        缺失 {status.missing} 个插件
      </span>
    );
  }
  return (
    <span title={`已匹配 ${status.available}/${status.total} 个插件`} className="inline-flex items-center rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
      插件完整
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
      <span className="text-[10px] text-amber-300/80">缺失</span>
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
  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8"><div><h1 className="text-2xl font-bold text-white">协作伙伴</h1><p className="text-slate-500 text-sm mt-1">局域网内已保存的联系人（在线 {onlineContacts.length} / 共 {contacts.length}）</p></div><button onClick={() => setShowAddForm(true)} className="border border-slate-700 hover:bg-slate-800 text-slate-300 px-4 py-2 rounded-lg flex items-center space-x-2"><UserPlus size={18} /><span>添加联系人</span></button></div>
      {showAddForm && <AddContactForm onCancel={() => setShowAddForm(false)} onSubmit={onAdd} />}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {contacts.map((contact) => {
          const online = contact.last_seen && Date.now() - new Date(contact.last_seen).getTime() < 5 * 60 * 1000;
          const trusted = Boolean(contact.peer_id && contact.public_key);
          const address = `${contact.last_ip || contact.ip}:${contact.last_port || contact.port}`;
          return (
            <div key={contact.id} className="bg-[#1a1d24] border border-slate-800 p-5 rounded-2xl flex items-start justify-between gap-4 group">
              <div className="flex items-center space-x-4 min-w-0">
                <div className="relative shrink-0">
                  <div className="w-12 h-12 bg-slate-700 rounded-full flex items-center justify-center text-xl font-bold text-slate-400 uppercase">{(contact.name || '?')[0]}</div>
                  {online && <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-emerald-500 border-2 border-[#1a1d24] rounded-full" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="font-bold text-slate-200 truncate">{contact.name}</h3>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${trusted ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/25 bg-amber-500/10 text-amber-300'}`}>
                      {trusted ? '可信设备' : '仅 IP'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 font-mono mt-1 truncate">{address}</p>
                  {trusted && <p className="text-[10px] text-slate-600 font-mono mt-1 truncate">ID {contact.peer_id?.slice(0, 8)} · {contact.fingerprint}</p>}
                  <p className={`text-[10px] mt-2 ${online ? 'text-emerald-500' : 'text-slate-600'}`}>{online ? '● 最近 5 分钟在线' : contact.last_seen ? `上次出现: ${formatDate(contact.last_seen)}` : '未探测'}</p>
                </div>
              </div>
              <div className="flex flex-col space-y-2 shrink-0">
                <button onClick={() => onSend(contact)} className="p-2 bg-indigo-600 rounded-lg text-white hover:bg-indigo-500" title="发送"><Zap size={16} fill="white" /></button>
                <button onClick={() => onPing(contact)} className="p-2 text-slate-500 hover:text-slate-200" title="验证当前地址"><RefreshCw size={16} /></button>
                <button onClick={() => onDelete(contact)} className="p-2 text-slate-600 hover:text-red-400" title="删除联系人"><Trash2 size={16} /></button>
              </div>
            </div>
          );
        })}
        <div onClick={() => setShowAddForm(true)} className="border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center p-6 text-slate-600 hover:border-slate-700 hover:text-slate-500 cursor-pointer"><Search size={24} className="mb-2" /><span className="text-sm font-medium">添加设备 / IP</span></div>
      </div>
    </div>
  );
}

function AddContactForm({ onCancel, onSubmit }) {
  const [form, setForm] = useState({ name: '', ip: '', port: '', note: '' });
  const updateIp = (value) => {
    const parsed = parseHostPort(value);
    setForm((prev) => ({ ...prev, ip: parsed.ip, port: parsed.port || prev.port }));
  };
  return <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-5 mb-6"><h3 className="text-sm font-bold text-slate-200 mb-4">添加联系人</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-3"><FormField label="名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></FormField><FormField label="当前 IP"><input value={form.ip} placeholder="可粘贴 IP:端口" onChange={(e) => updateIp(e.target.value)} /></FormField><FormField label="端口"><input value={form.port} placeholder="默认 5005" onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '').slice(0, 5) })} /></FormField><FormField label="备注"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></FormField></div><p className="mt-3 text-xs text-slate-500">保存时会尝试读取对方设备身份；成功后联系人会绑定 peer ID，IP 变化时发送前自动重新定位。</p><div className="flex justify-end space-x-2 mt-5"><button onClick={onCancel} className="px-4 py-2 text-sm text-slate-400 hover:text-white">取消</button><button onClick={() => form.name && form.ip && onSubmit({ ...form, port: Number(form.port) || 5005 })} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg">保存</button></div></div>;
}

function FormField({ label, children }) {
  return <label className="block"><span className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">{label}</span>{React.cloneElement(children, { className: 'w-full bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500' })}</label>;
}

function TransferView({ capsules, contacts, selectedCapsules, setSelectedCapsules, targetContacts, setTargetContacts, tempPeer, setTempPeer, showTempPeerForm, setShowTempPeerForm, isSending, onSend }) {
  const toggleCapsule = (cap) => setSelectedCapsules((prev) => (prev.find((c) => c.id === cap.id) ? prev.filter((c) => c.id !== cap.id) : [...prev, cap]));
  const toggleTarget = (contact) => setTargetContacts((prev) => (prev.find((c) => c.id === contact.id) ? prev.filter((c) => c.id !== contact.id) : [...prev, contact]));
  const totalTasks = selectedCapsules.length * (targetContacts.length + (tempPeer.ip ? 1 : 0));

  return <div className="max-w-2xl mx-auto mt-6"><div className="bg-[#1a1d24] p-8 rounded-3xl border border-slate-800 shadow-2xl relative overflow-hidden"><h2 className="text-xl font-bold text-white mb-6 flex items-center"><Send size={20} className="mr-2 text-indigo-500" />发送胶囊</h2><div className="mb-8"><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">目标联系人</label><div className="grid grid-cols-2 gap-3">{contacts.map((c) => { const selected = targetContacts.find((tc) => tc.id === c.id); const trusted = Boolean(c.peer_id && c.public_key); return <button key={c.id} onClick={() => toggleTarget(c)} className={`flex items-center space-x-3 bg-[#0f1115] p-3 rounded-xl border text-left ${selected ? 'border-indigo-500 bg-indigo-600/5' : 'border-slate-800 hover:border-indigo-500'}`}><div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs ${selected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}>{selected ? <Check size={14} /> : (c.name || '?')[0]}</div><div className="min-w-0"><div className="text-xs font-medium truncate">{c.name}</div><div className="text-[10px] text-slate-500 font-mono truncate">{c.last_ip || c.ip}:{c.last_port || c.port}</div><div className={`text-[10px] ${trusted ? 'text-emerald-400' : 'text-amber-400'}`}>{trusted ? '可信设备' : '仅 IP'}</div></div></button>; })}<button onClick={() => setShowTempPeerForm((v) => !v)} className="flex items-center justify-center space-x-2 bg-[#0f1115] p-3 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-500"><Plus size={14} /><span className="text-xs">临时 IP</span></button></div>{showTempPeerForm && <div className="grid grid-cols-3 gap-3 mt-3"><input className="col-span-2 bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200" placeholder="对方 IP" value={tempPeer.ip} onChange={(e) => setTempPeer({ ...tempPeer, ip: e.target.value })} /><input className="bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200" placeholder="端口" value={tempPeer.port} onChange={(e) => setTempPeer({ ...tempPeer, port: e.target.value })} /></div>}</div><div className="mb-10"><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">选择内容</label><div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">{capsules.length === 0 && <div className="text-xs text-slate-500 bg-[#0f1115] border border-slate-800 rounded-xl p-3">胶囊库为空。</div>}{capsules.map((cap) => { const selected = selectedCapsules.find((sc) => sc.id === cap.id); return <button key={cap.id} onClick={() => toggleCapsule(cap)} className={`w-full text-left bg-[#0f1115] p-3 rounded-xl border flex items-center justify-between ${selected ? 'border-indigo-500 bg-indigo-600/5' : 'border-slate-800 hover:border-indigo-500'}`}><div className="flex items-center space-x-3 min-w-0"><div className={`w-5 h-5 rounded flex items-center justify-center ${selected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-500'}`}>{selected ? <Check size={12} /> : null}</div><FileAudio className="text-indigo-400 shrink-0" size={16} /><span className="text-xs truncate">{cap.name}</span></div><span className="text-[10px] text-slate-500">{formatBytes(cap.size_bytes)}</span></button>; })}</div></div>{totalTasks > 0 && <div className="mb-4 text-xs text-slate-400 text-center">将发送 {selectedCapsules.length} 个胶囊 → {targetContacts.length + (tempPeer.ip ? 1 : 0)} 个目标（共 {totalTasks} 项任务）</div>}<button disabled={selectedCapsules.length === 0 || totalTasks === 0 || isSending} onClick={onSend} className={`w-full py-4 rounded-2xl font-bold flex items-center justify-center space-x-2 ${isSending || selectedCapsules.length === 0 || totalTasks === 0 ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30'}`}>{isSending ? <span>正在发射…</span> : <><Zap size={18} fill="currentColor" /><span>立即发送</span></>}</button>{isSending && <div className="absolute bottom-0 left-0 w-full bg-slate-800 h-1 overflow-hidden"><div className="bg-indigo-500 h-full w-1/3 animate-pulse" /></div>}</div></div>;
}

function SettingsView({ networkInfo, apiBase, bridgeStatus, onRefreshBridge, onOpenSetup }) {
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
    ? `已确认 v${bridgeStatus.bridge_version || ''}`
    : bridgeStatus?.setup_message || 'REAPER 设置未完成';

  const checkForUpdate = async () => {
    setUpdateBusy(true);
    setUpdatePhase('checking');
    try {
      const info = await api.checkUpdate();
      setUpdateInfo(info);
      if (!info.enabled) {
        toast.info(info.message);
      } else if (info.update_available) {
        toast.success(`发现新版本 ${info.latest_version}`);
      } else {
        toast.success(info.message || '当前已是最新版本');
      }
    } catch (e) {
      toast.error(`检查更新失败：${e.message}`);
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
      toast.info('即将关闭并安装更新。');
      await api.installUpdate({
        packagePath: downloaded.package_path,
        version: downloaded.version,
        build: downloaded.build,
      });
    } catch (e) {
      toast.error(`安装更新失败：${e.message}`);
      setUpdateBusy(false);
      setUpdatePhase('');
    }
  };

  const updateButtonLabel = updatePhase === 'checking'
    ? '检查中...'
    : updatePhase === 'copying'
      ? '正在复制更新包...'
      : updatePhase === 'installing'
        ? '正在安装...'
        : '检查更新';

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">设置 / 信息</h1>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-200">软件更新</h3>
            <p className="text-xs text-slate-500 mt-1">
              {updateInfo ? `当前版本 ${updateInfo.current_version} · ${updateInfo.message}` : '手动检查内部更新源。'}
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
                <div className="text-sm font-bold text-indigo-200">可更新到 {updateInfo.latest_version}</div>
                <div className="text-xs text-slate-400 mt-1">包体大小：{formatBytes(updateInfo.size || 0)}</div>
                {updateInfo.notes?.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-slate-300 list-disc list-inside">
                    {updateInfo.notes.slice(0, 4).map((note, idx) => <li key={`${note}-${idx}`}>{note}</li>)}
                  </ul>
                )}
              </div>
              <button onClick={installUpdate} disabled={updateBusy} className="px-4 py-2 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40 shrink-0 flex items-center space-x-2">
                <Download size={14} />
                <span>立即更新</span>
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6">
        <h3 className="text-sm font-bold text-slate-200 mb-4">REAPER 设置</h3>
        <div className={`rounded-xl border p-4 mb-4 ${bridgeOk ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-amber-500/10 border-amber-500/25'}`}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center space-x-3 min-w-0">
              <Radio size={18} className={bridgeOk ? 'text-emerald-400' : 'text-amber-400'} />
              <div className="min-w-0">
                <div className="text-sm font-bold text-slate-200">{bridgeLabel}</div>
                <div className="text-xs text-slate-500 mt-1">捕获前会校验 WebUI、Bridge、资源目录和选中 Item。</div>
              </div>
            </div>
            <button onClick={refresh} disabled={checkingBridge} className="px-3 py-2 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg disabled:opacity-40 shrink-0">{checkingBridge ? '检测中...' : '重新检测'}</button>
          </div>
          {bridgeStatus?.error && <div className="mt-3 text-xs text-amber-300 flex items-start space-x-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{bridgeStatus.error}</span></div>}
        </div>
        <button onClick={onOpenSetup} className="w-full px-4 py-3 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl flex items-center justify-center space-x-2">
          <Settings size={16} />
          <span>{bridgeOk ? '重新设置 REAPER' : '打开 Setup Wizard'}</span>
        </button>
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6 space-y-3 text-sm">
        <h3 className="text-sm font-bold text-slate-200 mb-4">当前连接的 REAPER</h3>
        <Row k="状态" v={bridgeStatus?.setup_state || '未知'} />
        <Row k="WebUI 端口" v={bridgeStatus?.webui_port} />
        <Row k="版本" v={bridgeStatus?.bridge_app_version} />
        <Row k="程序位置" v={bridgeStatus?.bridge_exe_path} />
        <Row k="资源目录" v={bridgeStatus?.bridge_resource_path} />
        <Row k="已选 Item" v={bridgeStatus?.selected_item_count ?? '未知'} />
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6 space-y-3 text-sm">
        <h3 className="text-sm font-bold text-slate-200 mb-4">已保存绑定</h3>
        <Row k="版本" v={bridgeStatus?.confirmed_reaper_app_version} />
        <Row k="程序位置" v={bridgeStatus?.confirmed_reaper_exe_path} />
        <Row k="资源目录" v={bridgeStatus?.confirmed_reaper_resource_path} />
        <Row k="确认时间" v={bridgeStatus?.confirmed_at ? formatDate(bridgeStatus.confirmed_at) : ''} />
      </div>
      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 space-y-3 text-sm"><Row k="API 地址" v={apiBase} /><Row k="主机名" v={networkInfo?.hostname} /><Row k="设备 ID" v={networkInfo?.peer_id} /><Row k="身份指纹" v={networkInfo?.peer_fingerprint} /><Row k="主 IP" v={networkInfo?.ip} /><Row k="监听端口" v={networkInfo?.port} /><Row k="所有 IP" v={(networkInfo?.all_ips || []).join('  ·  ')} /><Row k="共享密钥" v={networkInfo?.shared_token_required ? '已启用' : '未启用'} /></div>
      <p className="text-xs text-slate-500 mt-4 leading-relaxed">提示：仅在你信任的局域网内运行。若启用了共享密钥，发送方需在请求头携带相同的 <code className="text-slate-300">X-Capsule-Token</code>。</p>
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
      toast.success(`WebUI 端口已设为 ${nextPort}`);
      await refresh();
    } catch (e) {
      toast.error(`保存端口失败：${e.message}`);
    }
  };

  const openScriptFolder = async () => {
    try {
      await api.openReaperBridgeScriptFolder();
      toast.success('已打开脚本目录');
    } catch (e) {
      toast.error(`打开脚本目录失败：${e.message}`);
    }
  };

  const confirmCurrentReaper = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const r = await api.confirmReaperBridge({ webui_port: Number(port) || 9000 });
      setCurrent(r.data);
      toast.success('已保存 REAPER 设置');
      onRefresh();
      onClose();
    } catch (e) {
      toast.error(`保存失败：${e.message}`);
    } finally {
      setConfirming(false);
    }
  };

  const state = current?.setup_state || 'NEED_WEBUI';
  const currentStep = !current?.webui_available ? 0 : (!current?.bridge_available || state === 'NEED_REPAIR' ? 1 : 2);
  const canConfirm = current?.webui_available && current?.bridge_available && current?.bridge_resource_path;

  const steps = [
    { title: '打开目标 REAPER 并启用 WebUI', done: Boolean(current?.webui_available) },
    { title: '在当前 REAPER 中运行 Bridge 安装脚本', done: Boolean(current?.bridge_available) && state !== 'NEED_REPAIR' },
    { title: '确认并保存当前 REAPER', done: state === 'READY' },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto custom-scrollbar bg-[#161920] border border-slate-700 rounded-2xl shadow-2xl">
        <div className="sticky top-0 bg-[#161920] border-b border-slate-800 p-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-white">REAPER Setup Wizard</h2>
            <p className="text-sm text-slate-500 mt-1">{current?.setup_message || '按步骤完成 REAPER 设置。'}</p>
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
                <h3 className="text-sm font-bold text-slate-100 mb-3">1. 打开你真正要用于 Capsule Transfer 的 REAPER</h3>
                <div className="text-sm text-slate-400 leading-7">
                  Windows 用户请打开目标 REAPER，不要打开其他 portable / 测试版本。然后在 REAPER 中进入：
                  <div className="mt-2 font-mono text-xs text-slate-200 bg-black/20 border border-slate-800 rounded-lg p-3">Options → Preferences → Control/OSC/Web → Add → Web browser interface → Port {port}</div>
                </div>
                <div className="flex items-center gap-3 mt-4">
                  <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} className="w-28 bg-[#161920] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200" />
                  <button onClick={savePortAndRefresh} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">保存端口并检测</button>
                  <button onClick={refresh} disabled={checking} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40">{checking ? '检测中...' : '重新检测'}</button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 1 && (
            <div className="space-y-4">
              <div className="bg-[#0f1115] border border-slate-800 rounded-xl p-5">
                <h3 className="text-sm font-bold text-slate-100 mb-3">2. 在当前 REAPER 中运行安装脚本</h3>
                <div className="text-sm text-slate-400 leading-7">
                  在 REAPER 中进入 Actions，选择 Load ReaScript，加载并运行：
                  <div className="mt-2 font-mono text-xs text-slate-200 bg-black/20 border border-slate-800 rounded-lg p-3 break-all">{current?.installer_script || 'install_capsule_bridge.lua'}</div>
                  运行后 Bridge 会写入当前 REAPER 的启动脚本，以后打开这个 REAPER 会自动运行。
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-4">
                  <button onClick={openScriptFolder} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg flex items-center gap-2"><FolderOpen size={15} />打开脚本所在文件夹</button>
                  <button onClick={refresh} disabled={checking} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40">{checking ? '检测中...' : '我已运行，重新检测'}</button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-4">
              {state === 'MISMATCHED_REAPER' && <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-200">当前连接的 REAPER 与上次保存的资源目录不同。若这不是你要使用的 REAPER，请关闭错误实例并打开正确的 REAPER 后重新检测。</div>}
              <div className="bg-[#0f1115] border border-slate-800 rounded-xl p-5 space-y-3 text-sm">
                <h3 className="text-sm font-bold text-slate-100 mb-3">3. 确认这是目标 REAPER</h3>
                <Row k="版本" v={current?.bridge_app_version} />
                <Row k="程序位置" v={current?.bridge_exe_path} />
                <Row k="资源目录" v={current?.bridge_resource_path} />
                <Row k="已保存资源目录" v={current?.confirmed_reaper_resource_path} />
              </div>
              <div className="flex flex-wrap items-center justify-end gap-3">
                <button onClick={refresh} disabled={checking || confirming} className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg disabled:opacity-40">{checking ? '检测中...' : '重新检测'}</button>
                <button onClick={confirmCurrentReaper} disabled={!canConfirm || confirming || checking} className="px-5 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-40 flex items-center gap-2">
                  {confirming && <RefreshCw size={14} className="animate-spin" />}
                  <span>{confirming ? '正在保存...' : '确认并保存设置'}</span>
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
          <h3 className="text-lg font-bold text-white">待确认传输</h3>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-slate-200"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
          {requests.map((req) => (
            <div key={req.id} className="bg-[#0f1115] border border-slate-800 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-200 truncate">{req.capsule_name || '胶囊'}</div>
                  <div className="text-xs text-slate-500 mt-1">来自 {req.sender_name || req.sender_ip || '未知设备'}</div>
                  <div className="text-[10px] text-slate-600 mt-1">{formatBytes(req.size_bytes || 0)}{req.capsule_type ? ` · ${req.capsule_type}` : ''}</div>
                </div>
              </div>
              <div className="flex justify-end space-x-2 mt-4">
                <button onClick={() => onReject(req)} className="px-4 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg">拒绝</button>
                <button onClick={() => onAccept(req)} className="px-4 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shadow-lg shadow-indigo-600/20">接受</button>
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
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"><div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-8 w-[380px] shadow-2xl text-center">{isWorking && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-indigo-600/20 flex items-center justify-center"><RefreshCw size={28} className="text-indigo-400 animate-spin" /></div><h3 className="text-lg font-bold text-white mb-2">正在捕获胶囊</h3><p className="text-sm text-slate-400 leading-relaxed whitespace-pre-line">{status.message}</p><div className="mt-5 h-1 bg-slate-800 rounded-full overflow-hidden"><div className="h-full w-2/3 bg-indigo-500 rounded-full animate-pulse" /></div></>}{isDone && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-emerald-600/20 flex items-center justify-center"><Zap size={28} className="text-emerald-400" fill="currentColor" /></div><h3 className="text-lg font-bold text-white mb-2">捕获完成</h3><p className="text-sm text-slate-400 whitespace-pre-line">{status.message}</p></>}{isError && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-red-600/20 flex items-center justify-center"><FileAudio size={28} className="text-red-400" /></div><h3 className="text-lg font-bold text-white mb-2">捕获失败</h3><p className="text-sm text-red-300 leading-relaxed whitespace-pre-line">{status.message}</p><button onClick={onClose} className="mt-5 px-5 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg">关闭</button></>}</div></div>;
}

function CaptureOverlayV2({ status, onClose }) {
  const isWorking = ['exporting', 'saving', 'rendering'].includes(status.phase);
  const isDone = status.phase === 'done';
  const isError = status.phase === 'error';
  const showWorkingLayout = isWorking || (isDone && status.settled);
  const steps = status.steps || [];
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
          <h3 className="text-lg font-bold text-white mb-2">{isDone ? '捕获完成' : '正在捕获胶囊'}</h3>
          <p className="text-sm text-slate-400 leading-relaxed whitespace-pre-line">{status.message}</p>
        </>}
        {isDone && !status.settled && <>
          <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-emerald-600/20 flex items-center justify-center"><Zap size={28} className="text-emerald-400" fill="currentColor" /></div>
          <h3 className="text-lg font-bold text-white mb-2">捕获完成</h3>
          <p className="text-sm text-slate-400 whitespace-pre-line">{status.message}</p>
        </>}
        {isError && <>
          <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-red-600/20 flex items-center justify-center"><FileAudio size={28} className="text-red-400" /></div>
          <h3 className="text-lg font-bold text-white mb-2">捕获失败</h3>
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
        {isWorking && <div className="mt-5 h-1 bg-slate-800 rounded-full overflow-hidden"><div className="h-full w-2/3 bg-indigo-500 rounded-full animate-pulse" /></div>}
        {(isDone || isError) && <button onClick={onClose} className="mt-5 px-5 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg">关闭</button>}
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

  return <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-5 mb-6"><h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center space-x-2"><FileAudio size={16} className="text-indigo-400" /><span>从 REAPER 捕获胶囊</span></h3><p className="text-xs text-slate-500 mb-5 leading-relaxed">请确保 REAPER 已打开、Bridge 已安装，并在当前工程中选中了要导出的 Item。点击“开始捕获”后会通过 Bridge 在后台导出，不会主动切换焦点。</p><div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5"><div><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">胶囊类型</label><div className="grid grid-cols-2 gap-2">{CAPSULE_TYPES.map((t) => <button key={t.id} onClick={() => setCapsuleType(t.id)} className={`px-3 py-2 rounded-lg text-sm font-medium border ${capsuleType === t.id ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-[#0f1115] border-slate-800 text-slate-400 hover:border-slate-600'}`}>{t.label}</button>)}</div></div><div><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">渲染预览音频</label><button onClick={() => setRenderPreview((v) => !v)} className="flex items-center space-x-3 bg-[#0f1115] border border-slate-800 rounded-lg px-4 py-2.5 w-full"><div className={`w-10 h-5 rounded-full relative ${renderPreview ? 'bg-indigo-600' : 'bg-slate-700'}`}><div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${renderPreview ? 'left-5' : 'left-0.5'}`} /></div><span className="text-sm text-slate-300">{renderPreview ? '将生成预览 WAV' : '不生成预览'}</span></button></div></div><div className="flex justify-end space-x-2"><button onClick={onCancel} disabled={isExporting} className="px-4 py-2 text-sm text-slate-400 hover:text-white disabled:opacity-40">取消</button><button onClick={submit} disabled={isExporting} className="px-5 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg flex items-center space-x-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-indigo-600/20">{isExporting ? <><RefreshCw size={14} className="animate-spin" /><span>正在捕获…</span></> : <><Zap size={14} fill="currentColor" /><span>开始捕获</span></>}</button></div></div>;
}

export default function App() {
  return <ToastProvider><Shell /></ToastProvider>;
}
