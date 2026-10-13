# Security

Please report a vulnerability privately through GitHub's "Report a vulnerability" (Security tab → Advisories), not in a public issue.

In scope: the app's authentication (password + TOTP sessions, origin check), anything that could expose a vault file or `.env` value, the agent harness hooks (a bypass of `guard.py`), and the deploy scripts.

The app is built to run either on loopback with no login (`DEPLOYMENT=local`) or behind HTTPS with a login (`DEPLOYMENT=server`, which refuses to start without credentials). Exposing a `local` deployment to a network is a misconfiguration, not a vulnerability.
