// Runs synchronously in <head>, before React mounts, so the first paint already
// uses the right theme. Keep the storage keys and the palette formula in sync with
// src/app/config.ts and src/features/theme/theme.ts.
(function () {
  try {
    var pref = window.localStorage.getItem('rw.theme');
    if (pref !== 'light' && pref !== 'dark') pref = 'system';

    var legacyStyle = window.localStorage.getItem('rw.themeStyle');
    var rawLevel = window.localStorage.getItem('rw.themeLevel');
    var level = null;
    if (rawLevel !== null && rawLevel.trim() !== '') {
      var number = Number(rawLevel);
      if (isFinite(number)) level = Math.min(100, Math.max(0, Math.round(number)));
    }
    if (level === null) {
      if (legacyStyle === 'obsidian') level = 100;
      else if (legacyStyle === 'graphite') level = 36;
      else level = 100;
    }

    function hex(channel) {
      return Math.min(255, Math.max(0, channel)).toString(16).padStart(2, '0');
    }
    function shade(offset) {
      var channel = hex(Math.round(36 * (1 - level / 100)) + offset);
      return '#' + channel + channel + channel;
    }

    var dark =
      pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePref = pref;
    root.dataset.themeStyle = level >= 100 ? 'obsidian' : 'graphite';
    root.dataset.darkLevel = String(level);
    root.style.setProperty('--dark-level', String(level));
    root.style.setProperty('--dark-app', shade(0));
    root.style.setProperty('--dark-sidebar', shade(8));
    root.style.setProperty('--dark-panel', shade(13));
    root.style.setProperty('--dark-elevated', shade(24));
    root.style.setProperty('--dark-border', shade(38));
    root.style.setProperty('--dark-hairline', shade(26));
  } catch {
    // Storage can be blocked; the defaults on <html> still apply.
  }
})();
