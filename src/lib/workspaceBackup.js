const PREFIX = "lensa.";

export function exportWorkspace() {
  const data = { schemaVersion: 1, exportedAt: new Date().toISOString(), entries: {} };
  if (typeof localStorage === "undefined") return data;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) {
      try {
        data.entries[key] = JSON.parse(localStorage.getItem(key));
      } catch {
        data.entries[key] = localStorage.getItem(key);
      }
    }
  }
  return data;
}

export function downloadWorkspaceBackup() {
  const data = exportWorkspace();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lensa-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importWorkspaceBackup(json, { merge = false } = {}) {
  if (!json?.entries || typeof json.entries !== "object") throw new Error("invalid_backup");
  if (typeof localStorage === "undefined") throw new Error("no_storage");
  if (!merge) {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  }
  for (const [key, value] of Object.entries(json.entries)) {
    if (!key.startsWith(PREFIX)) continue;
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return Object.keys(json.entries).length;
}
