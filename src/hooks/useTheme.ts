import { useEffect, useState } from 'react';

/**
 * Always follows the OS/browser color-scheme preference — no manual
 * light/dark override, no persisted choice. Simpler for a small utility
 * app, and it means the UI never disagrees with the rest of the person's
 * system. index.html's inline script applies the same logic before first
 * paint so there's no flash; this hook just keeps it in sync afterwards.
 */
function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function apply(resolved: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', resolved);
}

export function useTheme() {
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => (systemPrefersDark() ? 'dark' : 'light'));

  useEffect(() => {
    apply(resolved);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [resolved]);

  return { resolved };
}
