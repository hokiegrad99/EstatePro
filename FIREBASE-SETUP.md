# EstatePro — Firebase Setup Guide

This document is the canonical setup + deployment guide for EstatePro. It is
referenced by `js/firebase-config.js`, `js/firebase-bridge.js`, `index.html`,
`firestore.rules`, and `bootstrap.html`. If you arrived here from one of
those source-file comments, jump to the matching section below.

If `index.html` shows a red **"Firebase is not configured"** banner after
you open the login page, this file explains every reason that banner can
appear and how to fix each one.

---

## 1. One-time setup (first deploy)

Run these once before any user can sign in:

1. **Create a Firebase project.** Firebase Console -> Add project. Note the
   `projectId` (you'll need it for `js/firebase-config.js`).
2. **Enable Email/Password sign-in.** Build -> Authentication -> Sign-in
   method -> Email/Password -> Enable.
3. **Enable Cloud Firestore.** Build -> Firestore Database -> Create database.
   Pick a region close to your users. The `firebase.json` shipped here
   pins `nam5` (US-central); change it if you deploy elsewhere.
4. **Register a Web app.** Project settings -> General -> Your apps -> Web
   app icon. Copy the `firebaseConfig` block — that's what you'll paste
   into `js/firebase-config.js`.
5. **Fill in `js/firebase-config.js`.** Replace every field in
   `window.__FIREBASE_CONFIG__` with the values from step 4. The `apiKey`
   is intentionally public — Firebase security is enforced by Firestore
   Rules, not by hiding this key.
6. **Generate a high-entropy founder secret.** See section 4 below.
7. **Hash the secret and deploy the rules.** See section 4 below.
8. **Deploy rules + indexes + hosting.** See section 3 below.
9. **Sign in to the deployed site and visit `/bootstrap.html`** to mint
   the very first estate. (Subsequent estates can be minted by a platform
   Admin from the executor page; only the bootstrap uses the founder secret.)

---

## 2. Configure `js/firebase-config.js`

Open `js/firebase-config.js` and replace the placeholder values with the
ones from your Firebase project's Web app registration:

```js
window.__FIREBASE_CONFIG__ = {
  "apiKey":            "<your-web-api-key>",
  "authDomain":        "<projectId>.firebaseapp.com",
  "projectId":         "<your-project-id>",
  "storageBucket":     "<projectId>.appspot.com",
  "messagingSenderId": "<numeric-sender-id>",
  "appId":             "<1:NNNN:web:XXXX>",
  "measurementId":     "<G-XXXXXXX>"   // optional, for Analytics
};
```

The `apiKey` field is public. Do NOT add IP restrictions here — Firebase
App Check (see section 7) is the right tool for that.

If the file still contains the literal string `REPLACE_WITH_` anywhere,
`js/firebase-bridge.js` will emit a console warning on page load.

---

## 3. Deploy modes (hosting vs. firestore)

Phase 18 added a `hosting` block to `firebase.json`. **A bare
`firebase deploy` now publishes BOTH `firestore` and `hosting`.** Pick the
narrowest target that matches what you changed:

| What you changed            | Command                                                |
| --------------------------- | ------------------------------------------------------ |
| `firestore.rules` only      | `firebase deploy --only firestore:rules`               |
| `firestore.indexes.json`    | `firebase deploy --only firestore:indexes`             |
| Both rules + indexes        | `firebase deploy --only firestore`                     |
| `firebase.json` (hosting)   | `firebase deploy --only hosting`                       |
| New static files (HTML/CSS/JS) | `firebase deploy --only hosting`                   |
| Everything (full release)   | `firebase deploy`                                      |

`firebase.json#hosting.ignore` excludes the following from being served
publicly:

```
firebase.json, firestore.rules, firestore.indexes.json, .firebaserc,
README.md, package.json, package-lock.json, **/.*, **/node_modules/**
```

The founder-secret SHA-256 inside `firestore.rules` is therefore NOT
served at any URL.

`firebase-config.js` IS served (it's loaded by every page via
`<script src="js/firebase-config.js">`). That is intentional — Firebase
Web SDK requires the API key in the browser. The `apiKey` is public-by-
design; security is enforced entirely by Firestore Rules.

---

## 4. Founder secret — generate, hash, deploy

The **founder secret** is a one-time-use passphrase that gates the very
first estate's creation. After `bootstrap.html` mints the first estate,
the secret is no longer needed (the bootstrap lock makes the path
permanently one-shot per project).

### 4.1 Generate a high-entropy secret

The secret must have at least 128 bits of entropy. Human-chosen passwords
are NOT acceptable — SHA-256 of a weak secret is brute-forceable offline
in seconds. Use a cryptographically-random generator:

```bash
# Option A: Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Option B: OpenSSL
openssl rand -hex 32

# Option C: /dev/urandom
head -c 32 /dev/urandom | xxd -p -c 64
```

Output is 64 hex characters (e.g. `9f2c8a3b...`). Save it in a password
manager NOW. After you paste it into the rules file's SHA-256 slot, you
should NOT need it again — `bootstrap.html` re-hashes whatever the
operator types at runtime.

### 4.2 Compute the SHA-256 to paste into `firestore.rules`

```bash
# Replace <SECRET> with the hex string from step 4.1.
echo -n "<SECRET>" | sha256sum
```

Output is 64 hex characters of the SHA-256 hash. Open `firestore.rules`
and replace the `__founderSecret` constant on the `allow create:` branch
of `match /estates/{estateId}`:

```diff
-   && request.resource.data.__founderSecret
-     == '<your-sha256-hex-from-step-4.2>'
+   && request.resource.data.__founderSecret
+     == '<your-sha256-hex-from-step-4.2>'
```

### 4.3 Audit S4 — the hash in  SHOULD be a placeholder

> **Audit finding S4 (HIGH)**: the project as shipped commits the founder-secret
> SHA-256 to a public git repo ( +  are both tracked).
> If the original secret was human-chosen (low entropy), this hash is
> offline-brute-forceable in seconds with . **Always generate the
> secret via 763a78b6db5eac57abe58b5dd6fc9f5ddab0d14148ab9735fbacda838264a7d9
> (or 81af0da8eb8f9e449806e2d0332601f275d98eb3f50d53c55e4719e2d6862f45) — never a human-chosen passphrase.**
>
> For deeper defense, replace the rule's hard-coded hash with a deploy-time
> template variable (e.g.,  + CI  substitution
> into ), then  the rendered rules file. The
> production rules engine never sees the template.

### 4.4 Deploy the rules

```bash
firebase deploy --only firestore:rules
```

### 4.4 Run the bootstrap

Visit `https://<your-project>.web.app/bootstrap.html`, sign in, paste the
original secret (NOT the SHA-256 hex), and submit. The browser hashes
the secret in-place before sending; the plaintext never leaves the page.
On success, `/_meta/bootstrap_lock` is written and the founder path is
permanently closed.

### 4.5 Rotate the secret

If you need to change the secret:

1. Compute a new SHA-256 from a new random secret (steps 4.1–4.2).
2. Edit `firestore.rules` and update the constant.
3. `firebase deploy --only firestore:rules`.

If the bootstrap lock already exists, the founder path is dead anyway —
the rule's `!isBootstrapLocked()` guard refuses every subsequent attempt.
To re-enable the path on an existing project, the lock doc would have
to be deleted by hand via the Firebase Console or Admin SDK. There is
no UI for that on purpose.

---

## 5. Firestore indexes

`firestore.indexes.json` declares composite indexes that the query layer
needs. The current schema has one index:

```json
{
  "collectionId": "invites",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "redeemedBy", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

This backs `App.Auth.Invite.listPendingInvites`, which sorts unredeemed
invites by creation date. Without the index, that query throws the
classic Firestore "The query requires an index" error; the executor
dashboard's "Pending Invitations" card will display the actionable
hint appended by `listPendingInvites`'s catch block.

```bash
firebase deploy --only firestore:indexes
```

Build the index takes a few minutes; Firestore will return
`FAILED_PRECONDITION` from the query until it's ready.

---

## 6. Security headers (CSP, HSTS, etc.)

`firebase.json#hosting.headers` ships a strict Content-Security-Policy
plus the standard hardening headers (X-Frame-Options, X-Content-Type-
Options, HSTS, Referrer-Policy, Permissions-Policy).

`script-src` and `style-src` currently allow `'unsafe-inline'` because
the 8 estate HTML pages use inline `<script>` blocks and 227 inline
`style="..."` attributes. **This is a Phase A trade-off.** Phase C work
will extract inline scripts to ES modules and promote inline styles to
CSS classes, at which point both `'unsafe-inline'` directives will be
dropped.

`firebase-config.js` is intentionally NOT in `hosting.ignore` (it MUST
be served as a `<script>`). The `apiKey` it exposes is public-by-design.

---

## 7. Recommended next steps

- **Firebase App Check.** Enable App Check with reCAPTCHA Enterprise so
  only requests from your domain can hit the Firestore backend. Without
  App Check, anyone can copy your `apiKey` and burn your free-tier quota.
- **Platform Admin claim.** After the first user signs in, visit
  `/dashboard.html` (or `/users.html`) and have that user call
  `App.Auth.Admin.claimAdmin()` to install the first platform Admin.
  See `firestore.rules#claimFirstAdmin` for the one-shot semantics.
- **MFA for Admins.** Firebase Auth supports TOTP MFA via
  `signInWithMultiFactor`. Recommend enforcing it for any account with
  `isAdmin == true`.

---

## 8. Troubleshooting

| Symptom                                                      | Likely cause                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html` shows red "Firebase is not configured" banner   | `App.Firebase.isReady()` returned false. Check browser devtools console for the exact reason. Most often: Firestore not enabled, or `js/firebase-config.js` still has `REPLACE_WITH_` placeholders. |
| `bootstrap.html` rejects the secret with "Permission denied"  | The SHA-256 of what you typed does NOT match the constant in `firestore.rules`. Re-check the hash, confirm `firebase deploy --only firestore:rules` has been run since the last edit. |
| "The query requires an index" error on the Pending Invites card | `firestore.indexes.json` not yet deployed, or the index build is still in progress. Run `firebase deploy --only firestore:indexes` and wait a few minutes. |
| "Missing or insufficient permissions" on a write             | The executor-write branch requires `roles[uid] == 'executor'`. Heirs / beneficiaries cannot mutate the estate doc. Use `App.Auth.Invite.consumeInviteFromUrl` (joiner) or ask an executor to change your role. |
| `firebase deploy` fails with "Site not found"                | `.firebaserc` does not have a `default` alias pointing at the project you deployed. Run `firebase use --add` and pick the project, or set `default` in `.firebaserc`. |
| Inline `<script>` blocked after Phase C                      | A future CSP tightening will drop `'unsafe-inline'` from `script-src`. Migrate inline scripts to `<script type="module" src="js/<page>.js">` BEFORE the deploy. |
| Dashboard shows "Missing or insufficient permissions" for a member | The user's uid is not in `estates/{id}.memberIds`. Either (a) they need to consume their invite URL, or (b) the executor removed them from the estate. The page-side gate `App.Permissions.canView` reads `roles[uid]` and will redirect to `index.html` if no role. |
| Founder-secret bootstrap rejected with no error message         | The SHA-256 in `firestore.rules` was edited locally but not redeployed. Run `firebase deploy --only firestore:rules`. Check the browser console — the bootstrap error path appends "The SHA-256 of the secret you entered does not match the constant in firestore.rules" if the server rejected the write. |
| Custom inline script blocked by CSP                            | With `'unsafe-inline'` in `script-src` (Phase A trade-off), simple inline scripts work. If you add a strict CSP later, either keep the nonce pattern OR move the script into `js/<page>.js` and load via `<script type="module">`. |

---

## 9. Related files

| Path                          | What it does                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `firebase.json`               | Firebase project config — Firestore rules + indexes source paths, Hosting public + headers + ignore list |
| `.firebaserc`                 | Project alias map                                                                                       |
| `firestore.rules`             | Security rules (Phase 1–9 hardening)                                                                    |
| `firestore.indexes.json`      | Composite index declarations                                                                            |
| `js/firebase-config.js`       | Per-project web SDK config (`apiKey`, `projectId`, etc.)                                                |
| `js/firebase-bridge.js`       | Initializes the Firebase SDKs and exposes `App.Firebase.{app,auth,db}`                                  |
| `js/app.js`                   | The shared application (Auth, Data, UI, Crypto, Permissions, Invite, Admin)                            |
| `bootstrap.html`              | One-time founder-estate creation form                                                                   |
| `index.html`                  | Login / register landing page                                                                           |
| `dashboard.html` + 8 estate pages | The data-entry UIs (dashboard, tasks, executor, decedent, assets, debts, cashflow, distributions, heirs) |

See `README.md` for a one-paragraph project overview.
