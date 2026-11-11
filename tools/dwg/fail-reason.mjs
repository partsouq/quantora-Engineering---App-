// Why dwg2pdf.py stopped, for the admin (stored on the job, never printed to this public log unless
// DWG_DEBUG is set). A plain message the script gives on purpose is passed on as it is; for a crash only
// the error type and the script line are kept, never the error text (it can hold drawing content).
export function failReason(stderr) {
  const lines = String(stderr || "").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  const last = lines[lines.length - 1];
  const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt))\b/.exec(last);
  if (!m) return last.length <= 160 ? ": " + last : "";   // SystemExit("This DWG has no drawing content to read.")
  let at = "";
  for (const l of lines) { const f = /dwg2pdf\.py", line (\d+)/.exec(l); if (f) at = f[1]; }
  return ` (${m[1]}${at ? " at dwg2pdf.py:" + at : ""})`;
}
