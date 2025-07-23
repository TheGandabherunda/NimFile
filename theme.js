// Theme initialization flag
let themeInitialized = false;

function initializeTheme() {
  if (themeInitialized) return;
  themeInitialized = true;

  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const root = document.documentElement;
  const THEME_KEY = 'theme';

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function getSavedTheme() {
    return localStorage.getItem(THEME_KEY);
  }

  function applyTheme(theme) {
    root.classList.remove('light-theme');
    themeToggleBtn?.classList.remove('light', 'dark');
    if (theme === 'light') {
      root.classList.add('light-theme');
      themeToggleBtn?.classList.add('light');
    } else {
      themeToggleBtn?.classList.add('dark');
    }
  }

  function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }

  function initTheme() {
    const saved = getSavedTheme();
    const theme = saved || getSystemTheme();
    applyTheme(theme);
    updateToggleUI(theme);
  }

  function updateToggleUI(theme) {
    if (themeToggleBtn) {
      if (theme === 'light') {
        themeToggleBtn.classList.add('light');
        themeToggleBtn.classList.remove('dark');
      } else {
        themeToggleBtn.classList.add('dark');
        themeToggleBtn.classList.remove('light');
      }
    }
  }

  // Initialize theme immediately
  initTheme();

  // Theme toggle event
  themeToggleBtn?.addEventListener('click', () => {
    const isDark = !root.classList.contains('light-theme');
    const newTheme = isDark ? 'light' : 'dark';
    setTheme(newTheme);
    updateToggleUI(newTheme);
  });

  // System theme change listener
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!getSavedTheme()) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initializeTheme);
// Also initialize immediately in case DOM is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initializeTheme();
} else {
  initializeTheme();
}
