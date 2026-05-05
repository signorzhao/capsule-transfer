import React from 'react';

export default function NavIcon({ icon, active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={`p-3 rounded-xl transition-all flex flex-col items-center group relative ${
        active
          ? 'bg-indigo-600/10 text-indigo-500'
          : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
      }`}
    >
      {icon}
      {label && <span className="text-[10px] mt-1 font-medium">{label}</span>}
      {!active && label && (
        <div className="absolute left-16 bg-slate-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap z-50">
          {label}
        </div>
      )}
    </button>
  );
}
