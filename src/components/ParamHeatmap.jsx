import { useI18n } from "../i18n/langStore";

function cellTone(value, min, max) {
  if (value == null || !Number.isFinite(value)) return "";
  if (max === min) return "heatmap-cell--mid";
  const t = (value - min) / (max - min);
  if (t >= 0.66) return "heatmap-cell--high";
  if (t >= 0.33) return "heatmap-cell--mid";
  return "heatmap-cell--low";
}

export default function ParamHeatmap({ heatmap, paramLabels }) {
  const { t } = useI18n();
  if (!heatmap?.matrix?.length) return null;

  const flat = heatmap.matrix.flat().filter((v) => Number.isFinite(v));
  const min = flat.length ? Math.min(...flat) : 0;
  const max = flat.length ? Math.max(...flat) : 1;
  const xLabel = paramLabels?.[heatmap.paramX] || heatmap.paramX;
  const yLabel = paramLabels?.[heatmap.paramY] || heatmap.paramY;

  return (
    <div className="glass-card chart-card">
      <div className="panel-header">
        <h2>{t("bt.heatmap.title")}</h2>
        <span className="panel-subtitle">{t("bt.heatmap.hint")}</span>
      </div>
      <div className="heatmap-wrap">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th>{yLabel} \ {xLabel}</th>
              {heatmap.xValues.map((x) => (
                <th key={x} className="num">{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heatmap.matrix.map((row, yi) => (
              <tr key={heatmap.yValues[yi]}>
                <th className="num">{heatmap.yValues[yi]}</th>
                {row.map((val, xi) => (
                  <td key={`${yi}-${xi}`} className={`heatmap-cell num ${cellTone(val, min, max)}`} title={val?.toFixed(3)}>
                    {val == null ? "—" : val.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
