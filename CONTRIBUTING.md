# Contributing

Thanks for helping. Small, focused changes are the easiest to review and merge.

## Setup

No build step, no dependencies. It's plain HTML, CSS and JavaScript.

1. Fork and clone the repo.
2. Load it: `chrome://extensions` → Developer mode → **Load unpacked** → the repo folder.
3. After a change, click ↻ on Tabboard and open a new tab.

For quicker UI work, open `test/index.html` directly in Chrome and paste a GitHub token. It runs the same code without reloading the extension. (Sign in with GitHub only works in the installed extension.)

## Where things live

| File | What's in it |
|:---|:---|
| `newtab.html` | Markup and all CSS, including the three looks |
| `app.js` | Loading from GitHub, rendering, settings, sign-in, everything else |
| `theme.js` | Light/dark, look, and the Tabboard/Chrome switch, applied before the page draws |
| `background.js` | Toolbar icon and `Alt+Shift+T` |
| `test/index.html` | Generated copy of `newtab.html` for the test page |

## Rules that matter

- **Changed `newtab.html`?** Regenerate the test page:
  ```sh
  sed -e 's#<script src="theme.js"></script>#<script src="../theme.js"></script>#' \
      -e 's#<script src="app.js"></script>#<script src="../app.js"></script>#' newtab.html > test/index.html
  ```
- **Changed what `fetchAll` returns?** Bump `DATA_VERSION` in `app.js`, so saved data in the old shape gets refetched instead of shown.
- **Check all three looks** (Settings → General → Look) in light and dark before sending UI changes.
- **No new dependencies or build tools.** No new permissions or network hosts without explaining why in the PR.
- **Never commit a token or real task data.** Use sample data in screenshots.
- Match the surrounding code: small functions, a comment only where the *why* isn't obvious.

## Sending a change

1. Open an issue first for anything bigger than a bug fix, so we agree on the approach.
2. Branch from `main`, keep the PR to one change, and fill in the PR checklist.
3. Add a line to `CHANGELOG.md` under **Unreleased**.
