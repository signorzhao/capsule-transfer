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
  Radio,
  DownloadCloud,
  AlertTriangle,
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
    setSelectedCapsules((prev) => (prev.find((c) => c.id === cap.id) ? prev : [...prev, cap]));
    setActiveTab('transfer');
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
          await api.send({ capsule_id: cap.uuid || cap.id, target_ip: peer.ip, target_port: peer.port, target_name: peer.name });
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
    setCaptureStatus({ phase: 'exporting', message: '正在连接 REAPER Bridge…' });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), payload?.render_preview ? 150000 : 60000);
    try {
      setCaptureStatus({ phase: 'exporting', message: '正在后台导出选中的 Items，REAPER 可保持最小化。' });
      const resp = await fetch(`${api.base}/capsules/webui-export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
      if (!resp.ok || !body.success) {
        const flags = body.data || {};
        let message = body.error || `HTTP ${resp.status}`;
        if (flags.needs_bridge_install) message = `${message}\n\n请到“设置 / 信息”安装 REAPER Bridge。`;
        if (flags.webui_required) message = `${message}\n\n请确认 REAPER 已打开并启用 Web Interface（默认端口 9000）。`;
        if (flags.export_phase) message = `${message}\n\nBridge 阶段：${flags.export_phase}`;
        if (flags.diagnostics) message = `${message}\n\n诊断：${flags.diagnostics}`;
        throw new Error(message);
      }

      const imported = body.data?.auto_imported;
      if (imported && imported.length > 0) {
        setCaptureStatus({ phase: 'done', message: `捕获成功：${imported[0].name}` });
        setTimeout(() => setCaptureStatus(null), 2200);
        toast.success(`已从 REAPER 捕获：${imported[0].name}`);
      } else {
        setCaptureStatus({ phase: 'done', message: 'REAPER 导出完成，但未能自动入库，请检查导出目录。' });
        setTimeout(() => setCaptureStatus(null), 3000);
      }
      refreshAll();
    } catch (e) {
      const message = e.name === 'AbortError'
        ? '等待 REAPER Bridge 超过 60 秒，请到“设置 / 信息”重新检测或重新启动 Bridge。'
        : e.message;
      setCaptureStatus({ phase: 'error', message });
      toast.error(`REAPER 捕获失败：${message}`);
    } finally {
      clearTimeout(timeoutId);
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
      toast[r.data?.online ? 'success' : 'error'](r.data?.online ? `${contact.name} 在线（${r.data.latency_ms} ms）` : `${contact.name} 不可达`);
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

  const onlineContacts = useMemo(() => contacts.filter((c) => c.last_seen && Date.now() - new Date(`${c.last_seen}Z`).getTime() < 5 * 60 * 1000), [contacts]);
  const myInfoLine = networkInfo ? `${networkInfo.hostname} · ${networkInfo.ip}:${networkInfo.port}` : '正在探测本机网络…';

  return (
    <div className="flex h-screen bg-[#0f1115] text-slate-200 font-sans overflow-hidden">
      <aside className="w-16 bg-[#161920] border-r border-slate-800 flex flex-col items-center py-6 space-y-8">
        <div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center shadow-lg shadow-indigo-500/20"><Zap size={20} className="text-white" fill="white" /></div>
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
          <button onClick={refreshAll} className="text-slate-500 hover:text-slate-200 flex items-center space-x-1 text-xs"><RefreshCw size={14} /><span>刷新</span></button>
        </header>

        <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {activeTab === 'library' && <LibraryView capsules={capsules} onSend={handleSelectCapsuleForSend} onDelete={handleDeleteCapsule} onUpload={handleUploadBundle} onCreate={handleCreateCapsule} onRename={handleRenameCapsule} onOpenRpp={handleOpenRpp} />}
          {activeTab === 'contacts' && <ContactsView contacts={contacts} onlineContacts={onlineContacts} onSend={handleStartTransferTo} onDelete={handleDeleteContact} onPing={handlePingContact} showAddForm={showAddContact} setShowAddForm={setShowAddContact} onAdd={handleAddContact} />}
          {activeTab === 'transfer' && <TransferView capsules={capsules} contacts={contacts} selectedCapsules={selectedCapsules} setSelectedCapsules={setSelectedCapsules} targetContacts={targetContacts} setTargetContacts={setTargetContacts} tempPeer={tempPeer} setTempPeer={setTempPeer} showTempPeerForm={showTempPeerForm} setShowTempPeerForm={setShowTempPeerForm} isSending={isSending} onSend={handleSend} />}
          {activeTab === 'settings' && <SettingsView networkInfo={networkInfo} apiBase={api.base} />}
        </main>
      </div>
      {captureStatus && <CaptureOverlay status={captureStatus} onClose={() => setCaptureStatus(null)} />}
    </div>
  );
}

function LibraryView({ capsules, onSend, onDelete, onUpload, onCreate, onRename, onOpenRpp }) {
  const inputRef = useRef(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

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

  useEffect(() => () => audioRef.current?.pause(), []);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div><h1 className="text-2xl font-bold text-white">我的胶囊</h1><p className="text-slate-500 text-sm mt-1">本地已捕获 / 接收的胶囊（共 {capsules.length} 个）</p></div>
        <div className="flex items-center space-x-2">
          <input ref={inputRef} type="file" accept=".zip" className="hidden" onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ''; }} />
          <button onClick={() => inputRef.current?.click()} className="border border-slate-700 hover:bg-slate-800 text-slate-300 px-4 py-2 rounded-lg flex items-center space-x-2"><Upload size={16} /><span>导入胶囊</span></button>
          <button onClick={() => setShowCreateForm((v) => !v)} className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg flex items-center space-x-2 shadow-lg shadow-indigo-600/20"><Plus size={18} /><span>新捕获</span></button>
        </div>
      </div>

      {showCreateForm && <CreateCapsuleForm onCancel={() => setShowCreateForm(false)} onSubmit={async (data) => { await onCreate(data); setShowCreateForm(false); }} />}
      {capsules.length === 0 && !showCreateForm ? (
        <div className="border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center p-16 text-slate-500"><Package size={32} className="mb-3" /><p className="text-sm">暂无胶囊。可点右上角“新捕获”从 REAPER 捕获，或“导入胶囊”加载 .capsule.zip。</p></div>
      ) : (
        <div className="grid gap-3">
          {capsules.map((cap) => (
            <div key={cap.id} className="group bg-[#1a1d24] hover:bg-[#21252e] border border-slate-800 p-4 rounded-xl flex items-center transition-all">
              <button onClick={() => handlePlay(cap)} className={`w-10 h-10 rounded flex items-center justify-center mr-4 ${playingId === cap.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-indigo-400 hover:bg-indigo-600/20'}`}>{playingId === cap.id ? <Pause size={18} /> : <Play size={18} />}</button>
              <div className="flex-1 min-w-0">
                {editingId === cap.id ? (
                  <div className="flex items-center space-x-2"><input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(cap); if (e.key === 'Escape') setEditingId(null); }} className="flex-1 bg-[#0f1115] border border-indigo-500 rounded px-2 py-1 text-sm text-slate-200" /><button onClick={() => confirmRename(cap)} className="p-1 text-emerald-400"><Check size={16} /></button><button onClick={() => setEditingId(null)} className="p-1 text-slate-500"><X size={16} /></button></div>
                ) : <h3 className="font-medium text-slate-200 truncate cursor-pointer hover:text-indigo-300" onDoubleClick={() => startRename(cap)}>{cap.name}</h3>}
                <div className="text-xs text-slate-500 mt-1 flex space-x-3"><span>{formatDate(cap.created_at)}</span><span>{formatBytes(cap.size_bytes)}</span>{cap.source_peer && <span className="text-emerald-500/80">来自 {cap.source_peer}</span>}</div>
              </div>
              <button onClick={() => startRename(cap)} className="opacity-0 group-hover:opacity-100 mr-1 p-2 text-slate-500 hover:text-indigo-400"><Pencil size={15} /></button>
              <button onClick={() => onOpenRpp(cap)} className="opacity-0 group-hover:opacity-100 mr-1 p-2 text-slate-500 hover:text-amber-400"><FolderOpen size={16} /></button>
              <button onClick={() => onSend(cap)} className="opacity-0 group-hover:opacity-100 mr-1 p-2 bg-indigo-600/10 text-indigo-400 rounded-lg hover:bg-indigo-600 hover:text-white"><Send size={16} /></button>
              <button onClick={() => onDelete(cap)} className="opacity-0 group-hover:opacity-100 p-2 text-slate-500 hover:text-red-400"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      )}
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
          const online = contact.last_seen && Date.now() - new Date(`${contact.last_seen}Z`).getTime() < 5 * 60 * 1000;
          return <div key={contact.id} className="bg-[#1a1d24] border border-slate-800 p-5 rounded-2xl flex items-start justify-between group"><div className="flex items-center space-x-4"><div className="relative"><div className="w-12 h-12 bg-slate-700 rounded-full flex items-center justify-center text-xl font-bold text-slate-400 uppercase">{(contact.name || '?')[0]}</div>{online && <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-emerald-500 border-2 border-[#1a1d24] rounded-full" />}</div><div><h3 className="font-bold text-slate-200">{contact.name}</h3><p className="text-xs text-slate-500 font-mono mt-1">{contact.ip}:{contact.port}</p><p className={`text-[10px] mt-2 ${online ? 'text-emerald-500' : 'text-slate-600'}`}>{online ? '● 最近 5 分钟在线' : contact.last_seen ? `上次出现: ${formatDate(contact.last_seen)}` : '未探测'}</p></div></div><div className="flex flex-col space-y-2"><button onClick={() => onSend(contact)} className="p-2 bg-indigo-600 rounded-lg text-white hover:bg-indigo-500"><Zap size={16} fill="white" /></button><button onClick={() => onPing(contact)} className="p-2 text-slate-500 hover:text-slate-200"><RefreshCw size={16} /></button><button onClick={() => onDelete(contact)} className="p-2 text-slate-600 hover:text-red-400"><Trash2 size={16} /></button></div></div>;
        })}
        <div onClick={() => setShowAddForm(true)} className="border-2 border-dashed border-slate-800 rounded-2xl flex flex-col items-center justify-center p-6 text-slate-600 hover:border-slate-700 hover:text-slate-500 cursor-pointer"><Search size={24} className="mb-2" /><span className="text-sm font-medium">手动添加 IP</span></div>
      </div>
    </div>
  );
}

