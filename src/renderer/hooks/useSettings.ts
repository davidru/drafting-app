import { useCallback, useEffect, useState } from 'react';
import { AppSettings, DEFAULT_SETTINGS } from '../../shared/types';

export type ResolvedTheme = 'dark' | 'light';

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Settings live in the main process. This hook mirrors them, pushes patches
 * back, and keeps `document.documentElement[data-theme]` in step so CSS, Monaco
 * and xterm all agree on the theme. The main process sets nativeTheme from the
 * same setting, so `prefers-color-scheme` here already reflects it.
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState<ResolvedTheme>(readSystemTheme);

  useEffect(() => {
    let cancelled = false;
    window.drafting.getSettings().then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoaded(true);
    });
    const off = window.drafting.onSettingsChanged((s) => setSettings(s));
    return () => { cancelled = true; off(); };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setTheme(mq.matches ? 'dark' : 'light');
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const update = useCallback(async (patch: unknown) => {
    const next = await window.drafting.updateSettings(patch);
    setSettings(next);
    return next;
  }, []);

  return { settings, loaded, theme, update };
}
