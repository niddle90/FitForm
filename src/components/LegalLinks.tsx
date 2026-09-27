import { ExternalLink, Github } from 'lucide-react';
import { cn } from '@/lib/utils';

const BASE = import.meta.env.BASE_URL;

export const TERMS_URL = `${BASE}terms.html`;
export const PRIVACY_URL = `${BASE}privacy.html`;
export const GITHUB_URL = 'https://github.com/niddle90/fitform';

/**
 * The one place the app points at its Terms, Privacy, and source-code
 * links. This same component is what AppShell renders both at the bottom
 * of the mobile sidebar and in the desktop page footer (see its `footer`
 * prop), so adding a link here is enough to cover both places at once.
 *
 * They open in a new tab on purpose: the Google access token lives only in
 * this tab's memory (see drive/auth.ts), so navigating away in-place would
 * quietly sign the person out of their Vault.
 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={cn('legal-links', className)}>
      <a href={TERMS_URL} target="_blank" rel="noopener">
        Terms
        <ExternalLink size={10} aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <a href={PRIVACY_URL} target="_blank" rel="noopener">
        Privacy
        <ExternalLink size={10} aria-hidden="true" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <a href={GITHUB_URL} target="_blank" rel="noopener">
        <Github size={12} aria-hidden="true" />
        GitHub
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </nav>
  );
}
