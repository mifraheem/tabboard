# Tabboard

Your GitHub Projects tasks, pull requests, notes and tech news on every new Chrome tab.

Tabboard replaces Chrome's new tab page with a dashboard of the work assigned to you across GitHub Projects boards, plus the repos you care about. It opens instantly from a local cache and refreshes in the background.

## What it shows

- **Your tasks by status.** To do, In progress, Review, Blocked, Backlog and Done, grouped by board. Hover a task for its details, copy them with `C`, or open the issue with `O`.
- **Several organizations at once.** Pick one or more orgs (and your own projects) in Settings.
- **Repos without a board.** Issues assigned to you that aren't on any board show up in repo cards. Add a repo to see all of its issues, with board statuses where they exist.
- **Pull requests.** Review requests, mentions and open PRs on your projects, with check status.
- **Standup.** A ready-to-paste update for any range: since the last workday, this week, this month or custom dates.
- **Notes.** Private to-dos with due dates, kept in your browser only.
- **Project links.** Save environment links (production, staging, and so on) per project, with site icons.
- **World clocks.** Your local time plus teammates' timezones, with working-hours dots. Search zones by city, abbreviation (PKT, EST) or offset (UTC+5).
- **Tech news and trending.** Hacker News, Simon Willison's blog, trending GitHub repos and Hugging Face models, filtered by the topics you pick.
- **Three looks.** Brutal (neo-brutalism, the default), Clay (claymorphism) and Soft, each in light and dark.

## Install

Tabboard isn't on the Chrome Web Store yet. To install it from source:

1. Download or clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repo folder.
4. Open a new tab and click **Sign in with GitHub**.

Chrome only replaces the new tab page in the profile where the extension is installed.

**Want Chrome's normal new tab sometimes?** Click the ⇄ button in Tabboard's top bar. New tabs then open Chrome's own page until you click Tabboard's toolbar icon or press **Alt+Shift+T** to switch back. The icon shows an "off" badge while Chrome's page is in use. Pin the icon (puzzle-piece menu → pin) for one-click switching.

## Signing in

**Sign in with GitHub** uses GitHub's OAuth device flow. You get a short code, enter it on github.com and approve. There's no server involved: the token goes from GitHub straight to your browser.

You can also paste a **personal access token** instead (classic, with `repo`, `read:project` and `read:org`). A fine-grained, read-only token works too if your org allows it.

You can connect several GitHub accounts and switch between them from the avatar menu.

## Privacy

- Tokens, notes, settings and cached data are stored in the extension's own storage in your browser. They are not encrypted, and nothing is sent anywhere else.
- Tabboard only talks to `api.github.com`, `github.com/login` (sign-in), and the news sources you enable: `hn.algolia.com`, `simonwillison.net` and `huggingface.co`.
- To remove Tabboard's access, sign out and revoke it in GitHub → Settings → Applications.

## Board setup

Tabboard reads a board's **Status** field for columns and a **Target date** field for due dates. If your boards name these differently, change the names in Settings → Board field names.

## Development

It's plain HTML, CSS and JavaScript with no build step.

| File | What it is |
|:---|:---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `newtab.html` | Page markup and all styles, including the three looks |
| `app.js` | Everything else: GitHub loading, rendering, settings, sign-in |
| `theme.js` | Applies light/dark and the look before the page draws, and hands off to Chrome's new tab when that mode is on |
| `background.js` | The toolbar icon and Alt+Shift+T: switches new tabs between Tabboard and Chrome |
| `test/index.html` | The same page as a plain file, for trying changes without reloading the extension |

To try changes quickly, open `test/index.html` in Chrome and paste a token (sign-in with GitHub only works in the installed extension). After editing `newtab.html`, regenerate the test page:

```sh
sed -e 's#<script src="theme.js"></script>#<script src="../theme.js"></script>#' \
    -e 's#<script src="app.js"></script>#<script src="../app.js"></script>#' newtab.html > test/index.html
```

### Using your own OAuth app

If you fork Tabboard, register your own GitHub OAuth App (Settings → Developer settings → OAuth Apps), tick **Enable Device Flow**, and set `GITHUB_CLIENT_ID` in `app.js` to its Client ID. Don't create a client secret; the device flow doesn't use one.

## License

[MIT](LICENSE)
