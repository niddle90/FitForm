import { type ReactNode, useState } from 'react';
import { Menu, Wrench, Cloud } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './ui/sheet';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { cn } from '@/lib/utils';

export type AppTab = 'studio' | 'vault';

interface NavItemDef {
  value: AppTab;
  label: string;
  icon: typeof Wrench;
}

const NAV_ITEMS: NavItemDef[] = [
  { value: 'studio', label: 'Studio', icon: Wrench },
  { value: 'vault', label: 'Vault', icon: Cloud },
];

function NavList({ tab, onSelect }: { tab: AppTab; onSelect: (t: AppTab) => void }) {
  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = tab === item.value;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onSelect(item.value)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-semibold transition-[transform,box-shadow]',
              active
                ? 'border-2 border-border bg-primary text-primary-foreground shadow-hard-sm'
                : 'border-2 border-transparent text-sidebar-foreground hover:bg-accent',
            )}
          >
            <Icon size={16} className="shrink-0" strokeWidth={2} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

/** Desktop tab switcher. Lives in the header from `md` up; below that the Sheet menu carries the same items. */
function HeaderNav({ tab, onSelect, className }: { tab: AppTab; onSelect: (t: AppTab) => void; className?: string }) {
  return (
    <nav
      aria-label="Primary"
      className={cn('hidden items-center gap-1 rounded-xl border-2 border-border bg-secondary/70 p-1 md:flex', className)}
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = tab === item.value;
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onSelect(item.value)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center gap-2 rounded-lg border-2 px-4 text-sm font-semibold transition-[transform,box-shadow,background-color]',
              active
                ? 'border-border bg-primary text-primary-foreground shadow-hard-sm'
                : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground',
            )}
          >
            <Icon size={15} className="shrink-0" strokeWidth={2} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

// Resolved against Vite's base so the logo also loads when the app is
// deployed under a subpath (e.g. https://user.github.io/FitForm/).
const LOGO_SRC = `${import.meta.env.BASE_URL}logo.svg`;

/** The FitForm logo and wordmark: the one place the brand name is set in the brand typeface. */
function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const md = size === 'md';
  return (
    <span className="flex items-center gap-2.5">
      <img
        src={LOGO_SRC}
        alt=""
        width={md ? 32 : 28}
        height={md ? 32 : 28}
        className={cn('shrink-0 rounded-full', md ? 'h-8 w-8 shadow-hard-sm' : 'h-7 w-7')}
      />
      <span className={cn('font-brand leading-none tracking-wide text-foreground', md ? 'text-[1.6rem]' : 'text-2xl')}>FitForm</span>
    </span>
  );
}

function Brand() {
  return (
    <div className="flex h-14 shrink-0 items-center border-b-2 border-border px-4">
      <Wordmark />
    </div>
  );
}

interface AppShellProps {
  tab: AppTab;
  onTabChange: (t: AppTab) => void;
  headerRight?: ReactNode;
  /** Legal links etc. Shown in the mobile menu and in the desktop page footer. */
  footer?: ReactNode;
  children: ReactNode;
}

export function AppShell({ tab, onTabChange, headerRight, footer, children }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="app-shell">
      {/* Mobile: a single Sheet owns both the trigger and the content, so
          there's exactly one source of truth for open/closed. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Brand />
          <div className="flex-1 overflow-y-auto py-3">
            <NavList
              tab={tab}
              onSelect={(t) => {
                onTabChange(t);
                setMobileOpen(false);
              }}
            />
          </div>
          {footer && (
            <>
              <Separator />
              <div className="p-3">{footer}</div>
            </>
          )}
        </SheetContent>

        {/* Main column */}
        <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 h-14 border-b-2 border-border bg-background/90 backdrop-blur-md md:h-16">
            <div className="mx-auto flex h-full w-full max-w-7xl items-center gap-2 px-3 sm:px-6 lg:px-8">
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                  <Menu size={18} />
                </Button>
              </SheetTrigger>
              <div className="md:hidden">
                <Wordmark size="sm" />
              </div>
              <div className="hidden md:block">
                <Wordmark />
              </div>
              <HeaderNav tab={tab} onSelect={onTabChange} className="md:ml-8" />
              <div className="ml-auto flex items-center gap-2">{headerRight}</div>
            </div>
          </header>

          <main className="flex-1">{children}</main>

          {/* Desktop footer: takes over the legal links the sidebar used to hold. */}
          <footer className="hidden border-t-2 border-border/20 md:block">
            <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
              <p className="text-xs text-muted-foreground">Photo and PDF tools that run in your browser.</p>
              {footer}
            </div>
          </footer>
        </div>
      </Sheet>
    </div>
  );
}
