// Text rendering. Kept separate from fetching so the MCP server can reuse it.

const LABEL_WIDTH = 32;
const BAR_WIDTH = 20;

const SEVERITY_NOTE = {
  normal: "",
  warning: "  <-- warning",
  critical: "  <-- critical",
};

export function bar(percent) {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(percent / (100 / BAR_WIDTH))));
  return `[${"#".repeat(filled)}${".".repeat(BAR_WIDTH - filled)}]`;
}

export function formatReset(value, now = Date.now()) {
  if (value == null) return null;
  const date = typeof value === "number"
    ? new Date(value < 1e12 ? value * 1000 : value)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const minutes = Math.round((date.getTime() - now) / 60000);
  let relative;
  if (minutes < 0) relative = "elapsed";
  else if (minutes < 60) relative = `in ${minutes}m`;
  else if (minutes < 2880) relative = `in ${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  else relative = `in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;

  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z (${relative})`;
}

/** One line per window, for humans. */
export function renderTable(usage, now = Date.now()) {
  const lines = [];
  if (!usage.windows.length) {
    lines.push("  No usage window reported.");
    return lines.join("\n");
  }

  for (const window of usage.windows) {
    const marker = window.active ? "* " : "  ";
    const note = SEVERITY_NOTE[window.severity] ?? "";
    lines.push(
      marker +
        window.label.padEnd(LABEL_WIDTH) +
        bar(window.percent) +
        ` ${String(Math.round(window.percent)).padStart(3)} %` +
        note
    );
    const reset = formatReset(window.resetsAt, now);
    if (reset) lines.push(" ".repeat(LABEL_WIDTH + 2) + `resets ${reset}`);
  }

  if (usage.extraUsage) {
    lines.push("");
    if (!usage.extraUsage.enabled) {
      lines.push("  Extra usage credits: disabled");
    } else {
      const percent = usage.extraUsage.percent == null ? "?" : `${usage.extraUsage.percent} %`;
      const cap = usage.extraUsage.monthlyLimit
        ? ` of ${usage.extraUsage.monthlyLimit} ${usage.extraUsage.currency ?? ""}`.trimEnd()
        : "";
      lines.push(`  Extra usage credits: enabled, ${percent} used${cap}`);
      if (usage.extraUsage.spendLimitReached) lines.push("  !! spend limit reached");
    }
  }

  if (usage.windows.some((w) => w.active)) {
    lines.push("");
    lines.push("  * = window currently being counted against");
  }
  return lines.join("\n");
}

/** Single line, for an agent checking headroom before a long task. */
export function renderShort(usage) {
  if (!usage.windows.length) return "no usage data";
  return usage.windows.map((w) => `${w.id}=${Math.round(w.percent)}%`).join("  ");
}

/** Highest window, useful for a one-glance verdict. */
export function peak(usage) {
  return usage.windows.reduce(
    (max, w) => (w.percent > (max?.percent ?? -1) ? w : max),
    null
  );
}
