# Security

Tabboard holds GitHub tokens, so security reports matter.

## Reporting

Please **don't open a public issue**. Report privately through GitHub: **Security** tab → **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact. You'll get a reply within a few days, and credit in the fix if you'd like.

## In scope

- Anything that exposes a user's token, or lets a web page or another extension read it
- Script injection through GitHub data (issue titles, labels, repo names) or news content
- Sign-in flow problems, or requests to hosts not listed in the README

## Good to know

Tokens are stored unencrypted in the extension's own storage. Anyone with access to the user's computer account can read them, and that's out of scope.