function AddContactForm({ onCancel, onSubmit }) {
  const [form, setForm] = useState({ name: '', ip: '', port: '5005', note: '' });
  return <div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-5 mb-6"><h3 className="text-sm font-bold text-slate-200 mb-4">添加联系人</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-3"><FormField label="名称"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></FormField><FormField label="IP"><input value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} /></FormField><FormField label="端口"><input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} /></FormField><FormField label="备注"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></FormField></div><div className="flex justify-end space-x-2 mt-5"><button onClick={onCancel} className="px-4 py-2 text-sm text-slate-400 hover:text-white">取消</button><button onClick={() => form.name && form.ip && onSubmit({ ...form, port: Number(form.port) || 5005 })} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg">保存</button></div></div>;
}

function FormField({ label, children }) {
  return <label className="block"><span className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">{label}</span>{React.cloneElement(children, { className: 'w-full bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500' })}</label>;
}

function TransferView({ capsules, contacts, selectedCapsules, setSelectedCapsules, targetContacts, setTargetContacts, tempPeer, setTempPeer, showTempPeerForm, setShowTempPeerForm, isSending, onSend }) {
  const toggleCapsule = (cap) => setSelectedCapsules((prev) => (prev.find((c) => c.id === cap.id) ? prev.filter((c) => c.id !== cap.id) : [...prev, cap]));
  const toggleTarget = (contact) => setTargetContacts((prev) => (prev.find((c) => c.id === contact.id) ? prev.filter((c) => c.id !== contact.id) : [...prev, contact]));
  const totalTasks = selectedCapsules.length * (targetContacts.length + (tempPeer.ip ? 1 : 0));

  return <div className="max-w-2xl mx-auto mt-6"><div className="bg-[#1a1d24] p-8 rounded-3xl border border-slate-800 shadow-2xl relative overflow-hidden"><h2 className="text-xl font-bold text-white mb-6 flex items-center"><Send size={20} className="mr-2 text-indigo-500" />发送胶囊</h2><div className="mb-8"><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">目标联系人</label><div className="grid grid-cols-2 gap-3">{contacts.map((c) => { const selected = targetContacts.find((tc) => tc.id === c.id); return <button key={c.id} onClick={() => toggleTarget(c)} className={`flex items-center space-x-3 bg-[#0f1115] p-3 rounded-xl border text-left ${selected ? 'border-indigo-500 bg-indigo-600/5' : 'border-slate-800 hover:border-indigo-500'}`}><div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs ${selected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}>{selected ? <Check size={14} /> : (c.name || '?')[0]}</div><div className="min-w-0"><div className="text-xs font-medium truncate">{c.name}</div><div className="text-[10px] text-slate-500 font-mono truncate">{c.ip}:{c.port}</div></div></button>; })}<button onClick={() => setShowTempPeerForm((v) => !v)} className="flex items-center justify-center space-x-2 bg-[#0f1115] p-3 rounded-xl border border-slate-800 hover:border-slate-700 text-slate-500"><Plus size={14} /><span className="text-xs">临时 IP</span></button></div>{showTempPeerForm && <div className="grid grid-cols-3 gap-3 mt-3"><input className="col-span-2 bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200" placeholder="对方 IP" value={tempPeer.ip} onChange={(e) => setTempPeer({ ...tempPeer, ip: e.target.value })} /><input className="bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200" placeholder="端口" value={tempPeer.port} onChange={(e) => setTempPeer({ ...tempPeer, port: e.target.value })} /></div>}</div><div className="mb-10"><label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">选择内容</label><div className="space-y-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">{capsules.length === 0 && <div className="text-xs text-slate-500 bg-[#0f1115] border border-slate-800 rounded-xl p-3">胶囊库为空。</div>}{capsules.map((cap) => { const selected = selectedCapsules.find((sc) => sc.id === cap.id); return <button key={cap.id} onClick={() => toggleCapsule(cap)} className={`w-full text-left bg-[#0f1115] p-3 rounded-xl border flex items-center justify-between ${selected ? 'border-indigo-500 bg-indigo-600/5' : 'border-slate-800 hover:border-indigo-500'}`}><div className="flex items-center space-x-3 min-w-0"><div className={`w-5 h-5 rounded flex items-center justify-center ${selected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-500'}`}>{selected ? <Check size={12} /> : null}</div><FileAudio className="text-indigo-400 shrink-0" size={16} /><span className="text-xs truncate">{cap.name}</span></div><span className="text-[10px] text-slate-500">{formatBytes(cap.size_bytes)}</span></button>; })}</div></div>{totalTasks > 0 && <div className="mb-4 text-xs text-slate-400 text-center">将发送 {selectedCapsules.length} 个胶囊 → {targetContacts.length + (tempPeer.ip ? 1 : 0)} 个目标（共 {totalTasks} 项任务）</div>}<button disabled={selectedCapsules.length === 0 || totalTasks === 0 || isSending} onClick={onSend} className={`w-full py-4 rounded-2xl font-bold flex items-center justify-center space-x-2 ${isSending || selectedCapsules.length === 0 || totalTasks === 0 ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30'}`}>{isSending ? <span>正在发射…</span> : <><Zap size={18} fill="currentColor" /><span>立即发送</span></>}</button>{isSending && <div className="absolute bottom-0 left-0 w-full bg-slate-800 h-1 overflow-hidden"><div className="bg-indigo-500 h-full w-1/3 animate-pulse" /></div>}</div></div>;
}

function SettingsView({ networkInfo, apiBase }) {
  const [settings, setSettings] = useState(null);
  const [reaperPath, setReaperPath] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [checkingBridge, setCheckingBridge] = useState(false);
  const [installingBridge, setInstallingBridge] = useState(false);
  const toast = useToast();

  const refreshBridgeStatus = useCallback(async () => {
    setCheckingBridge(true);
    try {
      const r = await api.getReaperBridgeStatus();
      setBridgeStatus(r.data);
    } catch (e) {
      setBridgeStatus({ webui_available: false, bridge_available: false, error: e.message });
    } finally {
      setCheckingBridge(false);
    }
  }, []);

  useEffect(() => {
    api.getSettings().then((r) => { setSettings(r.data); setReaperPath(r.data?.reaper_path || ''); }).catch(() => {});
    refreshBridgeStatus();
  }, [refreshBridgeStatus]);

  const handleSaveReaperPath = async () => {
    setSaving(true);
    try {
      const r = await api.updateSettings({ reaper_path: reaperPath });
      setSettings(r.data);
      toast.success('REAPER 路径已保存');
    } catch (e) {
      toast.error(`保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleInstallBridge = async () => {
    setInstallingBridge(true);
    try {
      const r = await api.installReaperBridge();
      toast.success(r.data?.message || 'Bridge 安装命令已发送');
      setTimeout(refreshBridgeStatus, 1000);
    } catch (e) {
      toast.error(`安装失败：${e.message}`);
    } finally {
      setInstallingBridge(false);
    }
  };

  const bridgeOk = bridgeStatus?.webui_available && bridgeStatus?.bridge_available;
  const bridgeLabel = bridgeOk ? `已连接 v${bridgeStatus.bridge_version || ''}` : bridgeStatus?.webui_available ? 'REAPER 已连接，Bridge 未运行' : 'REAPER Web Interface 未连接';

  return <div className="max-w-2xl mx-auto"><h1 className="text-2xl font-bold text-white mb-6">设置 / 信息</h1><div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6"><h3 className="text-sm font-bold text-slate-200 mb-4">REAPER Bridge</h3><div className={`rounded-xl border p-4 mb-4 ${bridgeOk ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-amber-500/10 border-amber-500/25'}`}><div className="flex items-center justify-between"><div className="flex items-center space-x-3"><Radio size={18} className={bridgeOk ? 'text-emerald-400' : 'text-amber-400'} /><div><div className="text-sm font-bold text-slate-200">{bridgeLabel}</div><div className="text-xs text-slate-500 mt-1">保存胶囊默认通过 Bridge 后台执行，不会主动切换到 REAPER。</div></div></div><button onClick={refreshBridgeStatus} disabled={checkingBridge} className="px-3 py-2 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg disabled:opacity-40">{checkingBridge ? '检测中…' : '重新检测'}</button></div>{bridgeStatus?.error && <div className="mt-3 text-xs text-amber-300 flex items-start space-x-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{bridgeStatus.error}</span></div>}</div><button onClick={handleInstallBridge} disabled={installingBridge} className="w-full px-4 py-3 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl disabled:opacity-40 flex items-center justify-center space-x-2"><DownloadCloud size={16} /><span>{installingBridge ? '正在安装…' : '安装 / 启动 REAPER Bridge'}</span></button><p className="text-xs text-slate-500 mt-3 leading-relaxed">首次使用：打开 REAPER，并启用 Web Interface（默认端口 9000），然后点击安装。安装后 bridge 会写入 REAPER 启动脚本，以后打开 REAPER 会自动运行。</p></div><div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 mb-6"><h3 className="text-sm font-bold text-slate-200 mb-4">REAPER 路径</h3><div className="flex items-center space-x-3"><input value={reaperPath} onChange={(e) => setReaperPath(e.target.value)} placeholder="例如：/Applications/REAPER.app 或留空自动检测" className="flex-1 bg-[#0f1115] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" /><button onClick={handleSaveReaperPath} disabled={saving} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-40">{saving ? '保存中…' : '保存'}</button></div><p className="text-xs text-slate-500 mt-2">macOS 填 .app 路径即可；Windows 填 reaper.exe 路径。</p></div><div className="bg-[#1a1d24] border border-slate-800 rounded-2xl p-6 space-y-3 text-sm"><Row k="API 地址" v={apiBase} /><Row k="主机名" v={networkInfo?.hostname} /><Row k="主 IP" v={networkInfo?.ip} /><Row k="监听端口" v={networkInfo?.port} /><Row k="所有 IP" v={(networkInfo?.all_ips || []).join('  ·  ')} /><Row k="共享密钥" v={networkInfo?.shared_token_required ? '已启用' : '未启用'} /></div><p className="text-xs text-slate-500 mt-4 leading-relaxed">提示：仅在你信任的局域网内运行。若启用了共享密钥，发送方需在请求头携带相同的 <code className="text-slate-300">X-Capsule-Token</code>。</p></div>;
}

function Row({ k, v }) {
  return <div className="flex justify-between border-b border-slate-800 pb-2"><span className="text-slate-500">{k}</span><span className="text-slate-200 font-mono text-right break-all">{v ?? '—'}</span></div>;
}

function CaptureOverlay({ status, onClose }) {
  const isWorking = status.phase === 'exporting';
  const isDone = status.phase === 'done';
  const isError = status.phase === 'error';
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"><div className="bg-[#1a1d24] border border-slate-700 rounded-3xl p-8 w-[380px] shadow-2xl text-center">{isWorking && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-indigo-600/20 flex items-center justify-center"><RefreshCw size={28} className="text-indigo-400 animate-spin" /></div><h3 className="text-lg font-bold text-white mb-2">正在捕获胶囊</h3><p className="text-sm text-slate-400 leading-relaxed whitespace-pre-line">{status.message}</p><div className="mt-5 h-1 bg-slate-800 rounded-full overflow-hidden"><div className="h-full w-2/3 bg-indigo-500 rounded-full animate-pulse" /></div></>}{isDone && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-emerald-600/20 flex items-center justify-center"><Zap size={28} className="text-emerald-400" fill="currentColor" /></div><h3 className="text-lg font-bold text-white mb-2">捕获完成</h3><p className="text-sm text-slate-400 whitespace-pre-line">{status.message}</p></>}{isError && <><div className="w-14 h-14 mx-auto mb-5 rounded-full bg-red-600/20 flex items-center justify-center"><FileAudio size={28} className="text-red-400" /></div><h3 className="text-lg font-bold text-white mb-2">捕获失败</h3><p className="text-sm text-red-300 leading-relaxed whitespace-pre-line">{status.message}</p><button onClick={onClose} className="mt-5 px-5 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-lg">关闭</button></>}</div></div>;
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
