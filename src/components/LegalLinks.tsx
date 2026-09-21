import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

const BASE = import.meta.env.BASE_URL;

export const TERMS_URL = `${BASE}terms.html`;
export const PRIVACY_URL = `${BASE}privacy.html`;

/**
 * The one place the app points at its Terms and Privacy pages.
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
    </nav>
  );
}
