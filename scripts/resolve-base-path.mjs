// Prints the VITE_BASE_PATH this repo should deploy under, so `npm run
// deploy` doesn't have to hardcode a repo name that can drift out of sync
// with vite.config.ts's own documented VITE_BASE_PATH convention (see the
// comment above `base:` there).
//
// Precedence:
//   1. VITE_BASE_PATH already set in the environment — respected as-is.
//      This is the documented override for anyone deploying somewhere
//      other than this project's own GitHub Pages project page (a fork
//      under a different repo name, a different hosting path, etc).
//   2. Derived from `git remote get-url origin`'s repo name, which is
//      what a GitHub Pages *project* page URL (https://user.github.io/repo/)
//      is actually keyed on — not package.json's "name" field, which
//      isn't guaranteed to match it (and doesn't, here: "fitform" vs this
//      repo's actual "FitForm").
//   3. A hardcoded fallback matching this repo's current, known name, used
//      only if git isn't available at all (e.g. building from a
//      downloaded zip rather than a clone) — the same value this script
//      replaces, so nothing regresses for the common case either way.
import { execSync } from 'node:child_process';

const FALLBACK = '/FitForm/';

function fromGitRemote() {
  try {
    const url = execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    // Matches the repo name out of both git@github.com:user/Repo.git and
    // https://github.com/user/Repo(.git)? — and non-GitHub remotes with
    // the same shape, on the assumption that whatever the origin's repo
    // name is, it's also the Pages project-page path.
    const m = url.match(/[/:]([^/]+?)(?:\.git)?$/);
    return m ? `/${m[1]}/` : null;
  } catch {
    return null;
  }
}

const resolved = process.env.VITE_BASE_PATH || fromGitRemote() || FALLBACK;
process.stdout.write(resolved);
