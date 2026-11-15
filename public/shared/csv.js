// One CSV text boundary for browser downloads and Worker exports. Numbers stay numbers;
// untrusted text must not become a spreadsheet formula, even after leading whitespace.
export function csvCell(value, alwaysQuote = false) {
  let text = value == null ? "" : String(value);
  if (typeof value !== "number" && /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)) text = "'" + text;
  return alwaysQuote || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
