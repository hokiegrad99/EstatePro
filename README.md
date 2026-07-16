# EstatePro

A Firebase-backed estate-management SPA for managing a decedent's records:
assets, debts, cashflow, heirs, distributions, tasks, and a document
checklist. Multi-page reload design (each HTML page is a full navigation),
vanilla JS, no build step, no bundler, no TypeScript.

## Prerequisites

- A Firebase project with Cloud Firestore + Email/Password auth enabled.
- Node.js only if you want to regenerate the founder secret (optional).
- A modern browser (Chrome / Firefox / Safari / Edge — anything from 2022+).

## Quickstart

1. `git clone <this-repo>` and `cd EstatePro`.
2. Create a Firebase project and copy the Web SDK config into `js/firebase-config.js`.
3. Generate a founder secret, hash it, paste the SHA-256 into `firestore.rules`, then deploy.
4. `firebase deploy` (or `firebase deploy --only firestore,hosting` for a narrow release).
5. Open `https://<your-project>.web.app/index.html`, register, then visit `/bootstrap.html`.

For the full walkthrough — deploy modes, founder-secret generation, CSP / HSTS
explanations, troubleshooting — see [FIREBASE-SETUP.md](FIREBASE-SETUP.md).

## Tech stack

- **Frontend**: vanilla JS (no framework, no bundler), single 4,000-line `js/app.js`,
  12 HTML pages, 1 CSS file. Each page reloads fully; the App namespace is
  re-initialized per navigation.
- **Backend**: Firebase Hosting (static files) + Cloud Firestore (estate data) +
  Firebase Auth (email/password).
- **Crypto**: client-side AES-GCM-256 with PBKDF2-derived key (100k iterations);
  passphrase kept in sessionStorage, encrypted blob in localStorage.
- **Build / lint / test**: none. This is a single-developer project by design.

## Project layout

```
firebase.json             # Hosting + Firestore config + security headers
firestore.rules           # Phase 1-9 hardening (executor/admin/invite rules)
firestore.indexes.json    # Composite indexes
FIREBASE-SETUP.md         # Setup + deploy + troubleshooting guide
js/firebase-config.js     # Per-project Web SDK config (apiKey, projectId, ...)
js/firebase-bridge.js     # Initializes Firebase, exposes App.Firebase.{app,auth,db}
js/app.js                 # App namespace: Auth, Data, UI, Crypto, Permissions, ...
index.html                # Login / register landing page
bootstrap.html            # One-time founder-estate creation form
dashboard.html + 8 estate pages  # The data-entry UIs
```

See [FIREBASE-SETUP.md](FIREBASE-SETUP.md) section 9 ("Related files") for
per-file responsibilities.
