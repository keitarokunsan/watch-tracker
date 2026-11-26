/* Synchronous external FOUC-prevention script (MV3 CSP-safe; no inline script) */
try {
  const saved = localStorage.getItem("color-scheme");
  if (saved === "light" || saved === "dark") {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = saved;
  }
} catch (_) {}
