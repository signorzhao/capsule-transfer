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
  Upload,
  RefreshCw,
  Copy,
  Play,
  Pause,
  FolderOpen,
  Pencil,
  Check,
  X,
  Shield,
  ShieldOff,
  ShieldCheck,
  Bell,
} from 'lucide-react';

import NavIcon from './components/NavIcon.jsx';
import { ToastProvider, useToast } from './components/Toast.jsx';
import { api, uploadCapsuleBundle } from './api.js';

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

  // 接收模式
  const [receiveMode, setReceiveMode] = useState('auto');
  const [pendingRequests, setPendingRequests] = useState([]);
  const [showIncoming, setShowIncoming] = useState(false);

  // 加载接收模式
  useEffect(() => {
    api.getReceiveMode().then((r) => setReceiveMode(r.data?.mode || 'auto')).catch(() => {});
  }, []);

  // SSE 实时通知
  useEffect(() => {
    let es;
    try {
      es = new EventSource(api.notificationsUrl);
      es.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'transfer_request') {
            setPendingRequests((prev) => [...prev, data.request]);
            setShowIncoming(true);
            // 原生通知 + 任务栏闪烁（Tauri）或浏览器通知
            try {
              const { notifyNewCapsule, flashTaskbar } = await import('./tauri-bridge.js');
              await notifyNewCapsule(data.request.sender_name);
              await flashTaskbar();
            } catch {
              if (Notification.permission === 'granted') {
                new Notification('收到胶囊传输请求', {
                  body: `${data.request.sender_name} 想发送 "${data.request.capsule_name}" 给你`,
                });
              }
            }
            toast.info(`${data.request.sender_name} 请求发送 "${data.request.capsule_name}"`);
          } else if (data.type === 'capsule_received') {
            try {
              const { notifyNewCapsule, flashTaskbar } = await import('./tauri-bridge.js');
              await notifyNewCapsule(data.capsule?.sender || '未知');
              await flashTaskbar();
            } catch {}
            toast.success(`收到新胶囊：${data.capsule?.name}`);
            refreshAll();
          }
        } catch {}
      };
    } catch {}
    // 请求浏览器通知权限（非 Tauri 环境）
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    return () => { if (es) es.close(); };
  }, []);

  // 定期刷新待确认请求
  useEffect(() => {
    if (receiveMode !== 'confirm') return;
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

  const handleChangeReceiveMode = async (mode) => {
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
      setPendingRequests((prev) => prev.filter((r) => r.id !== req.id));
      toast.success(`已接受 ${req.sender_name} 的传输`);
    } catch (e) {
      toast.error(`接受失败：${e.message}`);
    }
  };

  const handleRejectRequest = async (req) => {
    try {
      await api.rejectRequest(req.id);
      setPendingRequests((prev) => prev.filter((r) => r.id !== req.id));
      toast.info(`已拒绝 ${req.sender_name} 的传输`);
    } catch (e) {
      toast.error(`拒绝失败：${e.message}`);
    }
  };

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

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 15000);
    return () => clearInterval(t);
  }, [refreshAll]);

  const handleSelectCapsuleForSend = (cap) => {
    setSelectedCapsules((prev) =>
      prev.find((c) => c.id === cap.id) ? prev : [...prev, cap]
    );
    setActiveTab('transfer');
  };

  const handleStartTransferTo = (contact) => {
    setTargetContacts((prev) =>
      prev.find((c) => c.id === contact.id) ? prev : [...prev, contact]
    );
    setActiveTab('transfer');
  };

  const handleSend = async () => {
    if (selectedCapsules.length === 0) {
      toast.error('请先选择要发送的胶囊');
      return;
    }
    const peers = [...targetContacts];
    if (tempPeer.ip) {
      peers.push({ name: tempPeer.ip, ip: tempPeer.ip, port: Number(tempPeer.port) || 5005 });
    }
    if (peers.length === 0) {
      toast.error('请选择联系人或填写临时 IP');
      return;
    }
    setIsSending(true);
    let successCount = 0;
    let failCount = 0;
    for (const cap of selectedCapsules) {
      for (const peer of peers) {
        try {
          await api.send({
            capsule_id: cap.uuid || cap.id,
            target_ip: peer.ip,
            target_port: peer.port,
            target_name: peer.name,
          });
          successCount++;
        } catch (e) {
          failCount++;
          toast.error(`发送 "${cap.name}" → ${peer.name} 失败：${e.message}`);
        }
      }
    }
    if (successCount > 0) {
      toast.success(`已完成 ${successCount} 项发送`);
    }
    setSelectedCapsules([]);
    setTargetContacts([]);
    setTempPeer({ ip: '', port: '5005' });
    refreshAll();
    setIsSending(false);
  };

  const handleUploadBundle = async (file) => {
    if (!file) return;
    try {
      const resp = await uploadCapsuleBundle(file);
      toast.success(`已导入：${resp.data?.name || '胶囊'}`);
      refreshAll();
    } catch (e) {
      toast.error(`导入失败：${e.message}`);
    }
  };

  const handleCreateCapsule = async (payload) => {
    setCaptureStatus({ phase: 'exporting', message: '正在通知 Reaper 导出…' });
    try {
      setCaptureStatus({ phase: 'exporting', message: '等待 Reaper 执行导出脚本…' });
      const resp = await fetch(`${api.base}/capsules/webui-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await resp.json();
      if (!resp.ok || !body.success) throw new Error(body.error || `HTTP ${resp.status}`);
      const imported = body.data?.auto_imported;
      if (imported && imported.length > 0) {
        setCaptureStatus({ phase: 'done', message: `捕获成功：${imported[0].name}` });
        setTimeout(() => setCaptureStatus(null), 2000);
        toast.success(`已从 Reaper 捕获：${imported[0].name}`);
      } else {
        setCaptureStatus(null);
        toast.success('Reaper 导出完成，但未能自动入库，请检查导出目录');
      }
      refreshAll();
    } catch (e) {
      setCaptureStatus({ phase: 'error', message: e.message });
      setTimeout(() => setCaptureStatus(null), 4000);
      toast.error(`Reaper 捕获失败：${e.message}`);
    }
  };

  const handleDeleteCapsule = async (cap) => {
    if (!window.confirm(`确认删除胶囊 "${cap.name}"？文件也会从本地删除。`)) return;
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
      const r = await api.pingContact({ ip: contact.ip, port: contact.port });
      if (r.data?.online) {
        toast.success(`${contact.name} 在线（${r.data.latency_ms} ms）`);
      } else {
        toast.error(`${contact.name} 不可达`);
      }
      refreshAll();
    } catch (e) {
      toast.error(`Ping 失败：${e.message}`);
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

  const onlineContacts = useMemo(() => {
    return contacts.filter((c) => {
      if (!c.last_seen) return false;
      const t = new Date(`${c.last_seen}Z`).getTime();
      return Date.now() - t < 5 * 60 * 1000;
    });
  }, [contacts]);

  const myInfoLine = networkInfo
    ? `${networkInfo.hostname} · ${networkInfo.ip}:${networkInfo.port}`
    : '正在探测本机网络…';

  return (
    <div className="flex h-screen bg-[#0f1115] text-slate-200 font-sans overflow-hidden">
      <aside className="w-16 bg-[#161920] border-r border-slate-800 flex flex-col items-center py-6 space-y-8">
        <div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <Zap size={20} className="text-white" fill="white" />
        </div>
        <div className="flex flex-col space-y-4">
          <NavIcon
            active={activeTab === 'library'}
            onClick={() => setActiveTab('library')}
            icon={<Package size={20} />}
            label="库"
          />
          <NavIcon
            active={activeTab === 'contacts'}
            onClick={() => setActiveTab('contacts')}
            icon={<Users size={20} />}
            label="联系人"
          />
          <NavIcon
            active={activeTab === 'transfer'}
            onClick={() => setActiveTab('transfer')}
            icon={<Send size={20} />}
            label="发送"
          />
        </div>
        <div className="mt-auto">
          <NavIcon
            active={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')}
            icon={<Settings size={20} />}
            label="设置"
          />
        </div>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-[#0f1115]/80 backdrop-blur-md">
          <div className="flex items-center space-x-4">
            <div
              className={`flex items-center space-x-2 px-3 py-1 rounded-full border ${
                serverOnline
                  ? 'bg-emerald-500/10 border-emerald-500/20'
                  : 'bg-red-500/10 border-red-500/30'
              }`}
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  serverOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'
                }`}
              />
              <span
                className={`text-[10px] font-mono uppercase tracking-widest font-bold ${
                  serverOnline ? 'text-emerald-500' : 'text-red-400'
                }`}
              >
                {serverOnline ? 'Local Server Online' : 'Server Offline'}
              </span>
            </div>
            <div className="text-sm font-mono text-slate-400">{myInfoLine}</div>
            {networkInfo?.ip && (
              <button
                onClick={() => {
                  navigator.clipboard
                    .writeText(`${networkInfo.ip}:${networkInfo.port}`)
                    .then(() => toast.success('已复制本机地址'));
                }}
                className="text-slate-500 hover:text-slate-200 transition-colors"
                title="复制 IP:端口"
              >
                <Copy size={14} />
              </button>
            )}
          </div>
          <div className="flex items-center space-x-3">
            {/* 接收模式开关 */}
            <div className="flex items-center bg-[#161920] border border-slate-800 rounded-lg overflow-hidden">
              <button
                onClick={() => handleChangeReceiveMode('off')}
                className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 transition-all ${
                  receiveMode === 'off'
                    ? 'bg-red-500/20 text-red-400 border-r border-red-500/30'
                    : 'text-slate-500 hover:text-slate-300 border-r border-slate-800'
                }`}
                title="关闭接收"
              >
                <ShieldOff size={12} />
                <span>关闭</span>
              </button>
              <button
                onClick={() => handleChangeReceiveMode('confirm')}
                className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 transition-all ${
                  receiveMode === 'confirm'
                    ? 'bg-amber-500/20 text-amber-400 border-r border-amber-500/30'
                    : 'text-slate-500 hover:text-slate-300 border-r border-slate-800'
                }`}
                title="验证接收（需确认）"
              >
                <ShieldCheck size={12} />
                <span>验证</span>
              </button>
              <button
                onClick={() => handleChangeReceiveMode('auto')}
                className={`px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center space-x-1 transition-all ${
                  receiveMode === 'auto'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                title="自动接收"
              >
                <Shield size={12} />
                <span>自动</span>
              </button>
            </div>

            {/* 待确认通知 */}
            {pendingRequests.length > 0 && (
              <button
                onClick={() => setShowIncoming(true)}
                className="relative p-2 text-amber-400 hover:text-amber-300 transition-colors"
                title={`${pendingRequests.length} 个待确认请求`}
              >
                <Bell size={18} />
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {pendingRequests.length}
                </span>
              </button>
            )}

            <button
              onClick={refreshAll}
              className="text-slate-500 hover:text-slate-200 flex items-center space-x-1 text-xs"
              title="刷新"
            >
              <RefreshCw size={14} />
              <span>刷新</span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {activeTab === 'library' && (
            <LibraryView
              capsules={capsules}
              onSend={handleSelectCapsuleForSend}
              onDelete={handleDeleteCapsule}
              onUpload={handleUploadBundle}
              onCreate={handleCreateCapsule}
              onRename={handleRenameCapsule}
              onOpenRpp={handleOpenRpp}
            />
          )}

          {activeTab === 'contacts' && (
            <ContactsView
              contacts={contacts}
              onlineContacts={onlineContacts}
              onSend={handleStartTransferTo}
              onDelete={handleDeleteContact}
              onPing={handlePingContact}
              showAddForm={showAddContact}
              setShowAddForm={setShowAddContact}
              onAdd={handleAddContact}
            />
          )}

          {activeTab === 'transfer' && (
            <TransferView
              capsules={capsules}
              contacts={contacts}
              selectedCapsules={selectedCapsules}
              setSelectedCapsules={setSelectedCapsules}
              targetContacts={targetContacts}
              setTargetContacts={setTargetContacts}
              tempPeer={tempPeer}
              setTempPeer={setTempPeer}
              showTempPeerForm={showTempPeerForm}
              setShowTempPeerForm={setShowTempPeerForm}
              isSending={isSending}
              onSend={handleSend}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView networkInfo={networkInfo} apiBase={api.base} />
          )}
        </main>
      </div>

      {captureStatus && <CaptureOverlay status={captureStatus} onClose={() => setCaptureStatus(null)} />}

      {/* 传输确认弹窗 */}
      {showIncoming && pendingRequests.length > 0 && (
        <IncomingRequestsOverlay
          requests={pendingRequests}
          onAccept={handleAcceptRequest}
          onReject={handleRejectRequest}
          onClose={() => setShowIncoming(false)}
        />
      )}
    </div>
  );
}

function LibraryView({ capsules, onSend, onDelete, onUpload, onCreate, onRename, onOpenRpp }) {
  const inputRef = React.useRef(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const handlePlay = (cap) => {
    if (playingId === cap.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(api.previewUrl(cap.id));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    audio.play();
    audioRef.current = audio;
    setPlayingId(cap.id);
  };

  const startRename = (cap) => {
    setEditingId(cap.id);
    setEditName(cap.name);
  };

  const confirmRename = (cap) => {
    if (editName.trim() && editName.trim() !== cap.name) {
      onRename(cap, editName.trim());
    }
    setEditingId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) audioRef.current.pause();
    };
  }, []);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">我的胶囊</h1>
          <p className="text-slate-500 text-sm mt-1">
            本地已捕获 / 接收的胶囊（共 {capsules.length} 个）
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <input
            ref={inputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              onUpload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            className="border border-slate-700 hover:bg-slate-800 text-slate-300 px-4 py-2 rounded-lg flex items-center space-x-2 transition-all"
            title="导入 .capsule.zip"
          >
            <Upload size={16} />
            <span>导入胶囊</span>
          </button>
          <button
            onClick={() => setShowCreateForm((v) => !v)}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg flex items-center space-x-2 transition-all shadow-lg shadow-indigo-600/20"
          >
            <Plus size={18} />
            <span>新捕获</span>
          </button>
        </div>
      </div>

      {showCreateForm && (
        <CreateCapsuleForm
          onCancel={() => setShowCreateForm(false)}
          onSubmit={async (data) => {
            await onCreate(data);
            setShowCreateForm(false);
          }}
        />
      )}

      {capsules.length === 0 && !showCreateForm ? (
        <div className="border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center p-16 text-slate-500">
          <Package size={32} className="mb-3" />
          <p className="text-sm">暂无胶囊。可点右上角"新捕获"从本地目录创建，或"导入胶囊"加载 .capsule.zip。</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {capsules.map((cap) => (
            <div
              key={cap.id}
              className="group bg-[#1a1d24] hover:bg-[#21252e] border border-slate-800 p-4 rounded-xl flex items-center transition-all"
            >
              <button
                onClick={() => handlePlay(cap)}
                className={`w-10 h-10 rounded flex items-center justify-center mr-4 transition-all ${
                  playingId === cap.id
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-indigo-400 hover:bg-indigo-600/20'
                }`}
                title={playingId === cap.id ? '暂停预览' : '播放预览'}
              >
                {playingId === cap.id ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <div className="flex-1 min-w-0">
                {editingId === cap.id ? (
                  <div className="flex items-center space-x-2">
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') confirmRename(cap);
                        if (e.key === 'Escape') cancelRename();
                      }}
                      className="flex-1 bg-[#0f1115] border border-indigo-500 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none"
                    />
                    <button
                      onClick={() => confirmRename(cap)}
                      className="p-1 text-emerald-400 hover:text-emerald-300"
                      title="确认"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      onClick={cancelRename}
                      className="p-1 text-slate-500 hover:text-slate-300"
                      title="取消"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <h3
                    className="font-medium text-slate-200 truncate cursor-pointer hover:text-indigo-300 transition-colors"
                    onDoubleClick={() => startRename(cap)}
                    title="双击重命名"
                  >
                    {cap.name}
                  </h3>
                )}
                <div className="text-xs text-slate-500 mt-1 flex space-x-3">
                  <span>{formatDate(cap.created_at)}</span>
                  <span>{formatBytes(cap.size_bytes)}</span>
                  {cap.source_peer && (
                    <span className="text-emerald-500/80">来自 {cap.source_peer}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => startRename(cap)}
                className="opacity-0 group-hover:opacity-100 mr-1 p-2 text-slate-500 hover:text-indigo-400 transition-all"
                title="重命名"
              >
                <Pencil size={15} />
              </button>
              <button
                onClick={() => onOpenRpp(cap)}
                className="opacity-0 group-hover:opacity-100 mr-1 p-2 text-slate-500 hover:text-amber-400 transition-all"
                title="在 Reaper 中打开工程"
              >
                <FolderOpen size={16} />
              </button>
              <button
                onClick={() => onSend(cap)}
                className="opacity-0 group-hover:opacity-100 mr-1 p-2 bg-indigo-600/10 text-indigo-400 rounded-lg hover:bg-indigo-600 hover:text-white transition-all"
                title="发送给…"
              >
                <Send size={16} />
              </button>
              <button
                onClick={() => onDelete(cap)}
                className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400 transition-colors"
                title="删除"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactsView({
  contacts,
  onlineContacts,
  onSend,
  onDelete,
  onPing,
  showAddForm,
  setShowAddForm,
  onAdd,
}) {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">协作伙伴</h1>
          <p className="text-slate-500 text-sm mt-1">
            局域网内已保存的联系人（在线 {onlineContacts.length} / 共 {contacts.length}）
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className="border border-slate-700 hover:bg-slate-800 text-slate-300 px-4 py-2 rounded-lg flex items-center space-x-2 transition-all"
        >
          <UserPlus size={18} />
          <span>添加联系人</span>
        </button>
      </div>

      {showAddForm && <AddContactForm onCancel={() => setShowAddForm(false)} onSubmit={onAdd} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {contacts.map((contact) => {
          const online =
            contact.last_seen &&
            Date.now() - new Date(`${contact.last_seen}Z`).getTime() < 5 * 60 * 1000;
          return (
            <div
              key={contact.id}
              className="bg-[#1a1d24] border border-slate-800 p-5 rounded-2xl flex items-start justify-between group"
            >
              <div className="flex items-center space-x-4">
                <div className="relative">
                  <div className="w-12 h-12 bg-slate-700 rounded-full flex items-center justify-center text-xl font-bold text-slate-400 uppercase">
                    {(contact.name || '?')[0]}
                  </div>
                  {online && (
                    <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-emerald-500 border-2 border-[#1a1d24] rounded-full" />
                  )}
                </div>
                <div>
                  <h3 className="font-bold text-slate-200">{contact.name}</h3>
                  <p className="text-xs text-slate-500 font-mono mt-1">
                    {contact.ip}:{contact.port}
                  </p>
                  <p
                    className={`text-[10px] mt-2 ${
                      online ? 'text-emerald-500' : 'text-slate-600'
                    }`}
                  >
                    {online
                      ? '● 最近 5 分钟在线'
                      : contact.last_seen
                      ? `上次出现: ${formatDate(contact.last_seen)}`
                      : '未探测'}
                  </p>
                </div>
              </div>
              <div className="flex flex-col space-y-2">
                <button
                  onClick={() => onSend(contact)}
                  className="p-2 bg-indigo-600 rounded-lg text-white hover:bg-indigo-500 transition-colors"
                  title="向他发送"
                >
                  <Zap size={16} fill="white" />
                </button>
                <button
                  onClick={() => onPing(contact)}
                  className="p-2 text-slate-500 hover:text-slate-200 transition-colors"
                  title="探测在线"
                >
                  <RefreshCw size={16} />
                </button>
                <button
                  onClick={() => onDelete(contact)}
                  className="p-2 text-slate-600 hover:text-red-400 transition-colors"
                  title="删除"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          );
        })}

        <div
          onClick={() => setShowAddForm(true)}
          className="border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center p-6 text-slate-600 hover:border-slate-700 hover:text-slate-500 cursor-pointer transition-all"
        >
          <Search size={24} className="mb-2" />
          <span className="text-sm font-medium">手动添加 IP（自动发现 · 后续）</span>
        </div>
      </div>
    </div>
  );
}

function AddContactForm({ onCancel, onSubmit }) {
  const [form, setForm] = useState({ name: '', ip: '', port: '5005', note: '' });
  return (
    <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-5 mb-6">
      <h3 className="text-sm font-bold text-slate-200 mb-4">添加联系人</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FormField label="名称">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="例如：张三 (吉他手)"
          />
        </FormField>
        <FormField label="IP">
          <input
            value={form.ip}
            onChange={(e) => setForm({ ...form, ip: e.target.value })}
            placeholder="192.168.x.x"
          />
        </FormField>
        <FormField label="端口">
          <input
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
            placeholder="5005"
          />
        </FormField>
        <FormField label="备注（可选）">
          <input
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </FormField>
      </div>
      <div className="flex justify-end space-x-2 mt-5">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-slate-400 hover:text-white"
        >
          取消
        </button>
        <button
          onClick={() => {
            if (!form.name || !form.ip) return;
            onSubmit({ ...form, port: Number(form.port) || 5005 });
          }}
          className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
        {label}
      </span>
      {React.cloneElement(children, {
        className:
          'w-full bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500',
      })}
    </label>
  );
}

function TransferView({
  capsules,
  contacts,
  selectedCapsules,
  setSelectedCapsules,
  targetContacts,
  setTargetContacts,
  tempPeer,
  setTempPeer,
  showTempPeerForm,
  setShowTempPeerForm,
  isSending,
  onSend,
}) {
  const removeCapsule = (id) => setSelectedCapsules((prev) => prev.filter((c) => c.id !== id));
  const removeTarget = (id) => setTargetContacts((prev) => prev.filter((c) => c.id !== id));
  const toggleCapsule = (cap) => {
    setSelectedCapsules((prev) =>
      prev.find((c) => c.id === cap.id) ? prev.filter((c) => c.id !== cap.id) : [...prev, cap]
    );
  };
  const toggleTarget = (contact) => {
    setTargetContacts((prev) =>
      prev.find((c) => c.id === contact.id) ? prev.filter((c) => c.id !== contact.id) : [...prev, contact]
    );
  };

  const totalTasks = selectedCapsules.length * (targetContacts.length + (tempPeer.ip ? 1 : 0));

  return (
    <div className="max-w-2xl mx-auto mt-6">
      <div className="bg-[#1a1d24] p-8 rounded-3xl border border-slate-800 shadow-2xl relative overflow-hidden">
        <h2 className="text-xl font-bold text-white mb-6 flex items-center">
          <Send size={20} className="mr-2 text-indigo-500" />
          发送胶囊
        </h2>

        {/* 目标联系人（多选） */}
        <div className="mb-8">
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
            目标联系人（可多选）
          </label>

          {targetContacts.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {targetContacts.map((tc) => (
                <div
                  key={tc.id}
                  className="flex items-center space-x-2 bg-indigo-600/10 border border-indigo-500/30 px-3 py-1.5 rounded-full"
                >
                  <div className="w-6 h-6 bg-indigo-600/30 rounded-full flex items-center justify-center text-[10px] font-bold text-indigo-300">
                    {(tc.name || '?')[0]}
                  </div>
                  <span className="text-xs text-indigo-200">{tc.name}</span>
                  <button
                    onClick={() => removeTarget(tc.id)}
                    className="text-indigo-400 hover:text-white ml-1"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {showTempPeerForm ? (
            <div className="bg-[#0f1115] p-4 rounded-2xl border border-slate-800 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <input
                  className="col-span-2 bg-[#161920] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200"
                  placeholder="对方 IP（如 192.168.x.x）"
                  value={tempPeer.ip}
                  onChange={(e) => setTempPeer({ ...tempPeer, ip: e.target.value })}
                />
                <input
                  className="bg-[#161920] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200"
                  placeholder="端口"
                  value={tempPeer.port}
                  onChange={(e) => setTempPeer({ ...tempPeer, port: e.target.value })}
                />
              </div>
              <div className="text-xs text-slate-500">
                临时 IP 会与选定的联系人一起作为发送目标。
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => { setShowTempPeerForm(false); setTempPeer({ ip: '', port: '5005' }); }}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  取消临时 IP
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {contacts.length === 0 && targetContacts.length === 0 && (
                <div className="col-span-2 text-xs text-slate-500 bg-[#0f1115] border border-slate-800 rounded-xl p-3">
                  暂无联系人，可使用"临时 IP"立即发送。
                </div>
              )}
              {contacts.map((c) => {
                const selected = targetContacts.find((tc) => tc.id === c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => toggleTarget(c)}
                    className={`flex items-center space-x-3 bg-[#0f1115] p-3 rounded-xl border transition-all text-left ${
                      selected ? 'border-indigo-500 bg-indigo-600/5' : 'border-slate-800 hover:border-indigo-500'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs ${
                      selected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {selected ? <Check size={14} /> : (c.name || '?')[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{c.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono truncate">
                        {c.ip}:{c.port}
                      </div>
                    </div>
                  </button>
                );
              })}
              <button
                onClick={() => setShowTempPeerForm(true)}
                className="flex items-center justify-center space-x-2 bg-[#0f1115] p-3 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-500"
              >
                <Plus size={14} />
                <span className="text-xs">临时 IP</span>
              </button>
            </div>
          )}
        </div>

        {/* 内容选择（多选） */}
        <div className="mb-10">
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
            选择内容（可多选）
          </label>

          {selectedCapsules.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {selectedCapsules.map((cap) => (
                <div
                  key={cap.id}
                  className="flex items-center space-x-2 bg-slate-800/60 border border-slate-700 px-3 py-1.5 rounded-full"
                >
                  <FileAudio size={12} className="text-indigo-400" />
                  <span className="text-xs text-slate-200 max-w-[120px] truncate">{cap.name}</span>
                  <span className="text-[10px] text-slate-500">{formatBytes(cap.size_bytes)}</span>
                  <button
                    onClick={() => removeCapsule(cap.id)}
                    className="text-slate-400 hover:text-white ml-1"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
            {capsules.length === 0 && (
              <div className="text-xs text-slate-500 bg-[#0f1115] border border-slate-800 rounded-xl p-3">
                胶囊库为空，先在"库"页导入或捕获胶囊。
              </div>
            )}
            {capsules.map((cap) => {
              const selected = selectedCapsules.find((sc) => sc.id === cap.id);
              return (
                <button
                  key={cap.id}
                  onClick={() => toggleCapsule(cap)}
                  className={`w-full text-left bg-[#0f1115] p-3 rounded-xl border flex items-center justify-between transition-all ${
                    selected ? 'border-indigo-500 bg-indigo-600/5' : 'border-slate-800 hover:border-indigo-500'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <div className={`w-5 h-5 rounded flex items-center justify-center ${
                      selected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-500'
                    }`}>
                      {selected ? <Check size={12} /> : null}
                    </div>
                    <FileAudio className="text-indigo-400 shrink-0" size={16} />
                    <span className="text-xs truncate">{cap.name}</span>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {formatBytes(cap.size_bytes)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 发送摘要 */}
        {totalTasks > 0 && (
          <div className="mb-4 text-xs text-slate-400 text-center">
            将发送 {selectedCapsules.length} 个胶囊 → {targetContacts.length + (tempPeer.ip ? 1 : 0)} 个目标（共 {totalTasks} 项任务）
          </div>
        )}

        <button
          disabled={selectedCapsules.length === 0 || totalTasks === 0 || isSending}
          onClick={onSend}
          className={`w-full py-4 rounded-2xl font-bold flex items-center justify-center space-x-2 transition-all ${
            isSending || selectedCapsules.length === 0 || totalTasks === 0
              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 active:scale-[0.98]'
          }`}
        >
          {isSending ? (
            <span>正在发射…</span>
          ) : (
            <>
              <Zap size={18} fill="currentColor" />
              <span>立即发送</span>
            </>
          )}
        </button>

        {isSending && (
          <div className="absolute bottom-0 left-0 w-full bg-slate-800 h-1 overflow-hidden">
            <div className="bg-indigo-500 h-full w-1/3 animate-pulse" />
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsView({ networkInfo, apiBase }) {
  const [settings, setSettings] = useState(null);
  const [reaperPath, setReaperPath] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.getSettings().then((r) => {
      setSettings(r.data);
      setReaperPath(r.data?.reaper_path || '');
    }).catch(() => {});
  }, []);

  const handleSaveReaperPath = async () => {
    setSaving(true);
    try {
      const r = await api.updateSettings({ reaper_path: reaperPath });
      setSettings(r.data);
      toast.success('Reaper 路径已保存');
    } catch (e) {
      toast.error(`保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-white mb-6">设置 / 信息</h1>

      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6">
        <h3 className="text-sm font-bold text-slate-200 mb-4">Reaper 路径</h3>
        <div className="flex items-center space-x-3">
          <input
            value={reaperPath}
            onChange={(e) => setReaperPath(e.target.value)}
            placeholder="例如：/Applications/REAPER.app 或留空自动检测"
            className="flex-1 bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={handleSaveReaperPath}
            disabled={saving}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          macOS 填 .app 路径即可（如 /Applications/REAPER.app），程序会自动解析到可执行文件。
        </p>
      </div>

      <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 space-y-3 text-sm">
        <Row k="API 地址" v={apiBase} />
        <Row k="主机名" v={networkInfo?.hostname} />
        <Row k="主 IP" v={networkInfo?.ip} />
        <Row k="监听端口" v={networkInfo?.port} />
        <Row k="所有 IP" v={(networkInfo?.all_ips || []).join('  ·  ')} />
        <Row
          k="共享密钥"
          v={networkInfo?.shared_token_required ? '已启用' : '未启用'}
        />
      </div>
      <p className="text-xs text-slate-500 mt-4 leading-relaxed">
        提示：仅在你信任的局域网内运行。若启用了共享密钥，发送方需在请求头携带相同的{' '}
        <code className="text-slate-300">X-Capsule-Token</code>。
      </p>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between border-b border-slate-800 pb-2">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-200 font-mono text-right break-all">{v ?? '—'}</span>
    </div>
  );
}

function IncomingRequestsOverlay({ requests, onAccept, onReject, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-6 w-[420px] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-white flex items-center space-x-2">
            <Bell size={20} className="text-amber-400" />
            <span>传输请求</span>
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
          {requests.map((req) => (
            <div
              key={req.id}
              className="bg-[#0f1115] border border-slate-800 rounded-2xl p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2 mb-1">
                    <div className="w-8 h-8 bg-indigo-600/20 rounded-full flex items-center justify-center text-sm font-bold text-indigo-300">
                      {(req.sender_name || '?')[0]}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-slate-200">{req.sender_name}</p>
                      <p className="text-[10px] text-slate-500 font-mono">{req.sender_ip}</p>
                    </div>
                  </div>
                  <div className="mt-2 pl-10">
                    <p className="text-xs text-slate-300">
                      想发送 <span className="text-indigo-300 font-medium">"{req.capsule_name}"</span>
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {req.capsule_type && `类型: ${req.capsule_type} · `}
                      {req.size_bytes ? formatBytes(req.size_bytes) : ''}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex justify-end space-x-2 mt-3">
                <button
                  onClick={() => onReject(req)}
                  className="px-4 py-1.5 text-xs border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/50 rounded-lg transition-all"
                >
                  拒绝
                </button>
                <button
                  onClick={() => onAccept(req)}
                  className="px-4 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-all shadow-lg shadow-indigo-600/20"
                >
                  接受
                </button>
              </div>
            </div>
          ))}
        </div>

        {requests.length === 0 && (
          <div className="text-center text-slate-500 text-sm py-8">暂无待确认请求</div>
        )}
      </div>
    </div>
  );
}

function CaptureOverlay({ status, onClose }) {
  const isWorking = status.phase === 'exporting';
  const isDone = status.phase === 'done';
  const isError = status.phase === 'error';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-8 w-[360px] shadow-2xl text-center">
        {isWorking && (
          <>
            <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-indigo-600/20 flex items-center justify-center">
              <RefreshCw size={28} className="text-indigo-400 animate-spin" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">正在捕获胶囊</h3>
            <p className="text-sm text-slate-400 leading-relaxed">{status.message}</p>
            <div className="mt-5 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full w-2/3 bg-indigo-500 rounded-full animate-pulse" />
            </div>
          </>
        )}
        {isDone && (
          <>
            <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-emerald-600/20 flex items-center justify-center">
              <Zap size={28} className="text-emerald-400" fill="currentColor" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">捕获完成</h3>
            <p className="text-sm text-slate-400">{status.message}</p>
          </>
        )}
        {isError && (
          <>
            <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-red-600/20 flex items-center justify-center">
              <FileAudio size={28} className="text-red-400" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">捕获失败</h3>
            <p className="text-sm text-red-300 leading-relaxed">{status.message}</p>
            <button
              onClick={onClose}
              className="mt-5 px-5 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg"
            >
              关闭
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CreateCapsuleForm({ onCancel, onSubmit }) {
  const [capsuleType, setCapsuleType] = useState('magic');
  const [renderPreview, setRenderPreview] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const CAPSULE_TYPES = [
    { id: 'magic', label: 'Magic' },
    { id: 'impact', label: 'Impact' },
    { id: 'atmosphere', label: 'Atmosphere' },
    { id: 'texture', label: 'Texture' },
  ];

  const submit = async () => {
    setIsExporting(true);
    try {
      await onSubmit({
        capsule_type: capsuleType,
        render_preview: renderPreview,
        webui_port: 9000,
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-5 mb-6">
      <h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center space-x-2">
        <FileAudio size={16} className="text-indigo-400" />
        <span>从 Reaper 捕获胶囊</span>
      </h3>

      <p className="text-xs text-slate-500 mb-5 leading-relaxed">
        请确保 Reaper 已打开，并在当前工程中选中了要导出的 Item。
        点击"开始捕获"后会自动通过 Reaper 导出、生成预览并入库。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
            胶囊类型
          </label>
          <div className="grid grid-cols-2 gap-2">
            {CAPSULE_TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => setCapsuleType(t.id)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-all border ${
                  capsuleType === t.id
                    ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                    : 'bg-[#0f1115] border-slate-800 text-slate-400 hover:border-slate-600'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
            渲染预览音频
          </label>
          <button
            onClick={() => setRenderPreview((v) => !v)}
            className="flex items-center space-x-3 bg-[#0f1115] border border-slate-800 rounded-lg px-4 py-2.5 w-full"
          >
            <div
              className={`w-10 h-5 rounded-full transition-all relative ${
                renderPreview ? 'bg-indigo-600' : 'bg-slate-700'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${
                  renderPreview ? 'left-5' : 'left-0.5'
                }`}
              />
            </div>
            <span className="text-sm text-slate-300">
              {renderPreview ? '将生成预览 WAV' : '不生成预览'}
            </span>
          </button>
        </div>
      </div>

      <div className="flex justify-end space-x-2">
        <button
          onClick={onCancel}
          disabled={isExporting}
          className="px-4 py-2 text-sm text-slate-400 hover:text-white disabled:opacity-40"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={isExporting}
          className="px-5 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg flex items-center space-x-2 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-indigo-600/20"
        >
          {isExporting ? (
            <>
              <RefreshCw size={14} className="animate-spin" />
              <span>正在捕获…</span>
            </>
          ) : (
            <>
              <Zap size={14} fill="currentColor" />
              <span>开始捕获</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
