import { useState } from "react";
import { downloadJson, exportPdf, getSavedReports, reportFilename, saveReport } from "../lib/reports";
import { useI18n } from "../i18n/langStore";

export default function ReportActions({ report, type, symbol }) {
  const { t } = useI18n();
  const [savedCount, setSavedCount] = useState(() => getSavedReports().length);
  if (!report) return null;

  function handleSave() {
    try {
      const list = saveReport(report);
      setSavedCount(list.length);
    } catch {
      downloadJson(report, reportFilename(type, symbol));
    }
  }

  return (
    <div className="report-actions glass-card no-print">
      <div>
        <strong>{t("report.title")}</strong>
        <span>{t("report.saved", { n: savedCount })}</span>
      </div>
      <button type="button" className="ghost-btn" onClick={() => exportPdf()}>
        {t("report.pdf")}
      </button>
      <button type="button" className="ghost-btn" onClick={() => downloadJson(report, reportFilename(type, symbol))}>
        {t("report.json")}
      </button>
      <button type="button" className="run-btn report-actions__save" onClick={handleSave}>
        {t("report.save")}
      </button>
    </div>
  );
}
