/**
 * Color sets for the app. Each has a light and a dark version (the phone's own
 * light/dark setting picks which), plus the two map pin colors that follow the theme.
 * The chosen set is remembered per phone; "evergreen" is the default.
 *
 * Token names match the CSS variables in index.html (--bg, --accent, …).
 */
(function (root) {
  const THEME_KEY = "nearbyeats.theme";

  const THEMES = {
    evergreen: {
      name: "Evergreen",
      blurb: "The current look: deep green on warm paper.",
      light: { bg: "#f6f4ef", card: "#ffffff", text: "#1d1d1b", muted: "#6b6b66", accent: "#1f6f5c", "accent-text": "#ffffff",
        error: "#b3261e", border: "#e2dfd7", chip: "#ece9e1", star: "#8a5a00", "star-bg": "#fbefd5", fav: "#1f6f5c", "fav-bg": "#dcefe7", warn: "#8a4b00" },
      dark: { bg: "#151714", card: "#1f221e", text: "#ecebe6", muted: "#a3a39c", accent: "#4fb89c", "accent-text": "#0e1a16",
        error: "#f2b8b5", border: "#33372f", chip: "#2c302a", star: "#f3c96b", "star-bg": "#3a3020", fav: "#7fd3b8", "fav-bg": "#1d3a31", warn: "#f3c96b" },
      pins: { open: "#1f6f5c", you: "#2b6fd6" },
    },
    harbor: {
      name: "Harbor",
      blurb: "Cool blue on a pale grey-blue, like a transit map.",
      light: { bg: "#f2f5f9", card: "#ffffff", text: "#17202b", muted: "#5d6875", accent: "#1f5fa8", "accent-text": "#ffffff",
        error: "#b3261e", border: "#dbe2ea", chip: "#e6ecf3", star: "#8a5a00", "star-bg": "#fbefd5", fav: "#1f5fa8", "fav-bg": "#dce8f7", warn: "#8a4b00" },
      dark: { bg: "#11161c", card: "#1a2129", text: "#e8edf2", muted: "#9aa6b2", accent: "#6aa9ee", "accent-text": "#0b1a2b",
        error: "#f2b8b5", border: "#2b3540", chip: "#252e38", star: "#f3c96b", "star-bg": "#3a3020", fav: "#8fc0f5", "fav-bg": "#1b2f47", warn: "#f3c96b" },
      pins: { open: "#1f5fa8", you: "#d6336c" },
    },
    terracotta: {
      name: "Terracotta",
      blurb: "Warm clay on cream; the most restaurant-menu of the set.",
      light: { bg: "#faf5ee", card: "#fffdf9", text: "#2a1f1a", muted: "#75655b", accent: "#b4532a", "accent-text": "#ffffff",
        error: "#a3261e", border: "#eadfd2", chip: "#f1e7da", star: "#8a5a00", "star-bg": "#fbefd5", fav: "#9a4521", "fav-bg": "#f6e1d5", warn: "#8a4b00" },
      dark: { bg: "#1a1512", card: "#241d19", text: "#f0e8e1", muted: "#b3a497", accent: "#e8926a", "accent-text": "#2a1208",
        error: "#f2b8b5", border: "#3a2f28", chip: "#30261f", star: "#f3c96b", "star-bg": "#3a3020", fav: "#f0a988", "fav-bg": "#45281a", warn: "#f3c96b" },
      pins: { open: "#b4532a", you: "#2b6fd6" },
    },
    plum: {
      name: "Plum",
      blurb: "A deep grape tone on a soft lilac-grey.",
      light: { bg: "#f6f3f9", card: "#ffffff", text: "#201a29", muted: "#6a6177", accent: "#6b3fa0", "accent-text": "#ffffff",
        error: "#b3261e", border: "#e3dcec", chip: "#ece6f3", star: "#8a5a00", "star-bg": "#fbefd5", fav: "#6b3fa0", "fav-bg": "#eadff6", warn: "#8a4b00" },
      dark: { bg: "#15121a", card: "#1f1a27", text: "#ece7f2", muted: "#a69db3", accent: "#b99be6", "accent-text": "#1e0f33",
        error: "#f2b8b5", border: "#332b40", chip: "#2a2335", star: "#f3c96b", "star-bg": "#3a3020", fav: "#cdb5ef", "fav-bg": "#33234d", warn: "#f3c96b" },
      pins: { open: "#6b3fa0", you: "#2b6fd6" },
    },
    graphite: {
      name: "Graphite",
      blurb: "Neutral charcoal and white; color is saved for the warnings and deals.",
      light: { bg: "#f4f4f2", card: "#ffffff", text: "#1a1a19", muted: "#666663", accent: "#2f2f2c", "accent-text": "#ffffff",
        error: "#b3261e", border: "#deded9", chip: "#eaeae6", star: "#8a5a00", "star-bg": "#fbefd5", fav: "#2f6f4f", "fav-bg": "#e0efe6", warn: "#8a4b00" },
      dark: { bg: "#121212", card: "#1c1c1b", text: "#ededea", muted: "#a2a29d", accent: "#e4e4df", "accent-text": "#161615",
        error: "#f2b8b5", border: "#30302d", chip: "#282826", star: "#f3c96b", "star-bg": "#3a3020", fav: "#8fd3ad", "fav-bg": "#1d3a2b", warn: "#f3c96b" },
      pins: { open: "#3a3a36", you: "#2b6fd6" },
    },
  };

  const vars = (tokens) => Object.entries(tokens).map(([k, v]) => `--${k}:${v};`).join("");

  /** CSS that switches the whole page to a theme, light and dark. */
  function themeCSS(t) {
    return `:root{${vars(t.light)}}@media (prefers-color-scheme: dark){:root{${vars(t.dark)}}}`;
  }

  function savedThemeId() {
    try { const id = localStorage.getItem(THEME_KEY); return THEMES[id] ? id : "evergreen"; } catch { return "evergreen"; }
  }

  function saveThemeId(id) {
    try { localStorage.setItem(THEME_KEY, id); } catch {}
  }

  /** Applies a theme to this page and returns it. */
  function applyTheme(id) {
    const theme = THEMES[id] || THEMES.evergreen;
    let style = document.getElementById("theme");
    if (!style) {
      style = document.createElement("style");
      style.id = "theme";
      document.head.append(style);
    }
    style.textContent = themeCSS(theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme.light.accent;
    return theme;
  }

  root.Themes = { THEMES, vars, applyTheme, savedThemeId, saveThemeId };
})(window);
