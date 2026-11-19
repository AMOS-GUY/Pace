export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Accessible description, e.g. "Week of 3 Nov: 24.1 km". */
  description: string;
}

/** One x-axis label of a bar chart, positioned in pixels within the chart's width. */
export interface AxisLabel {
  index: number;
  left: number;
  width: number;
}

/**
 * Which bar labels fit, and where. Each bar's column is often narrower than its label (12 weeks
 * on a phone leave about 24 px for "21/09"), so instead of truncating every label to "2…" only
 * every `stride`-th label is shown, each given the width of the columns it stands for. The
 * latest bar (the highlighted one) is always labelled. `charWidth` is the estimated width of one
 * caption character at the current font scale.
 */
export function axisLabels(
  labels: readonly string[],
  chartWidth: number,
  gap: number,
  charWidth: number,
): AxisLabel[] {
  const n = labels.length;
  if (n === 0 || chartWidth <= 0) return [];
  const column = (chartWidth - gap * (n - 1)) / n;
  const pitch = column + gap;
  const needed = Math.max(...labels.map((l) => l.length)) * charWidth + 4;
  const stride = Math.max(1, Math.ceil(needed / pitch));
  const width = Math.min(chartWidth, stride * pitch - gap);
  const out: AxisLabel[] = [];
  for (let i = n - 1; i >= 0; i -= stride) {
    const centre = i * pitch + column / 2;
    const left = Math.min(Math.max(0, centre - width / 2), chartWidth - width);
    // Kept inside the chart, an edge label can shift into its neighbour: drop the neighbour.
    if (out.length > 0 && left + width > out[0]!.left) continue;
    out.unshift({ index: i, left, width });
  }
  return out;
}
