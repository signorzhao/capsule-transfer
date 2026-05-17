import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((kind, message) => {
    const id = Math.random().toString(36).slice(2);
    setItems((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);
  const value = useMemo(() => ({
    info: (m) => push('info', m),
    success: (m) => push('success', m),
    error: (m) => push('error', m),
  }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 space-y-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-2 rounded-lg text-sm shadow-lg backdrop-blur-md border ${
              t.kind === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : t.kind === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-300'
                : 'bg-slate-700/40 border-slate-600/40 text-slate-200'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用');
  return ctx;
}
