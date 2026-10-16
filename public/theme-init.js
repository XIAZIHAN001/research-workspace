// Runs synchronously in <head>, before React mounts, so the first paint already
// uses the right theme. Keep the storage key in sync with src/app/config.ts.
(function () {
  try {
    var pref = window.localStorage.getItem('rw.theme');
    if (pref !== 'light' && pref !== 'dark') pref = 'system';
    var dark =
      pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePref = pref;
  } catch {
    // Storage can be blocked; the defaults on <html> still apply.
  }
})();
