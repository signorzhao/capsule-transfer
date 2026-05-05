/**
 * Tauri 原生能力桥接层
 * 在浏览器环境下降级为 Web API / no-op
 */

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

export async function notifyNewCapsule(sender) {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify_new_capsule", { sender });
  } else if ("Notification" in window && Notification.permission === "granted") {
    new Notification("收到新胶囊", { body: `来自 ${sender}` });
  }
}

export async function flashTaskbar() {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("flash_taskbar");
  }
}

export function getIsTauri() {
  return isTauri();
}
