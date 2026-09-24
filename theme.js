  // theme: follow the system until the user picks one, then remember it
  const sysLight = matchMedia('(prefers-color-scheme: light)');
  function applyMode() {
    let saved = null; try { saved = localStorage.getItem('theme'); } catch {}
    if (saved !== 'light' && saved !== 'dark') saved = null;
    if (saved) document.documentElement.dataset.theme = saved; else delete document.documentElement.dataset.theme;
    document.documentElement.dataset.mode = saved || (sysLight.matches ? 'light' : 'dark');
  }
  function toggleMode() {
    const next = document.documentElement.dataset.mode === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', next); } catch {}
    applyMode();
  }
  sysLight.addEventListener('change', applyMode);
  applyMode();
  // look: 'brutal' (neo-brutalism, default), 'clay' (claymorphism) or 'soft'; remembered like the theme
  function applyStyle() {
    let v = null; try { v = localStorage.getItem('style'); } catch {}
    document.documentElement.dataset.style = v === 'soft' || v === 'clay' ? v : 'brutal';
  }
  function setStyle(v) { try { localStorage.setItem('style', v); } catch {} applyStyle(); }
  applyStyle();
