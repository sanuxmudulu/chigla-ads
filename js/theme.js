import { loadTheme, saveTheme } from "./api.js";

const DEFAULT_THEME = "terminal";
const THEMES = ["terminal", "vice"];

export function initTheme(onChange) {
  const theme = THEMES.includes(loadTheme(DEFAULT_THEME)) ? loadTheme(DEFAULT_THEME) : DEFAULT_THEME;
  applyTheme(theme);

  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeChoice === theme);
    btn.addEventListener("click", () => {
      const next = btn.dataset.themeChoice;
      applyTheme(next);
      saveTheme(next);
      document.querySelectorAll("[data-theme-choice]").forEach((b) => b.classList.toggle("active", b === btn));
      if (onChange) onChange(next);
    });
  });

  return theme;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}
