export function costOf(model, usage, costTable = {}) {
  const rate = costTable[model] || { in: 0, out: 0 };
  const usd = ((usage.input || 0) / 1e6) * rate.in + ((usage.output || 0) / 1e6) * rate.out;
  return Math.round(usd * 1e6) / 1e6; // micro-dollar precision
}

export function fmtUsd(usd) {
  if (usd == null) return '—';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n || 0);
}
