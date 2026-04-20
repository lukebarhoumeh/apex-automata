export const fmt = (n: number, dec = 2): string =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });

export const fmtMoney = (n: number, dec = 2): string =>
  (n >= 0 ? "$" : "-$") + fmt(Math.abs(n), dec);

export const fmtSign = (n: number, dec = 2): string =>
  (n >= 0 ? "+" : "-") + fmt(Math.abs(n), dec);

export const fmtPct = (n: number, dec = 2): string =>
  (n >= 0 ? "+" : "") + n.toFixed(dec) + "%";

export const fmtCompact = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return fmt(n, 2);
};

export const fmtDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
};
