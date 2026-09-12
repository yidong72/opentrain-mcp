export const STATE_CAVEAT =
  "Dashboard state is not scheduler/job health. Open Train may label a running record crashed after heartbeat inactivity; offline or disconnected training can still be healthy.";

export function sessions(run) {
  const imported = run.config?.tensorboard_import?.sessions;
  return Array.isArray(imported) ? imported : [];
}

export function summarizeSeries(series, goal = "observe") {
  const provenance = {
    axis: series.axis,
    missing_axis: series.missing_axis || 0,
    legacy_projection_points: series.legacy_projection_points || 0,
    axis_warning: series.axis_warning,
  };
  const points = series.points.filter(
    ([x, y]) => Number.isFinite(x) && Number.isFinite(y),
  );
  if (!points.length)
    return {
      ...provenance,
      total: series.total,
      sampled: series.sampled,
      observed_points: 0,
      warning:
        "No finite numeric points. Missing data is not proof of a failed job.",
    };
  const values = points.map((p) => p[1]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
  );
  const windowSize = Math.min(
    values.length,
    Math.max(3, Math.ceil(values.length * 0.1)),
  );
  const recent = values.slice(-windowSize);
  const previous = values.slice(-2 * windowSize, -windowSize);
  const average = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const recentMean = average(recent);
  const delta = previous.length ? recentMean - average(previous) : null;
  const median = (a) => {
    const s = [...a].sort((a, b) => a - b);
    return s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const changes = values.slice(1).map((v, i) => v - values[i]);
  const center = changes.length ? median(changes) : 0;
  const mad = changes.length
    ? median(changes.map((v) => Math.abs(v - center)))
    : 0;
  const jumps =
    mad > 0 && changes.length >= 10
      ? changes
          .map((value, i) => ({
            x: points[i + 1][0],
            from: values[i],
            to: values[i + 1],
            deviation_mad: Math.abs(value - center) / mad,
          }))
          .filter((p) => p.deviation_mad > 8)
          .sort((a, b) => b.deviation_mad - a.deviation_mad)
          .slice(0, 5)
      : [];
  let min = points[0],
    max = points[0];
  for (const p of points) {
    if (p[1] < min[1]) min = p;
    if (p[1] > max[1]) max = p;
  }
  return {
    ...provenance,
    total: series.total,
    sampled: !!series.sampled,
    observed_points: points.length,
    null_or_invalid_points: series.points.length - points.length,
    first: points[0],
    last: points.at(-1),
    minimum: min,
    maximum: max,
    mean,
    std,
    recent: {
      window_points: windowSize,
      mean: recentMean,
      mean_change_from_previous_window: delta,
      direction:
        delta === null
          ? "insufficient_data"
          : delta > 0
            ? "increasing"
            : delta < 0
              ? "decreasing"
              : "flat",
      goal,
      favorable_change:
        goal === "observe" || delta === null
          ? null
          : goal === "minimize"
            ? delta < 0
            : delta > 0,
    },
    unusual_adjacent_changes: jumps,
    caveat: series.sampled
      ? "Statistics describe min/max-downsampled observations, not the full history. Means, variability, and jump heuristics can be biased by sampling; export raw history to verify."
      : "Descriptive statistics only. Adjacent jumps (>8 MAD, if MAD>0) are leads, not diagnoses. No convergence or causality claim.",
  };
}

export function smooth(points, weight) {
  let previous;
  return points.map(([x, y]) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      previous = undefined;
      return [x, null];
    }
    previous =
      previous === undefined ? y : weight * previous + (1 - weight) * y;
    return [x, previous];
  });
}
