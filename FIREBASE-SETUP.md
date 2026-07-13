# EstatePro — Firebase Setup (Phase 1)

This document walks you through turning on the Firebase backend that the
new multi-user EstatePro will run on.

> **You will only do this once per project.** After the founder estate is
> bootstrapped, every future executor/heir is created via in-app invite flow
> (Phase 4).

## 1. Create / pick a Firebase project

1. Go to <https://console.firebase.google.com/> and create a new project
   (or use an existing free-tier project).
2. In the project, go to **Build → Authentication → Sign-in method** and
   enable **Email/Password**.
3. (Optional, recommended) go to **Build → Firestore Database** and create
   the database. Pick the production-mode "Start in production mode"; we'll
   replace the default rules with the file in this repo.

## 2. Get your Firebase Web SDK config

1. In the Firebase console, **Project settings (gear) → General**.
2. Scroll to **Your apps** → click **</>** (Web) → register an app named
   something like "EstatePro GitHub Pages". (Hosting setup is not needed;
   we stay on GitHub Pages.)
3. Copy the `firebaseConfig` snippet. Open
   `js/firebase-config.js` in this repo and paste the values into
   `window.__FIREBASE_CONFIG__`. Save and commit.

The `apiKey` here is **safe to expose publicly**. Firebase security is
enforced by Firestore Rules, not by hiding this key.

## 3. Generate the founder secret + SHA-256

The founder secret is a 32-byte random string that gates creation of the
very first estate. Pick one and keep it offline (you'll discard it after
bootstrap; only its SHA-256 hash stays in `firestore.rules`).

```bash
# 1. Generate a 64-character hex secret (32 random bytes)
SECRET=$(openssl rand -hex 32)
echo "Secret (keep offline): $SECRET"

# 2. Compute SHA-256 hex of the secret (this goes into firestore.rules)
echo -n "$SECRET" | shasum -a 256 | awk '{print $1}'
```

The second command prints the hex you'll paste into `firestore.rules`.

## 4. Edit firestore.rules

Open `firestore.rules` and replace the placeholder constant:

```
... == 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
```

with the SHA-256 hex you just produced. (You'll do this **before**
the first deploy.)

## 5. Deploy the rules

```bash
# Install the Firebase CLI once (any host)
npm install -g firebase-tools

# Log in
firebase login

# From the repo root, point the CLI at your project
firebase use --add            # select your project from the list

# Deploy only the rules (and indexes, when you have them)
firebase deploy --only firestore:rules,firestore:indexes
```

You can verify the rule in the Firebase Console under
**Firestore → Rules**.

## 6. Ship the GitHub Pages frontend

Push your changes (including the filled-in `js/firebase-config.js`) to the
branch GitHub Pages serves from. Make sure the HTML pages load scripts in
this order:

```html
<!-- Firebase SDK -->
<script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js"></script>

<!-- App config (user-edited) -->
<script src="js/firebase-config.js"></script>

<!-- Firebase -> App.Firebase bridge -->
<script src="js/firebase-bridge.js"></script>

<!-- Main app -->
<script src="js/app.js"></script>
```

`index.html` and `bootstrap.html` already include this order in Phase 1.

## 7. First sign-up

1. Open your GitHub Pages URL → `index.html`.
2. Click **Register**, enter Full Name + Email + Password (≥ 6 chars).
3. Sign in.

The new `App.Auth` wrapper creates:
- A Firebase Auth user
- A `users/{uid}` Firestore profile doc

> **If you see a red "Firebase is not configured" banner above the form**
> with a specific reason, that is the helpful replacement for the old
> "Cannot read properties of undefined (reading 'db')" error. The most
> common causes are:
> - **You haven't enabled Firestore yet.** The Auth service is enabled but
>   the Firestore service isn't — go to **Build → Firestore Database** in
>   the Firebase console and click **Create database**.
> - **`firebase-config.js` still has placeholders.** Paste your real
>   Firebase Web SDK config values into `js/firebase-config.js` (step 2).
> - **The Firebase SDK `<script>` tags aren't before `js/firebase-bridge.js`
>   in your HTML.** Verify the order in step 6.
>
> If the banner doesn't show but registration still errors, check the
> browser dev tools Console for the full stack trace.

## 8. Founder bootstrap

1. While signed in, visit `bootstrap.html`.
2. Enter an Estate name.
3. Paste the secret you generated in step **3**.
4. Click **Create Estate**.

The page SHA-256s the secret in the browser, then submits a single
`set()` call to `estates/{newId}` carrying `__founderSecret` plus an
empty `pendingInvites` and `memberIds=[<your uid>], roles[<your uid>]=
'executor'`. The Firestore Rule confirms the hash matches your deployed
constant.

If you get "Permission denied", the most common cause is the hash constant
not matching — recheck step 4.

## 9. After the first estate is up

You're done with Phase 1. You now have:
- A Firebase project with Email/Password auth enabled.
- A single estate you own as Executor.
- A user profile doc.

Phase 2 will replace `App.Data` to back the estate with Firestore reads
and debounced writes. Phase 4 will add invite URLs and the multi-estate
sidebar dropdown.

## Security notes

- The founder secret is never sent to the server in plaintext. Only its
  SHA-256 ever leaves the browser.
- The precomputed hash constant is in `firestore.rules`, which Firebase
  stores server-side. **Do not** publish this file to a public URL.
- If you want to rotate the secret (after Phase 1 setup), generate a new
  secret + new SHA-256, deploy rules, then visit `bootstrap.html` once.
  After that, anyone who creates a new estate without the secret will be
  blocked by the rule.
- Free tier limits (Spark plan): 50k Firestore reads/day, 20k writes/day,
  1 GB storage, 50k Auth MAUs.
