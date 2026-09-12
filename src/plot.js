import { Resvg } from "@resvg/resvg-js";
import { smooth } from "./analysis.js";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const label = (value) => Number(value.toPrecision(4)).toString();
const palette = [
  "#2563eb",
  "#e11d48",
  "#059669",
  "#9333ea",
  "#d97706",
  "#0891b2",
  "#475569",
  "#c026d3",
];

export function renderPlot(
  series,
  {
    key,
    axis = "_step",
    smoothing = 0,
    x_min,
    x_max,
    y_min,
    y_max,
    session_markers = true,
  },
) {
  if (
    (x_min !== undefined && x_max !== undefined && x_min >= x_max) ||
    (y_min !== undefined && y_max !== undefined && y_min >= y_max)
  )
    throw new Error("Plot minimum must be smaller than maximum.");
  const inView = series
    .flatMap((s) => s.points)
    .filter(
      ([x, y]) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        (x_min === undefined || x >= x_min) &&
        (x_max === undefined || x <= x_max),
    );
  if (!inView.length)
    throw new Error(
      "No finite points in this view. Widen the bounds or choose a metric with data.",
    );
  let xmin = x_min ?? Math.min(...inView.map((p) => p[0])),
    xmax = x_max ?? Math.max(...inView.map((p) => p[0]));
  let ymin = y_min ?? Math.min(...inView.map((p) => p[1])),
    ymax = y_max ?? Math.max(...inView.map((p) => p[1]));
  if (xmin > xmax || ymin > ymax)
    throw new Error(
      "Plot bounds exclude the data. Provide both bounds or widen the view.",
    );
  if (xmin === xmax) {
    xmin -= 0.5;
    xmax += 0.5;
  }
  if (ymin === ymax) {
    const pad = Math.abs(ymin) * 0.05 || 0.5;
    ymin -= pad;
    ymax += pad;
  }
  const left = 100,
    top = 80,
    width = 1120,
    height = 470,
    bottom = top + height;
  const px = (x) => left + ((x - xmin) / (xmax - xmin)) * width;
  const py = (y) => bottom - ((y - ymin) / (ymax - ymin)) * height;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${660 + series.length * 24}"><rect width="100%" height="100%" fill="#ffffff"/><style>text{font-family:Arial,sans-serif;fill:#172033;font-size:14px}</style><defs><clipPath id="view"><rect x="${left}" y="${top}" width="${width}" height="${height}"/></clipPath></defs><text x="${left}" y="32" style="font-size:23px;font-weight:bold">${escape(key.slice(0, 100))}</text><text x="${left}" y="57">${series.some((s) => s.sampled) ? "SAMPLED: min/max downsampling; export history for exact analysis" : "All server series points returned"} · EMA ${smoothing} · ${escape(axis)}</text>`,
  ];
  for (let i = 0; i <= 5; i++) {
    const x = left + (i * width) / 5,
      y = top + (i * height) / 5;
    parts.push(
      `<path d="M ${x} ${top} V ${bottom} M ${left} ${y} H ${left + width}" stroke="#e2e8f0"/><text x="${x}" y="${bottom + 26}" text-anchor="middle">${escape(label(xmin + (i * (xmax - xmin)) / 5))}</text><text x="${left - 10}" y="${y + 5}" text-anchor="end">${escape(label(ymax - (i * (ymax - ymin)) / 5))}</text>`,
    );
  }
  const path = (points) => {
    let drawing = false;
    return points
      .map(([x, y]) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          drawing = false;
          return "";
        }
        const command = drawing ? "L" : "M";
        drawing = true;
        return `${command}${px(x).toFixed(2)},${py(y).toFixed(2)}`;
      })
      .join(" ");
  };
  series.forEach((s, i) => {
    const color = palette[i % palette.length];
    parts.push('<g clip-path="url(#view)">');
    if (smoothing)
      parts.push(
        `<path d="${path(s.points)}" fill="none" stroke="${color}" stroke-opacity=".22" stroke-width="1"/>`,
      );
    const points = smooth(s.points, smoothing);
    parts.push(
      `<path d="${path(points)}" fill="none" stroke="${color}" stroke-width="2"/>`,
    );
    if (points.length <= 150)
      for (const [x, y] of points)
        if (Number.isFinite(x) && Number.isFinite(y))
          parts.push(
            `<circle cx="${px(x)}" cy="${py(y)}" r="2.5" fill="${color}"/>`,
          );
    if (session_markers && axis === "_step")
      for (const [j, session] of (s.sessions || []).entries())
        if (
          j > 0 &&
          Number.isFinite(session.first_step) &&
          session.first_step >= xmin &&
          session.first_step <= xmax
        )
          parts.push(
            `<path d="M ${px(session.first_step)} ${top} V ${bottom}" stroke="${color}" stroke-opacity=".4" stroke-dasharray="4 5"/><text x="${px(session.first_step) + 3}" y="${top + 16 + i * 16}" style="fill:${color};font-size:11px">S${j + 1}</text>`,
          );
    parts.push(
      `</g><rect x="${left}" y="${610 + i * 24}" width="22" height="4" fill="${color}"/><text x="${left + 32}" y="${617 + i * 24}">${escape(s.label.slice(0, 100))} (${s.points.length}/${s.total} points${s.sessions?.length ? `; ${s.sessions.length} sessions` : ""})</text>`,
    );
  });
  parts.push(
    `<text x="${left + width / 2}" y="${bottom + 52}" text-anchor="middle">${escape(axis)}</text></svg>`,
  );
  const svg = parts.join("");
  return {
    png: new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng(),
    bounds: { x_min: xmin, x_max: xmax, y_min: ymin, y_max: ymax },
  };
}
