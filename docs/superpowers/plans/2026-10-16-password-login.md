# SSH password login implementation plan

**Goal:** Enter NodeSeek credentials in SSH, perform any required human verification in a temporary browser, and monitor from the same server browser session.

**Architecture:** Add an explicit password login mode alongside compatible Cookie mode. A Chromium context uses an encrypted storage state; a temporary noVNC view is bound to server loopback only by the installer and reached through SSH. The daemon uses Chromium for password sessions so subsequent polling retains browser transport, user agent and server IP. No CAPTCHA solver, stealth patches or third-party credential services.

**Constraints:** Node 24; existing Telegram credentials, baseline and outbox survive upgrades; failed/cancelled login must not replace saved settings. Public configuration excludes passwords and browser storage. Verification may be needed again after expiry; never repeatedly submit a password in the daemon. No configuration website or default published port. The existing 1 GB server needs resource checks during live deployment.

- [x] Add failing tests for password wizard, rollback, session encryption and browser response classification.
- [x] Add Chromium session/desktop helpers, password configuration and explicit login command. Reuse the browser for inbox polling and close it cleanly.
- [x] Package Chromium/Xvfb/noVNC; add menu 11, loopback-only temporary verification mapping and stop/resume behavior. Update PTY tests and documentation.
- [x] Run Node tests, Linux PTY/container/browser smoke checks; inspect the final diff for secrets.
- [ ] Back up the actual installation, deploy without changing other services, and expose a temporary SSH tunnel for the user's human verification. Confirm real inbox/TG connectivity after login or report the remaining verification requirement accurately.
