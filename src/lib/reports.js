const REPORTS_KEY = "lensa.savedReports";

export function downloadJson(report, filename) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function saveReport(report) {
  const list = getSavedReports();
  const next = [{ ...report, savedAt: new Date().toISOString() }, ...list].slice(0, 20);
  window.localStorage.setItem(REPORTS_KEY, JSON.stringify(next));
  return next;
}

export function getSavedReports() {
  try {
    return JSON.parse(window.localStorage.getItem(REPORTS_KEY) || "[]");
  } catch {
    return [];
  }
}

export function exportPdf() {
  document.documentElement.classList.add("print-export");
  const cleanup = () => {
    document.documentElement.classList.remove("print-export");
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

export function reportFilename(type, symbol) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `lensa-${type}-${symbol}-${stamp}.json`;
}
