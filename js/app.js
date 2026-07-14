/* ============================================
   EstatePro - Estate Management Application
   Shared JavaScript Module
   ============================================ */

// IMPORTANT: we assign both `const App` AND `window.App` to the same merged
// object. Firebase compat SDK's bridge currently writes `window.App.Firebase`
// at top level (loads BEFORE this file). A plain `const App = { ... }` would
// create a NEW lexical binding that SHADOWS `window.App`, hiding the
// bridge's `.Firebase` from every reference inside this file. Merging into
// `window.App` via `Object.assign` keeps the bridge's Firebase stub intact
// while still allowing the rest of the file to reference properties via the
// const alias. Don't change this back to just `const App = { ... }` or every
// App.Firebase check breaks.
const App = window.App = Object.assign(window.App || {}, {
  /* ============================
     AUTHENTICATION
     ============================ */
  Auth: {
    // Firebase Auth-backed wrapper for EstatePro.
    // Phase 1 scope: register, login, logout, session check, getMyEstates.
    // Phase 2: signals readiness to App.init via _firstAuthReadyPromise
    //          AFTER the bunded Firestore estate has been loaded (Data.initAsync).
    _currentUser: null,
    _ready: false,
    _stateListeners: [],
    _firstAuthReadyPromise: null,
    _onFirstAuthReady: null,

    init() {
      // Hook the auth-state listener once at app boot. Use `var self` so the
      // callback's `this` does not need rebinding; the inner handler then
      // delegates to a real method on `this`.
      var self = this;
      // Promise that resolves once Firebase auth has emitted its first
      // state-change event AND App.Data.initAsync() has finished pulling the
      // booted Firestore estate into the in-memory cache. App.init awaits this
      // before calling UI.init(), so any `App.onReady(cb)` registered by HTML
      // pages only fires after data is ready to render.
      this._firstAuthReadyPromise = new Promise(function (resolve) {
        self._onFirstAuthReady = resolve;
      });
      firebase.auth().onAuthStateChanged(function (user) {
        self._handleAuthUser(user);
      });
    },

    awaitFirstAuthReady() {
      // Called by App.init.  If init() was never called, resolve immediately
      // (no-op); if init was called and the first auth event has not yet
      // fired, await the promise.
      if (!this._firstAuthReadyPromise) return Promise.resolve();
      return this._firstAuthReadyPromise;
    },

    async _handleAuthUser(user) {
      if (user) {
        this._currentUser = await this._hydrateProfile(user);
        // Phase 2: pull the Firestore estate into App.Data._cache so any
        // page that registers via App.onReady() can read App.Data.getEstate()
        // synchronously and get our actual cloud-backed doc, not the
        // localStorage seed.
        try {
          await App.Data.initAsync();
        } catch (e) {
          console.error('App.Data.initAsync failed during auth:', e);
        }
      } else {
        this._currentUser = null;
        // Even for signed-out users we want App.init to proceed so a sign-in
        // landing page can use App.onReady().
        try { App.Data.initAsync(); } catch (e) { /* ignore */ }
      }
      this._ready = true;
      var self = this;
      this._stateListeners.forEach(function (cb) {
        try { cb(self._currentUser); } catch (e) { console.error(e); }
      });
      // Unblock any awaiters of App.init() now that Auth AND Data are ready.
      if (typeof this._onFirstAuthReady === 'function') {
        var fn = this._onFirstAuthReady;
        this._onFirstAuthReady = null;
        fn();
      }
    },

    async _hydrateProfile(firebaseUser) {
      // If the Firebase bridge didn't initialize (e.g. Firestore not enabled),
      // return a best-effort profile from the Firebase Auth user only.
      if (!App.Firebase || !App.Firebase.db) {
        console.warn('[EstatePro] Firebase Firestore is unavailable; profile ' +
          'hydration skipped. Reason: ' +
          (App.Firebase && App.Firebase.whyNotReady && App.Firebase.whyNotReady() ||
            'App.Firebase is undefined.'));
        return {
          uid: firebaseUser.uid,
          id: firebaseUser.uid,
          email: firebaseUser.email,
          name: firebaseUser.displayName || firebaseUser.email,
          role: null,
          displayName: firebaseUser.displayName || '',
          createdAt: null
        };
      }
      try {
        var ref = App.Firebase.db.collection('users').doc(firebaseUser.uid);
        var snap = await ref.get();
        var profile = snap.exists ? snap.data() : null;
        return {
          uid: firebaseUser.uid,
          id: firebaseUser.uid,
          email: firebaseUser.email,
          name: (profile && profile.displayName) || firebaseUser.displayName || firebaseUser.email,
          role: null,
          displayName: (profile && profile.displayName) || '',
          createdAt: (profile && profile.createdAt) || null
        };
      } catch (e) {
        console.warn('Could not hydrate user profile:', e);
        return {
          uid: firebaseUser.uid,
          id: firebaseUser.uid,
          email: firebaseUser.email,
          name: firebaseUser.displayName || firebaseUser.email,
          role: null,
          displayName: firebaseUser.displayName || '',
          createdAt: null
        };
      }
    },

    onAuthStateChanged(cb) {
      if (typeof cb !== 'function') return;
      this._stateListeners.push(cb);
      if (this._ready) cb(this._currentUser);
    },

    async register(opts) {
      // New signature: register({email, password, name})
      var email = (opts && opts.email) || '';
      var password = (opts && opts.password) || '';
      var name = (opts && opts.name) || '';
      // Refuse early with a helpful message if Firebase Firestore isn't ready.
      // (Auth alone could succeed, but we can't write the users/{uid} doc
      // without Firestore — and the ruleset also requires email on create.)
      if (!App.Firebase || !App.Firebase.db) {
        // Surface the bridge's whyNotReady() directly. We removed the previous
        // hardcoded "Firebase Firestore did not initialize." prefix because it
        // was attached to every failure even when the real cause was something
        // else (config placeholders, auth() returning null, SDK missing, etc.).
        // The fallback below is polyfilled: it fires only when (a) the bridge
        // script never ran, (b) App.Firebase is the legacy null stub, or (c)
        // the user is on a cached build where whyNotReady() returned ''.
        var rawWhy = (App.Firebase && typeof App.Firebase.whyNotReady === 'function')
          ? App.Firebase.whyNotReady()
          : '';
        var reason = (typeof rawWhy === 'string' && rawWhy.trim()) ||
          'Firebase services did not initialize. The most common cause is ' +
          'that Cloud Firestore is not yet enabled in your Firebase project ' +
          '(Firebase Console \u2192 Build \u2192 Firestore Database \u2192 Create database), ' +
          'or that js/firebase-config.js still has placeholder values. ' +
          'Open the browser dev console (F12) for full details.';
        return {
          success: false,
          message: 'Cannot create account: ' + reason
        };
      }
      try {
        var cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
        if (name) {
          await cred.user.updateProfile({ displayName: name });
        }
        await App.Firebase.db.collection('users').doc(cred.user.uid).set({
          email: email,
          displayName: name || '',
          createdAt: new Date().toISOString()
        });
        return { success: true, message: 'Account created successfully.' };
      } catch (err) {
        return { success: false, message: this._formatAuthError(err) };
      }
    },

    async login(email, password) {
      try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
        return { success: true, message: 'Login successful.' };
      } catch (err) {
        return { success: false, message: this._formatAuthError(err) };
      }
    },

    async logout() {
      try { await firebase.auth().signOut(); }
      catch (e) { console.error('logout error:', e); }
      window.location.href = 'index.html';
    },

    getCurrentUser() {
      // Synchronous fallback: if _hydrateProfile hasn't finished yet, we still
      // have the raw Firebase user available via firebase.auth().currentUser.
      if (this._currentUser) return this._currentUser;
      var u = firebase.auth().currentUser;
      if (!u) return null;
      return {
        uid: u.uid,
        id: u.uid,
        email: u.email,
        name: u.displayName || u.email,
        displayName: u.displayName || '',
        role: null,
        createdAt: null
      };
    },

    checkSession() {
      var u = App.Auth.getCurrentUser();
      if (!u) {
        window.location.href = 'index.html';
        return null;
      }
      return u;
    },

    isLoggedIn() {
      return !!this.getCurrentUser();
    },

    async getMyEstates() {
      var u = App.Auth.getCurrentUser();
      if (!u) return [];
      if (!App.Firebase || !App.Firebase.db) {
        console.warn('[EstatePro] getMyEstates: Firestore unavailable. ' +
          'Reason: ' + (App.Firebase && App.Firebase.whyNotReady && App.Firebase.whyNotReady() ||
            'App.Firebase is undefined.'));
        return [];
      }
      var snap = await App.Firebase.db.collection('estates')
        .where('memberIds', 'array-contains', u.uid).get();
      return snap.docs.map(function (d) {
        var data = d.data();
        // NOTE: we intentionally DO NOT strip __founderSecret here.  The
        // Firestore ruleset allows Phase 2 executor updates only if
        // __founderSecret is unchanged (field missing OR equal).  Since the
        // phase-2 data layer sends only fields pages mutated (which never
        // includes __founderSecret), Firestore wouldn't touch the server's
        // value -- but the rule-check would still fire on the missing-field
        // case unless we also re-send the same value.  Keeping it in the
        // cache + round-tripping it during _flush() satisfies the rule.
        // No page renders __founderSecret; it's safe to leave in the doc.
        return { id: d.id, _doc: data };
      });
    },

    /* ============================================
       INVITES  (Phase 4)
       ============================================ */
    Invite: {
      // ---- createInvite ----
      // Called from the executor's "Share Invite" panel. Writes a thin
      // envelope doc into /estates/{estateId}/invites/{auto-id}. Rules (in
      // firestore.rules) gate this to executors of the parent estate and
      // require {inviteeEmail, role, createdBy, createdAt}.
      //
      // Returns {inviteId, url} where url is the share-able link the executor
      // pastes into email/chat/etc. We pass the inviteId directly in the URL
      // -- Firestore rules validate that the joiner's auth.token.email matches
      // the doc's inviteeEmail so the doc-id-in-URL doesn't grant any extra
      // privilege to a random viewer.
      async createInvite(estateId, role, inviteeEmail) {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) {
          return { success: false, message: 'Firestore not initialized.' };
        }
        if (!['executor', 'heir', 'beneficiary'].includes(role)) {
          return { success: false, message: 'Invalid role. Use executor/heir/beneficiary.' };
        }
        if (!inviteeEmail || !/^\S+@\S+\.\S+$/.test(inviteeEmail)) {
          return { success: false, message: 'Please enter a valid email address.' };
        }
        try {
          var ref = await App.Firebase.db.collection('estates').doc(estateId)
            .collection('invites').add({
              inviteeEmail: inviteeEmail,
              role: role,
              createdBy: u.uid,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              redeemedBy: null,
              redeemedAt: null
            });
          var url = new URL(window.location.origin + '/index.html');
          url.searchParams.set('estateId', estateId);
          url.searchParams.set('inviteId', ref.id);
          return { success: true, inviteId: ref.id, url: url.toString() };
        } catch (err) {
          return { success: false, message: 'Could not create invite: ' + (err && err.message ? err.message : err) };
        }
      },

      // ---- listPendingInvites ----
      // Query the subcollection and return only unredeemed entries. Executor
      // dashboard uses this to populate the "Pending Invitations" card.
      async listPendingInvites(estateId) {
        if (!App.Firebase || !App.Firebase.db) return [];
        try {
          var snap = await App.Firebase.db.collection('estates').doc(estateId)
            .collection('invites')
            .where('redeemedBy', '==', null)
            .orderBy('createdAt', 'desc')
            .get();
          return snap.docs.map(function (d) {
            var data = d.data();
            var url = window.location.origin + '/index.html?estateId=' + encodeURIComponent(estateId) + '&inviteId=' + encodeURIComponent(d.id);
            return { id: d.id, _doc: data, url: url };
          });
        } catch (e) {
          console.warn('[EstatePro] listPendingInvites failed:', e && e.message);
          return [];
        }
      },

      // ---- consumeInviteFromUrl ----
      // Atomic acceptance. We perform a single runTransaction that:
      //   (a) reads the parent estate doc + the invite subdoc,
      //   (b) verifies invite.redeemedBy == null AND inviteeEmail matches our auth.email,
      //   (c) writes the invite subdoc with redeemedBy=uid + redeemedAt=serverTimestamp(),
      //   (d) writes the parent doc with memberIds += [uid], roles[uid] = invite.role,
      //       and pendingInvites.size() -= 1 (via Firestore.FieldValue.delete if the invite id is a key).
      // Firestore's runTransaction rolls back both writes if either is rejected server-side.
      async consumeInviteFromUrl(estateId, inviteId) {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) return { success: false, message: 'Firestore not initialized.' };
        if (!estateId || !inviteId) return { success: false, message: 'Missing invite parameters.' };

        var db = App.Firebase.db;
        var authEmail = (firebase.auth().currentUser && firebase.auth().currentUser.email) || '';
        var invRef = db.collection('estates').doc(estateId).collection('invites').doc(inviteId);
        var estRef = db.collection('estates').doc(estateId);

        try {
          await db.runTransaction(async function (tx) {
            var invSnap = await tx.get(invRef);
            if (!invSnap.exists) throw new Error('Invite has been revoked or never existed.');
            var inv = invSnap.data();
            if (inv.redeemedBy) throw new Error('This invite was already redeemed by ' + inv.redeemedBy + '.');
            if (inv.inviteeEmail && authEmail && inv.inviteeEmail.toLowerCase() !== authEmail.toLowerCase()) {
              throw new Error('You must be signed in as ' + inv.inviteeEmail + ' to claim this invite.');
            }
            var role = inv.role;
            if (!['executor', 'heir', 'beneficiary'].includes(role)) {
              throw new Error('Invite has an invalid role: ' + role);
            }
            // (c) Mark the subdoc as redeemed.
            tx.update(invRef, {
              redeemedBy: u.uid,
              redeemedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // (d) Update parent doc.
            var estSnap = await tx.get(estRef);
            if (!estSnap.exists) throw new Error('Estate document not found.');
            var newMemberIds = (estSnap.get('memberIds') || []).concat([u.uid]);
            var newRoles = Object.assign({}, estSnap.get('roles') || {});
            newRoles[u.uid] = role;
            // Drop our invite key from pendingInvites (if map-based; Phase 1 created it as empty {}).
            var pi = estSnap.get('pendingInvites') || {};
            var piUpdate = {};
            if (inviteId in pi) { piUpdate['pendingInvites.' + inviteId] = firebase.firestore.FieldValue.delete(); }
            tx.update(estRef, Object.assign({
              memberIds: newMemberIds,
              roles: newRoles,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, piUpdate));
          });
          // Active estate switched -- the new member now has access.
          if (App.Data && App.Data._currentEstateId !== estateId) {
            App.Data._currentEstateId = estateId;
            try { await App.Data.initAsync(); } catch (e) { /* ignore */ }
          }
          return { success: true, message: 'Welcome! You now have access to the estate.' };
        } catch (err) {
          return { success: false, message: err && err.message ? err.message : 'Could not consume invite.' };
        }
      }
    },

    // (InviteUrl was a sibling function declaration next to the Invite
    // object literal -- which is a syntax error inside Object.assign's body.
    // The URL build is now inlined at the two call sites that need it:
    // Invite.createInvite and Invite.listPendingInvites. A helper would
    // belong on App itself, not next to App.Auth.Invite.)

    // ---- Compatibility stubs for legacy callers (Sync export, users.html) ----
    // Phase 1 does not back the users list yet. These return safe values so
    // legacy pages don't crash; they are no-ops for new functionality.
    getUsers() { return []; },
    saveUsers() { return Promise.resolve(); },
    async restoreDefaultUsers() {
      return { success: false, message: 'Demo defaults are removed in this build. Sign up via the Register form.' };
    },
    async updateUserRole() { return { success: false, message: 'Per-user roles are not used in Phase 1. Use estate memberships in Phase 4.' }; },
    async deleteUser() { return { success: false, message: 'Not available in Phase 1.' }; },
    async resetUserPassword() { return { success: false, message: 'Use the Firebase Auth "reset password" flow instead.' }; },
    async promoteSelfToAdmin() { return { success: false, message: 'Per-estate roles are managed via invites in Phase 4.' }; },
    async changeOwnPassword() { return { success: false, message: 'Use the Firebase Auth change-password flow (Profile menu).' }; },

    _formatAuthError(err) {
      if (!err || !err.code) return (err && err.message) || 'Unknown error.';
      switch (err.code) {
        case 'auth/email-already-in-use':    return 'An account with this email already exists.';
        case 'auth/invalid-email':           return 'Please enter a valid email address.';
        case 'auth/user-disabled':           return 'This account has been disabled.';
        case 'auth/user-not-found':          return 'No account found for that email.';
        case 'auth/wrong-password':          return 'Incorrect password.';
        case 'auth/weak-password':           return 'Password must be at least 6 characters.';
        case 'auth/invalid-credential':      return 'Invalid email or password.';
        case 'auth/missing-password':        return 'Please enter a password.';
        case 'auth/too-many-requests':       return 'Too many attempts. Try again later.';
        case 'auth/network-request-failed':  return 'Network error. Check your connection and try again.';
        default: return err.message || 'Authentication failed.';
      }
    }
  },

  /* ============================
     PERMISSIONS
     ============================ */
  Permissions: {
    canEdit() {
      const user = App.Auth.getCurrentUser();
      if (!user) return false;
      // Phase 4 fix: the Firestore-backed model puts authorization on the
      // estate doc's `roles[uid]` map, NOT on a per-user `user.role` field,
      // and _hydrateProfile always returns role:null. Without consulting
      // estate roles here, applyPermissions() would never enable edit
      // mode for a signed-in user -- every form input across the app would
      // be disabled at boot, including the executor's invite form. The
      // Share Estate Invitations card's own gate uses the same
      // `estate.roles[uid] === 'executor'` check (see executor.html
      // renderShareInvites). We mirror it here so the global edit gate and
      // the card's gate stay in sync.
      try {
        const estate = (App.Data && typeof App.Data.getEstate === 'function')
          ? App.Data.getEstate() : null;
        const roles = (estate && estate.roles) || {};
        if (roles[user.uid] === 'executor') return true;
      } catch (e) { /* fall through silently -- never crash the gate */ }
      return user.role === 'Admin' || user.role === 'Executor';
    },

    canManageUsers() {
      const user = App.Auth.getCurrentUser();
      if (!user) return false;
      // Phase 4 fix: only the active estate's executor can issue invites
      // and clear estate data (these correspond to legacy "Admin" powers).
      // Mirror canEdit's estate-roles lookup so the manage-gate consistently
      // reflects Phase-4 authority.
      try {
        const estate = (App.Data && typeof App.Data.getEstate === 'function')
          ? App.Data.getEstate() : null;
        const roles = (estate && estate.roles) || {};
        if (roles[user.uid] === 'executor') return true;
      } catch (e) { /* fall through */ }
      return user.role === 'Admin';
    },

    canView() {
      return App.Auth.isLoggedIn();
    },

    getRoleLabel(role) {
      const labels = { Admin: 'Administrator', Executor: 'Executor', Heir: 'Heir', Beneficiary: 'Beneficiary' };
      return labels[role] || role;
    }
  },

  /* ============================
     CRYPTO
     ============================ */
  Crypto: {
    _passphrase: null,
    _key: null,

    _arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    },

    _base64ToArrayBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    },

    _hasSubtle() {
      try {
        return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.importKey === 'function';
      } catch (e) {
        return false;
      }
    },

    async _sha256Fallback(message) {
      const encoder = new TextEncoder();
      const data = encoder.encode(message);
      const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ];
      const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
      const blocks = [];
      const len = data.length;
      let i = 0;
      let w = [];
      while (i < len) {
        blocks.push(data[i] & 0xff);
        i++;
      }
      blocks.push(0x80);
      while ((blocks.length % 64) !== 56) {
        blocks.push(0);
      }
      const bitLen = len * 8;
      for (let i = 0; i < 8; i++) {
        blocks.push((bitLen >>> (56 - i * 8)) & 0xff);
      }
      for (let i = 0; i < blocks.length; i += 64) {
        const block = blocks.slice(i, i + 64);
        for (let t = 0; t < 64; t++) {
          if (t < 16) {
            w[t] = (block[t * 4] << 24) | (block[t * 4 + 1] << 16) | (block[t * 4 + 2] << 8) | block[t * 4 + 3];
          } else {
            const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
            const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
            w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
          }
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let t = 0; t < 64; t++) {
          const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
          const ch = (e & f) ^ (~e & g);
          const temp1 = (hh + S1 + ch + K[t] + w[t]) | 0;
          const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
          const maj = (a & b) ^ (a & c) ^ (b & c);
          const temp2 = (S0 + maj) | 0;
          hh = g;
          g = f;
          f = e;
          e = (d + temp1) | 0;
          d = c;
          c = b;
          b = a;
          a = (temp1 + temp2) | 0;
        }
        h[0] = (h[0] + a) | 0;
        h[1] = (h[1] + b) | 0;
        h[2] = (h[2] + c) | 0;
        h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0;
        h[5] = (h[5] + f) | 0;
        h[6] = (h[6] + g) | 0;
        h[7] = (h[7] + hh) | 0;
      }
      return h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
    },

    async _deriveKey(passphrase, salt) {
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
      );
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    },

    async _getKey(passphrase) {
      if (this._key) return this._key;
      const keySaltRaw = localStorage.getItem('estatepro_key_salt');
      const salt = keySaltRaw ? this._base64ToArrayBuffer(keySaltRaw) : new Uint8Array(16);
      this._key = await this._deriveKey(passphrase, salt);
      return this._key;
    },

    clearKeyCache() {
      this._key = null;
    },

    async encrypt(plaintext, passphrase) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await this._getKey(passphrase);
      const encoder = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, encoder.encode(plaintext)
      );
      return {
        v: 1,
        salt: this._arrayBufferToBase64(salt),
        iv: this._arrayBufferToBase64(iv),
        ct: this._arrayBufferToBase64(ciphertext),
        algo: 'AES-GCM-256-PBKDF2'
      };
    },

    async decrypt(envelope, passphrase) {
      const iv = this._base64ToArrayBuffer(envelope.iv);
      const ct = this._base64ToArrayBuffer(envelope.ct);
      const keySaltRaw = localStorage.getItem('estatepro_key_salt');
      if (keySaltRaw) {
        const key = await this._getKey(passphrase);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(decrypted);
      }
      // Fallback: old data encrypted without a fixed key salt
      const salt = this._base64ToArrayBuffer(envelope.salt);
      const key = await this._deriveKey(passphrase, salt);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(decrypted);
    },

    isEncryptionEnabled() {
      return localStorage.getItem('estatepro_encrypted') === 'true';
    },

    async readStorage(key) {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ct && parsed.algo) {
          const passphrase = this._passphrase;
          if (!passphrase) {
            throw new Error('Passphrase required to decrypt data');
          }
          const decrypted = await this.decrypt(parsed, passphrase);
          return JSON.parse(decrypted);
        }
        return parsed;
      } catch (e) {
        return null;
      }
    },

    async writeStorage(key, value) {
      if (this.isEncryptionEnabled() && this._passphrase) {
        const envelope = await this.encrypt(JSON.stringify(value), this._passphrase);
        localStorage.setItem(key, JSON.stringify(envelope));
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    },

    async setPassphrase(passphrase) {
      this._passphrase = passphrase;
      try {
        await this._getKey(passphrase);
      } catch (e) {
        this._key = null;
      }
    },

    loadPassphraseFromSession() {
      try {
        const stored = sessionStorage.getItem('estatepro_passphrase');
        if (stored) {
          this._passphrase = stored;
          return true;
        }
      } catch (e) { /* sessionStorage may be unavailable */ }
      return false;
    },

    savePassphraseToSession() {
      try {
        if (this._passphrase) {
          sessionStorage.setItem('estatepro_passphrase', this._passphrase);
        } else {
          sessionStorage.removeItem('estatepro_passphrase');
        }
      } catch (e) { /* sessionStorage may be unavailable */ }
    },

    clearPassphraseFromSession() {
      try {
        sessionStorage.removeItem('estatepro_passphrase');
      } catch (e) { /* sessionStorage may be unavailable */ }
    },

    getPassphrase() {
      return this._passphrase;
    },

    hasPassphrase() {
      return !!this._passphrase;
    },

    async verifyPassphrase(passphrase) {
      const raw = localStorage.getItem('estatepro_key_verify');
      if (!raw) return false;
      try {
        const envelope = JSON.parse(raw);
        const iv = this._base64ToArrayBuffer(envelope.iv);
        const ct = this._base64ToArrayBuffer(envelope.ct);
        const keySaltRaw = localStorage.getItem('estatepro_key_salt');
        let key;
        if (keySaltRaw) {
          const salt = this._base64ToArrayBuffer(keySaltRaw);
          key = await this._deriveKey(passphrase, salt);
        } else {
          const salt = this._base64ToArrayBuffer(envelope.salt);
          key = await this._deriveKey(passphrase, salt);
        }
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv }, key, ct
        );
        return new TextDecoder().decode(decrypted) === 'EstatePro:v1';
      } catch (e) {
        return false;
      }
    },

    async setupEncryption(passphrase) {
      const estate = App.Data.getEstate();
      const users = App.Auth.getUsers();
      this._passphrase = passphrase;
      // Generate and store a fixed key derivation salt
      const keySalt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem('estatepro_key_salt', this._arrayBufferToBase64(keySalt));
      this._key = await this._deriveKey(passphrase, keySalt);
      const verifyEnvelope = await this.encrypt('EstatePro:v1', passphrase);
      localStorage.setItem('estatepro_key_verify', JSON.stringify(verifyEnvelope));
      localStorage.setItem('estatepro_encrypted', 'true');
      await this.writeStorage('estatepro_estate', estate);
      await this.writeStorage('estatepro_users', users);
      return { success: true, message: 'Encryption enabled. All data is now encrypted.' };
    },

    async changePassphrase(oldPassphrase, newPassphrase) {
      if (!await this.verifyPassphrase(oldPassphrase)) {
        return { success: false, message: 'Current passphrase is incorrect.' };
      }
      const estate = await this.readStorage('estatepro_estate');
      const users = await this.readStorage('estatepro_users');
      this._passphrase = newPassphrase;
      this._key = null;
      await this._getKey(newPassphrase);
      const verifyEnvelope = await this.encrypt('EstatePro:v1', newPassphrase);
      localStorage.setItem('estatepro_key_verify', JSON.stringify(verifyEnvelope));
      await this.writeStorage('estatepro_estate', estate);
      await this.writeStorage('estatepro_users', users);
      return { success: true, message: 'Passphrase changed successfully.' };
    },

    async disableEncryption(passphrase) {
      if (!await this.verifyPassphrase(passphrase)) {
        return { success: false, message: 'Passphrase is incorrect.' };
      }
      const estate = await this.readStorage('estatepro_estate');
      const users = await this.readStorage('estatepro_users');
      localStorage.removeItem('estatepro_encrypted');
      localStorage.removeItem('estatepro_key_verify');
      localStorage.removeItem('estatepro_key_salt');
      this._passphrase = null;
      this._key = null;
      localStorage.setItem('estatepro_estate', JSON.stringify(estate));
      localStorage.setItem('estatepro_users', JSON.stringify(users));
      return { success: true, message: 'Encryption disabled. Data is now stored in plaintext.' };
    },

    async init() {
      if (this.isEncryptionEnabled() && !this.hasPassphrase()) {
        return new Promise((resolve) => {
          App.UI.showPassphraseModal(async () => {
            await App.Data.init();
            try {
              await App.Auth.init();
            } catch (e) {
              console.error('Auth.init failed during passphrase modal:', e);
            }
            resolve();
          });
        });
      }
      await App.Data.init();
      try {
        await App.Auth.init();
      } catch (e) {
        console.error('Auth.init failed during Crypto.init:', e);
      }
    }
  },

  /* ============================
     DATA MANAGEMENT
     Phase 2: Firestore-backed.
     - initAsync() pulls the user's estate doc into the in-memory _cache.
     - getEstate() returns _cache synchronously for render loops.
     - saveEstate(estate, immediate) writes-through to _cache and schedules
       a debounced Firestore .update() of the entire doc (500ms trailing
       edge; pass `immediate = true` for deletes that must NOT be lost).
     - isReady() reports whether _cache is bound to a real Firestore doc.
     The legacy `init()` localStorage-seed path is retained below for
     pre-Auth contexts (login page, encryption passphrase gate) where we
     can't yet hit Firestore. App.init() never calls init() in Phase 2;
     initAsync() is the path for signed-in users.
     ============================ */
  Data: {
    _cache: null,
    _currentEstateId: null,
    _debounceTimer: null,

    async init() {
      // Legacy localStorage seed path. Kept for backwards compat with
      // pre-Auth flows and the encryption passphrase gate. Phase 2's signed-in
      // path is initAsync() below.
      let estate = await App.Crypto.readStorage('estatepro_estate');
      if (!estate) {
        estate = this.getSeedData();
        await App.Crypto.writeStorage('estatepro_estate', estate);
      } else {
        let migrated = false;
        let seed = null;
        if (estate.decedent && !estate.decedent.documents) {
          seed = seed || this.getSeedData();
          estate.decedent.documents = seed.decedent.documents;
          migrated = true;
        }
        if (estate.executor && !estate.executor.documents) {
          seed = seed || this.getSeedData();
          estate.executor.documents = seed.executor.documents;
          migrated = true;
        }
        if (Array.isArray(estate.cashflow)) {
          for (const tx of estate.cashflow) {
            if (tx && typeof tx.accountId !== 'number' && typeof tx.account === 'string') {
              const match = (estate.assets || []).find(a => a && a.name === tx.account);
              if (match) {
                tx.accountId = match.id;
                migrated = true;
              }
            }
          }
        }
        if (migrated) {
          await App.Crypto.writeStorage('estatepro_estate', estate);
        }
      }
      this._cache = estate;
    },

    async initAsync() {
      // Phase 2: binds the in-memory cache to the signed-in user's estate.
      // Called by Auth._handleAuthUser after profile hydration. Callers do
      // not need to await it; App.init awaits Auth.awaitFirstAuthReady(),
      // which is itself resolved from inside _handleAuthUser AFTER this
      // function returns, so any App.onReady() callback registered by a
      // data page is guaranteed to render with _cache populated.
      try {
        if (!App.Auth || typeof App.Auth.getCurrentUser !== 'function') {
          this._cache = this.getEmptyEstate();
          return;
        }
        var u = App.Auth.getCurrentUser();
        if (!u) {
          // No signed-in user. Stay with a stable empty shape so pages that
          // render before auth-state-known still produce output (rather than
          // throwing).
          this._cache = this.getEmptyEstate();
          return;
        }
        if (!App.Firebase || !App.Firebase.db) {
          // No Firestore available; keep cache empty. Pages that need data
          // will detect this in initAsync() and render a banner.
          this._cache = this.getEmptyEstate();
          return;
        }
        var estates = await App.Auth.getMyEstates();
        if (!estates || estates.length === 0) {
          // No estate yet — caller is in the bootstrap path. Page may want
          // to redirect to bootstrap.html. We stay on the requested page;
          // sidebar nav already directs the user there.
          this._currentEstateId = null;
          this._cache = this.getEmptyEstate();
          return;
        }
        // Phase 2: bind to the first estate. Phase 4 will add a sidebar
        // selector for multi-estate users; the integration point is here
        // (just change _currentEstateId and re-run initAsync from scratch).
        var estate = estates[0];
        this._currentEstateId = estate.id;
        this._cache = this._normalize(estate._doc);
      } catch (e) {
        console.error('[EstatePro] App.Data.initAsync failed:', e);
        this._cache = this.getEmptyEstate();
      }
    },

    _normalize(doc) {
      // Make sure the cache has every expected collection field with sane
      // defaults so a render loop can rely on .tasks, .assets etc. always
      // being arrays (instead of undefined). Top-level extras (memberIds,
      // roles, __founderSecret, createdBy, createdAt, pendingInvites) are
      // preserved on the cache so the round-trip flush in _flush() doesn't
      // silently strip them — Firestore's ruleset requires these to stay
      // byte-for-byte equal to keep allow update: true.
      var base = this.getEmptyEstate();
      if (!doc || typeof doc !== 'object') return base;
      var baseKeys = Object.keys(base);
      for (var i = 0; i < baseKeys.length; i++) {
        var k = baseKeys[i];
        if (doc[k] !== undefined) base[k] = doc[k];
      }
      var extraKeys = Object.keys(doc);
      for (var j = 0; j < extraKeys.length; j++) {
        var ek = extraKeys[j];
        if (ek in base) continue;
        base[ek] = doc[ek];
      }
      ['tasks', 'assets', 'debts', 'cashflow', 'heirs', 'distributions'].forEach(function (k) {
        if (!Array.isArray(base[k])) base[k] = [];
      });
      if (!base.decedent || typeof base.decedent !== 'object') base.decedent = {};
      if (!base.executor  || typeof base.executor  !== 'object') base.executor = {};
      return base;
    },

    isReady() {
      // True iff initAsync succeeded and bound an estate doc id.
      return !!(this._cache && this._currentEstateId);
    },

    getEstate() {
      // Synchronous getter for render loops. Returns the cache when bound;
      // otherwise a stable empty-shape so the page doesn't crash before
      // initAsync has had a chance to run.
      return this._cache || this.getEmptyEstate();
    },

    saveEstate(estate, immediate) {
      // Writes through to the cache (source of truth for the UI), then
      // schedules a debounced Firestore update. Pass `immediate = true`
      // for deletes (you don't want a 500ms window where the deleted row
      // could come back from a stale cloud read). Returns a Promise that
      // resolves once the Firestore round-trip is done (or after the
      // debounce timer fires).
      this._cache = estate;
      if (immediate) return this.flushNow();
      var self = this;
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      return new Promise(function (resolve) {
        self._debounceTimer = setTimeout(function () {
          self._debounceTimer = null;
          self.flushNow().then(resolve).catch(function (err) {
            console.error('[EstatePro] data debounced flush failed:', err);
            resolve();
          });
        }, 500);
      });
    },

    flushNow() {
      // Flushes the current cache to Firestore (or localStorage fallback)
      // immediately. Used by saveEstate(immediate=true), by clearAllEstateData,
      // and by beforeunload via App._pendingWrites accounting.
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      return this._flush();
    },

    async _flush() {
      // The actual write. Best-effort: if Firestore isn't available OR
      // we're not bound to a currentEstateId, we mirror the cache into
      // localStorage so a subsequent reload can recover offline.
      if (!this._cache) return;
      if (!this._currentEstateId || !App.Firebase || !App.Firebase.db) {
        try { await App.Crypto.writeStorage('estatepro_estate', this._cache); }
        catch (e) { /* ignore */ }
        return;
      }
      var payload;
      try { payload = JSON.parse(JSON.stringify(this._cache)); }
      catch (e) { console.error('[EstatePro] _flush: cannot serialize cache', e); return; }
      // Stamp updatedAt so multi-device users can tell which copy is newer.
      payload.updatedAt = new Date().toISOString();
      try {
        await App.Firebase.db.collection('estates').doc(this._currentEstateId).update(payload);
      } catch (e) {
        console.error('[EstatePro] _flush failed for estate', this._currentEstateId, e);
        // Mirror to localStorage so we don't lose state on next reload.
        try { await App.Crypto.writeStorage('estatepro_estate', this._cache); } catch (_) {}
        throw e;
      }
    },

    getEmptyEstate() {
      return JSON.parse(JSON.stringify({
        decedent: {},
        executor:  {},
        tasks: [],
        assets: [],
        debts: [],
        cashflow: [],
        heirs: [],
        distributions: []
      }));
    },

    getNextId(array) {
      if (!array || array.length === 0) return 1;
      return Math.max(...array.map(function (item) { return item.id || 0; })) + 1;
    },

    async    reloadFromStorage() {
      // Phase 2 helper used by `pageshow` bfcache listeners on the
      // dashboard and distributions pages. Re-pulls the bound Firestore
      // estate doc so the in-memory cache reflects any out-of-band changes
      // that happened while the page was in the bfcache. No-op when no
      // estate is bound yet (e.g. during bootstrap).
      try {
        await this.initAsync();
      } catch (e) {
        console.warn('[EstatePro] Data.reloadFromStorage:', e && e.message ? e.message : e);
      }
    },

    // ---- Phase 4: switch active estate ----
    // Called from App.UI.initEstateSelector when the user picks a different
    // estate in the sidebar dropdown. Re-binds the cache and reloads the
    // page so every render loop starts fresh against the new doc. We use a
    // full reload (rather than an in-place re-render) because Phase 2's
    // render functions captured closures over the cached `estate.decedent`,
    // `estate.assets`, etc. on page mount; a reload resets those.
    async switchEstate(estateId) {
      if (!estateId) return;
      if (this._currentEstateId === estateId) return;
      this._currentEstateId = estateId;
      try { await this.initAsync(); } catch (e) { console.warn('switchEstate initAsync failed:', e && e.message); }
      try {
        sessionStorage.setItem('estatepro_active_estate', estateId);
      } catch (e) { /* ignore */ }
      window.location.reload();
    },

    // Phase 4 helper -- expose the active estate id for UI elements.
    getCurrentEstateId() { return this._currentEstateId; },

    async clearAllEstateData() {
      // Replaces the entire cache with an empty estate AND flushes that to
      // Firestore immediately so the next device sync shows the wipe.
      this._cache = this.getEmptyEstate();
      try { await this.flushNow(); }
      catch (e) { console.error('[EstatePro] clearAllEstateData flush failed:', e); }
      return { success: true, message: 'All estate data has been cleared. The estate is now empty.' };
    }
  },

  /* ============================
     EXPORT
     ============================ */
  Export: {
    toCSV(data, filename) {
      if (!data || data.length === 0) return;
      const headers = Object.keys(data[0]);
      const csvContent = [
        headers.join(','),
        ...data.map(row =>
          headers.map(h => {
            let val = row[h] ?? '';
            val = String(val).replace(/"/g, '""');
            if (val.includes(',') || val.includes('\n') || val.includes('"')) {
              val = `"${val}"`;
            }
            return val;
          }).join(',')
        )
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    },

    printPDF() {
      window.print();
    }
  },

  /* ============================
     BACKUP REMINDER
     ============================ */
  BackupReminder: {
    getLastBackup() {
      return localStorage.getItem('estatepro_last_backup');
    },

    setLastBackup() {
      localStorage.setItem('estatepro_last_backup', new Date().toISOString());
    },

    getDismissedUntil() {
      const val = localStorage.getItem('estatepro_backup_dismissed');
      return val ? parseInt(val, 10) : 0;
    },

    setDismissedUntil(hours) {
      const ms = hours * 60 * 60 * 1000;
      localStorage.setItem('estatepro_backup_dismissed', String(Date.now() + ms));
    },

    getReminderInterval() {
      const val = localStorage.getItem('estatepro_backup_interval');
      const defaultInterval = 7 * 24 * 60 * 60 * 1000;
      if (!val) return defaultInterval;
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? defaultInterval : parsed;
    },

    setReminderInterval(days) {
      localStorage.setItem('estatepro_backup_interval', String(days * 24 * 60 * 60 * 1000));
    },

    shouldShowReminder() {
      if (!App.Auth.isLoggedIn()) return false;
      const lastBackup = this.getLastBackup();
      const dismissedUntil = this.getDismissedUntil();
      const now = Date.now();
      if (dismissedUntil > now) return false;
      const interval = this.getReminderInterval();
      if (!lastBackup) return true;
      const lastBackupTime = new Date(lastBackup).getTime();
      return (now - lastBackupTime) > interval;
    },

    getDaysSinceLastBackup() {
      const lastBackup = this.getLastBackup();
      if (!lastBackup) return Infinity;
      const diff = Date.now() - new Date(lastBackup).getTime();
      return Math.floor(diff / (1000 * 60 * 60 * 24));
    }
  },

  /* ============================
     SYNC - JSON EXPORT/IMPORT
     ============================ */
  Sync: {
    // === Phase 2 export sanitization ===
    // The live Firestore-backed estate doc on App.Data._cache now contains
    // structural/auth fields that should NEVER leave the browser as part of a
    // user-facing backup:  __founderSecret, memberIds, roles, pendingInvites,
    // createdBy, createdAt.  These are server-side enforcement metadata, not
    // user data; including them in export JSON leaks the founder-secret hash
    // (anyone with the original secret + hash could try to forge a second
    // Phase-1-style bootstrap if the ruleset is later weakened) and the
    // memberIds/roles map (who has access).  This helper shallow-copies the
    // doc and deletes those top-level keys *without* mutating the live cache.
    // Nested arrays (assets/debts/cashflow/heirs/tasks) are shared by
    // reference with the live cache; that's fine because JSON.stringify is
    // read-only and the export is a snapshot at serialization time.
    _STRUCTURAL_EXPORT_FIELDS: ['__founderSecret', 'memberIds', 'roles', 'pendingInvites', 'createdBy', 'createdAt', '_currentEstateId'],
    _sanitizeEstateForExport(estate) {
      if (!estate || typeof estate !== 'object') return estate;
      var copy = Object.assign({}, estate);
      this._STRUCTURAL_EXPORT_FIELDS.forEach(function (k) { delete copy[k]; });
      return copy;
    },

    getExportData() {
      const estate = App.Data.getEstate();
      const users = App.Auth.getUsers();
      const session = App.Auth.getCurrentUser();
      const darkMode = localStorage.getItem('estatepro_darkmode');
      return {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        exportedBy: session ? session.username : 'unknown',
        estate: this._sanitizeEstateForExport(estate),
        users: users,
        preferences: {
          darkMode: darkMode === 'true'
        }
      };
    },

    async exportAll() {
      const data = this.getExportData();
      let exportContent;
      if (App.Crypto.isEncryptionEnabled() && App.Crypto.hasPassphrase()) {
        const envelope = await App.Crypto.encrypt(JSON.stringify(data, null, 2), App.Crypto.getPassphrase());
        exportContent = JSON.stringify(envelope, null, 2);
      } else {
        exportContent = JSON.stringify(data, null, 2);
      }
      const blob = new Blob([exportContent], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      link.download = `estatepro-backup-${date}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      App.BackupReminder.setLastBackup();
    },

    async exportEstateOnly() {
      // Phase 2: also flow through the sanitizer so Estate-Only export
      // doesn't leak __founderSecret / memberIds / roles / etc.  Without
      // this, only exportAll() (which goes through getExportData) would be
      // sanitized and this path would ship the raw Firestore doc.
      const estate = this._sanitizeEstateForExport(App.Data.getEstate());
      let exportContent;
      if (App.Crypto.isEncryptionEnabled() && App.Crypto.hasPassphrase()) {
        const envelope = await App.Crypto.encrypt(JSON.stringify(estate, null, 2), App.Crypto.getPassphrase());
        exportContent = JSON.stringify(envelope, null, 2);
      } else {
        exportContent = JSON.stringify(estate, null, 2);
      }
      const blob = new Blob([exportContent], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      const date = new Date().toISOString().split('T')[0];
      link.download = `estatepro-estate-${date}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      App.BackupReminder.setLastBackup();
    },

    validateImportData(data) {
      if (!data || typeof data !== 'object') return { valid: false, error: 'Invalid JSON file' };
      if (!data.estate && !data.assets) return { valid: false, error: 'No estate data found in file' };
      if (data.estate && typeof data.estate === 'object') {
        return { valid: true, hasUsers: !!data.users, isFullBackup: true, data: data };
      }
      if (data.assets && Array.isArray(data.assets)) {
        return { valid: true, hasUsers: false, isFullBackup: false, data: { estate: data } };
      }
      return { valid: false, error: 'Unrecognized data format' };
    },

    async importFromFile(file, passphrase) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            let json = JSON.parse(e.target.result);
            // Check if it's an encrypted backup envelope
            if (json && json.ct && json.algo) {
              const availablePassphrase = passphrase || App.Crypto.getPassphrase();
              if (!availablePassphrase) {
                resolve({ success: false, needsPassphrase: true, message: 'This backup is encrypted. Please enter the passphrase used when the backup was created.' });
                return;
              }
              try {
                const decrypted = await App.Crypto.decrypt(json, availablePassphrase);
                json = JSON.parse(decrypted);
              } catch (err) {
                resolve({ success: false, message: 'Failed to decrypt backup: ' + err.message });
                return;
              }
            }
            const validation = this.validateImportData(json);
            if (!validation.valid) {
              resolve({ success: false, message: validation.error });
              return;
            }
            resolve({ success: true, validation: validation });
          } catch (err) {
            resolve({ success: false, message: 'Invalid JSON file: ' + err.message });
          }
        };
        reader.onerror = () => {
          resolve({ success: false, message: 'Failed to read file' });
        };
        reader.readAsText(file);
      });
    },

    applyImport(validation, options = {}) {
      const { data, isFullBackup } = validation;
      try {
        if (data.estate) {
          App.Data.saveEstate(data.estate);
        }
        if (options.includeUsers && isFullBackup && data.users && Array.isArray(data.users)) {
          const localUsers = App.Auth.getUsers();
          const localUsersMap = new Map(localUsers.map(u => [u.username, u]));
          data.users.forEach(backupUser => {
            localUsersMap.set(backupUser.username, backupUser);
          });
          App.Auth.saveUsers(Array.from(localUsersMap.values()));
        }
        if (isFullBackup && data.preferences && data.preferences.darkMode !== undefined) {
          localStorage.setItem('estatepro_darkmode', String(data.preferences.darkMode));
          if (data.preferences.darkMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
          App.DarkMode.updateToggleIcon();
        }
        return { success: true, message: 'Data imported successfully. The page will refresh.' };
      } catch (err) {
        return { success: false, message: 'Import failed: ' + err.message };
      }
    }
  },

  /* ============================
     DARK MODE
     ============================ */
  DarkMode: {
    init() {
      const saved = localStorage.getItem('estatepro_darkmode');
      if (saved === 'true') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
      this.updateToggleIcon();
    },

    toggle() {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('estatepro_darkmode', 'false');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('estatepro_darkmode', 'true');
      }
      this.updateToggleIcon();
    },

    updateToggleIcon() {
      const btn = document.getElementById('darkModeToggle');
      if (!btn) return;
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.innerHTML = isDark ? this.getSunIcon() : this.getMoonIcon();
      btn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    },

    getMoonIcon() {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
    },

    getSunIcon() {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    }
  },

  /* ============================
     UI HELPERS
     ============================ */
  UI: {
    init() {
      // Sidebar navigation highlighting
      const currentPage = window.location.pathname.split('/').pop() || 'index.html';
      document.querySelectorAll('.sidebar-nav a').forEach(link => {
        const href = link.getAttribute('href');
        if (href === currentPage || (currentPage === '' && href === 'index.html')) {
          link.classList.add('active');
        }
      });

      // Dark mode
      App.DarkMode.init();
      const darkModeBtn = document.getElementById('darkModeToggle');
      if (darkModeBtn) {
        darkModeBtn.addEventListener('click', () => App.DarkMode.toggle());
      }

      // Mobile sidebar toggle
      const mobileToggle = document.getElementById('mobileToggle');
      const sidebar = document.getElementById('sidebar');
      const sidebarOverlay = document.getElementById('sidebarOverlay');
      if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
          const isOpen = sidebar.classList.toggle('open');
          sidebarOverlay.classList.toggle('active');
          mobileToggle.setAttribute('aria-expanded', String(isOpen));
        });
      }
      if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
          sidebar.classList.remove('open');
          sidebarOverlay.classList.remove('active');
          if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
        });
      }

      // Apply permissions
      this.applyPermissions();

      // Init sync/share UI
      this.initSyncUI();

      // Show backup reminder if needed
      this.showBackupReminder();

      // Init user menu dropdown on logged-in pages
      this.initUserMenu();

      // Phase 4: sidebar estate selector. No-op on pages that don't have the
      // selector slot, and hidden when the user has only one estate.
      this.initEstateSelector();

      // Notify ready callbacks
      App._setReady();
    },

    applyPermissions() {
      const canEdit = App.Permissions.canEdit();
      const canManage = App.Permissions.canManageUsers();
      document.body.setAttribute('data-can-edit', canEdit);
      document.body.setAttribute('data-can-manage', canManage);

      // Disable form inputs for read-only users (skip login page)
      if (!canEdit && !document.body.classList.contains('login-page')) {
        document.querySelectorAll('form .form-input, form .form-select, form .form-textarea').forEach(el => {
          el.disabled = true;
        });
      }
    },

    showAlert(container, message, type = 'danger') {
      const alert = document.createElement('div');
      alert.className = `alert alert-${type}`;
      alert.innerHTML = message;
      container.prepend(alert);
      setTimeout(() => alert.remove(), 5000);
    },

    formatCurrency(amount) {
      if (amount === null || amount === undefined || amount === '') return '$0.00';
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
    },

    formatDate(dateStr) {
      if (!dateStr) return '-';
      const d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    },

    escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    // Modal helpers
    openModal(modalId) {
      const el = document.getElementById(modalId);
      if (el) el.classList.add('active');
    },

    closeModal(modalId) {
      const el = document.getElementById(modalId);
      if (el) el.classList.remove('active');
    },

    // Passphrase modal
    renderPassphraseModal() {
      if (document.getElementById('passphraseModal')) return;
      const modal = document.createElement('div');
      modal.id = 'passphraseModal';
      modal.className = 'modal-overlay active';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = `
        <div class="modal" style="max-width:400px;">
          <div class="modal-header">
            <div class="modal-title">Enter Passphrase</div>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
              This estate is encrypted. Please enter your passphrase to unlock your data.
            </p>
            <form id="passphraseForm">
              <div class="form-group">
                <label class="form-label" for="passphraseInput">Passphrase</label>
                <input type="password" id="passphraseInput" class="form-input" placeholder="Enter your passphrase" required>
              </div>
              <div class="btn-group">
                <button type="submit" class="btn btn-primary">Unlock</button>
              </div>
            </form>
            <div id="passphraseError" style="margin-top:1rem;"></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    showPassphraseModal(onSubmit) {
      this.renderPassphraseModal();
      const form = document.getElementById('passphraseForm');
      const error = document.getElementById('passphraseError');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const passphrase = document.getElementById('passphraseInput').value;
        const valid = await App.Crypto.verifyPassphrase(passphrase);
        if (valid) {
          await App.Crypto.setPassphrase(passphrase);
          App.Crypto.savePassphraseToSession();
          this.closeModal('passphraseModal');
          if (onSubmit) onSubmit(passphrase);
        } else {
          error.innerHTML = '<div class="alert alert-danger">Invalid passphrase. Please try again.</div>';
        }
      };
    },

    // Passphrase prompt for importing encrypted backups (no local verification needed)
    renderImportPassphraseModal() {
      if (document.getElementById('importPassphraseModal')) return;
      const modal = document.createElement('div');
      modal.id = 'importPassphraseModal';
      modal.className = 'modal-overlay active';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.innerHTML = `
        <div class="modal" style="max-width:400px;">
          <div class="modal-header">
            <div class="modal-title">Enter Backup Passphrase</div>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
              This backup is encrypted. Please enter the passphrase that was used when the backup was created.
            </p>
            <form id="importPassphraseForm">
              <div class="form-group">
                <label class="form-label" for="importPassphraseInput">Passphrase</label>
                <input type="password" id="importPassphraseInput" class="form-input" placeholder="Enter backup passphrase" required>
              </div>
              <div class="btn-group">
                <button type="submit" class="btn btn-primary">Unlock Backup</button>
                <button type="button" class="btn btn-secondary" id="importPassphraseCancel">Cancel</button>
              </div>
            </form>
            <div id="importPassphraseError" style="margin-top:1rem;"></div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    showImportPassphraseModal(onSubmit) {
      this.renderImportPassphraseModal();
      const form = document.getElementById('importPassphraseForm');
      const error = document.getElementById('importPassphraseError');
      const cancelBtn = document.getElementById('importPassphraseCancel');
      const submitBtn = form.querySelector('button[type="submit"]');
      form.onsubmit = async (e) => {
        e.preventDefault();
        const passphrase = document.getElementById('importPassphraseInput').value;
        if (!passphrase) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Unlocking...';
        try {
          if (onSubmit) await onSubmit(passphrase);
          this.closeModal('importPassphraseModal');
        } catch (err) {
          error.innerHTML = '<div class="alert alert-danger">' + App.UI.escapeHtml(err.message || 'Failed to decrypt backup.') + '</div>';
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Unlock Backup';
        }
      };
      cancelBtn.onclick = () => {
        this.closeModal('importPassphraseModal');
      };
    },

    // ---- Phase 4: sidebar estate selector ----
    // Builds a <select> inside the .sidebar-estate-selector slot. Populates
    // it from App.Auth.getMyEstates(). On change, calls App.Data.switchEstate
    // which re-binds the cache and reloads the page. Hidden when only one
    // estate exists -- no need to clutter the sidebar.
    async initEstateSelector() {
      var slot = document.getElementById('sidebarEstateSelector');
      if (!slot) return; // page has no selector slot
      try {
        var estates = await App.Auth.getMyEstates();
      } catch (e) {
        console.warn('[EstatePro] initEstateSelector getMyEstates failed:', e && e.message);
        estates = [];
      }
      if (!estates || estates.length <= 1) {
        slot.style.display = 'none';
        return;
      }
      slot.style.display = '';
      var sel = slot.querySelector('#estateSelect');
      if (!sel) return;
      sel.innerHTML = estates.map(function (e) {
        var name = (e._doc && (e._doc.name || e._doc.title)) || ('Estate ' + e.id.substring(0, 6));
        var selected = App.Data && App.Data._currentEstateId === e.id;
        return '<option value="' + App.UI.escapeHtml(e.id) + '"' + (selected ? ' selected' : '') + '>' + App.UI.escapeHtml(name) + '</option>';
      }).join('');
      sel.onchange = function () {
        var v = sel.value;
        if (!v) return;
        App.Data.switchEstate(v);
      };
    },

    // User menu dropdown
    initUserMenu() {
      if (document.body.classList.contains('login-page')) return;
      const userInfo = document.querySelector('.user-info');
      if (!userInfo) return;
      if (userInfo.querySelector('.user-menu-dropdown')) return;

      userInfo.style.position = 'relative';
      userInfo.style.cursor = 'pointer';
      userInfo.setAttribute('title', 'Click for user menu');
      userInfo.setAttribute('tabindex', '0');
      userInfo.setAttribute('role', 'button');
      userInfo.setAttribute('aria-haspopup', 'true');
      userInfo.setAttribute('aria-expanded', 'false');

      const dropdown = document.createElement('div');
      dropdown.className = 'user-menu-dropdown';
      dropdown.style.cssText = 'display:none; position:absolute; top:calc(100% + 0.5rem); right:0; background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius); box-shadow:0 4px 12px rgba(0,0,0,0.15); min-width:200px; z-index:1000; padding:0.5rem 0; font-size:0.9rem;';
      dropdown.innerHTML = `
        <div class="user-menu-header" style="padding:0.5rem 1rem; border-bottom:1px solid var(--border-color); color:var(--text-secondary); font-size:0.8rem;">
          <div id="userMenuName" style="font-weight:600; color:var(--text-primary);"></div>
          <div id="userMenuRole" style="font-size:0.75rem;"></div>
        </div>
        <button type="button" class="user-menu-item" id="userMenuChangePassword" style="display:block; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--text-primary); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0110 0v4"></path></svg>
          Change Password
        </button>
        <button type="button" class="user-menu-item" id="userMenuPromoteAdmin" style="display:none; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--text-primary); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
          Promote to Admin
        </button>
        <button type="button" class="user-menu-item" id="userMenuClearData" style="display:none; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--danger-color); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
          Clear All Estate Data
        </button>
        <button type="button" class="user-menu-item" onclick="App.Auth.logout()" style="display:block; width:100%; text-align:left; padding:0.5rem 1rem; background:none; border:none; cursor:pointer; color:var(--text-primary); font-size:0.9rem;">
          <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem;"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          Logout
        </button>
      `;
      userInfo.appendChild(dropdown);

      const currentUser = App.Auth.getCurrentUser();
      if (currentUser) {
        const nameEl = dropdown.querySelector('#userMenuName');
        const roleEl = dropdown.querySelector('#userMenuRole');
        if (nameEl) nameEl.textContent = currentUser.name;
        if (roleEl) roleEl.textContent = App.Permissions.getRoleLabel(currentUser.role);
      }

      const promoteBtn = dropdown.querySelector('#userMenuPromoteAdmin');
      if (promoteBtn && currentUser && currentUser.role === 'Executor') {
        const users = App.Auth.getUsers();
        const hasAdmin = users.some(u => u.role === 'Admin');
        if (!hasAdmin) {
          promoteBtn.style.display = 'block';
        }
      }

      const clearDataBtn = dropdown.querySelector('#userMenuClearData');
      if (clearDataBtn && currentUser && currentUser.role === 'Admin') {
        clearDataBtn.style.display = 'block';
      }

      const toggleDropdown = (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display === 'block';
        dropdown.style.display = isOpen ? 'none' : 'block';
        userInfo.setAttribute('aria-expanded', String(!isOpen));
      };

      userInfo.addEventListener('click', toggleDropdown);
      userInfo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleDropdown(e);
        }
      });

      document.addEventListener('click', (e) => {
        if (!userInfo.contains(e.target)) {
          dropdown.style.display = 'none';
          userInfo.setAttribute('aria-expanded', 'false');
        }
      });

      dropdown.querySelector('#userMenuChangePassword').addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.style.display = 'none';
        userInfo.setAttribute('aria-expanded', 'false');
        this.showChangePasswordModal();
      });

      if (promoteBtn) {
        promoteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          dropdown.style.display = 'none';
          userInfo.setAttribute('aria-expanded', 'false');
          if (!confirm('Promote your account to Admin? This will give you full access to user management and all settings.')) return;
          const result = await App.Auth.promoteSelfToAdmin();
          if (result.success) {
            alert(result.message + ' The page will refresh to apply changes.');
            window.location.reload();
          } else {
            alert(result.message);
          }
        });
      }

      if (clearDataBtn) {
        clearDataBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          dropdown.style.display = 'none';
          userInfo.setAttribute('aria-expanded', 'false');
          if (!confirm('WARNING: This will permanently delete all estate data (assets, debts, tasks, cashflow, heirs, distributions).\n\nUser accounts and login sessions will NOT be affected.\n\nThis action cannot be undone. Are you sure?')) return;
          const result = await App.Data.clearAllEstateData();
          if (result.success) {
            alert(result.message + ' The page will refresh to apply changes.');
            window.location.reload();
          } else {
            alert(result.message);
          }
        });
      }
    },

    // Change Password Modal
    renderChangePasswordModal() {
      if (document.getElementById('changePasswordModal')) return;
      const modal = document.createElement('div');
      modal.id = 'changePasswordModal';
      modal.className = 'modal-overlay';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'changePasswordTitle');
      modal.innerHTML = `
        <div class="modal" style="max-width:400px;">
          <div class="modal-header">
            <div class="modal-title" id="changePasswordTitle">Change Password</div>
            <button type="button" class="modal-close" onclick="App.UI.closeModal('changePasswordModal')" aria-label="Close change password modal">&times;</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">Enter your current password and choose a new one.</p>
            <div class="form-group">
              <label class="form-label" for="changePasswordCurrent">Current Password</label>
              <input type="password" id="changePasswordCurrent" class="form-input" placeholder="Enter current password" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="changePasswordNew">New Password</label>
              <input type="password" id="changePasswordNew" class="form-input" placeholder="Choose a new password" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="changePasswordConfirm">Confirm New Password</label>
              <input type="password" id="changePasswordConfirm" class="form-input" placeholder="Confirm new password" required>
            </div>
            <div id="changePasswordMessage"></div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="App.UI.closeModal('changePasswordModal')">Cancel</button>
            <button type="button" class="btn btn-primary" id="changePasswordSubmitBtn">Change Password</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    },

    showChangePasswordModal() {
      this.renderChangePasswordModal();
      document.getElementById('changePasswordCurrent').value = '';
      document.getElementById('changePasswordNew').value = '';
      document.getElementById('changePasswordConfirm').value = '';
      document.getElementById('changePasswordMessage').innerHTML = '';
      this.openModal('changePasswordModal');

      const submitBtn = document.getElementById('changePasswordSubmitBtn');
      submitBtn.onclick = async () => {
        const current = document.getElementById('changePasswordCurrent').value;
        const newPass = document.getElementById('changePasswordNew').value;
        const confirm = document.getElementById('changePasswordConfirm').value;
        const msg = document.getElementById('changePasswordMessage');

        if (!current || !newPass || !confirm) {
          msg.innerHTML = '<div class="alert alert-danger">All fields are required.</div>';
          return;
        }
        if (newPass !== confirm) {
          msg.innerHTML = '<div class="alert alert-danger">New passwords do not match.</div>';
          return;
        }
        if (newPass.length < 6) {
          msg.innerHTML = '<div class="alert alert-danger">New password must be at least 6 characters.</div>';
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Changing...';
        try {
          const result = await App.Auth.changeOwnPassword(current, newPass);
          if (result.success) {
            msg.innerHTML = '<div class="alert alert-success">' + App.UI.escapeHtml(result.message) + '</div>';
            setTimeout(() => {
              this.closeModal('changePasswordModal');
            }, 2000);
          } else {
            msg.innerHTML = '<div class="alert alert-danger">' + App.UI.escapeHtml(result.message) + '</div>';
          }
        } catch (err) {
          msg.innerHTML = '<div class="alert alert-danger">An error occurred. Please try again.</div>';
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Change Password';
        }
      };
    },

    // Tab helpers
    initTabs(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const tabs = container.querySelectorAll('.tab');
      let panels = container.querySelectorAll('.tab-panel');
      let panelScope = container;
      if (panels.length === 0) {
        panelScope = container.closest('.modal') || container.parentElement;
        panels = panelScope.querySelectorAll('.tab-panel');
      }
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.tab;
          tabs.forEach(t => t.classList.remove('active'));
          panels.forEach(p => p.classList.remove('active'));
          tab.classList.add('active');
          const panel = panelScope.querySelector(`[data-panel="${target}"]`);
          if (panel) panel.classList.add('active');
        });
      });
    },

    initSyncUI() {
      const headerRight = document.querySelector('.header-right');
      if (headerRight) {
        const existing = document.getElementById('syncBtn');
        if (!existing) {
          const syncBtn = document.createElement('button');
          syncBtn.id = 'syncBtn';
          syncBtn.className = 'btn-icon';
          syncBtn.title = 'Sync & Share';
          syncBtn.setAttribute('aria-label', 'Open sync and share settings');
          syncBtn.innerHTML = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`;
          syncBtn.addEventListener('click', () => this.showSyncModal());
          const darkModeBtn = document.getElementById('darkModeToggle');
          if (darkModeBtn) {
            headerRight.insertBefore(syncBtn, darkModeBtn);
          } else {
            headerRight.appendChild(syncBtn);
          }
        }
      }

      const loginCard = document.querySelector('.login-card');
      if (loginCard) {
        const existing = document.getElementById('loginImportBtn');
        if (!existing) {
          const importBtn = document.createElement('button');
          importBtn.id = 'loginImportBtn';
          importBtn.className = 'btn btn-secondary';
          importBtn.style = 'width:100%; margin-top:0.5rem;';
          importBtn.innerHTML = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Import Estate Backup`;
          importBtn.addEventListener('click', () => this.showSyncModal('import'));
          const toggle = loginCard.querySelector('.login-toggle');
          if (toggle) {
            toggle.parentNode.insertBefore(importBtn, toggle.nextSibling);
          }
        }
      }

      this.renderSyncModal();
      this.initSyncModal();
    },

    renderSyncModal() {
      if (document.getElementById('syncModal')) return;
      const modal = document.createElement('div');
      modal.id = 'syncModal';
      modal.className = 'modal-overlay';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'syncModalTitle');
      modal.innerHTML = `
        <div class="modal sync-modal">
          <div class="modal-header">
            <div class="modal-title" id="syncModalTitle">Sync & Share</div>
            <button type="button" class="modal-close" onclick="App.UI.closeModal('syncModal')" aria-label="Close sync modal">&times;</button>
          </div>
          <div class="modal-body">
            <div class="tabs sync-tabs" id="syncTabs">
              <button type="button" class="tab active" data-tab="export">Export</button>
              <button type="button" class="tab" data-tab="import">Import</button>
              <button type="button" class="tab" data-tab="security">Security</button>
            </div>

            <div class="tab-panel active" data-panel="export">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Export all your estate data as a backup file that can be shared with other users.
              </p>
              <p style="margin-bottom:1rem; font-size:0.8rem; color:var(--danger-color);">
                <strong>Note:</strong> Full backup includes user login credentials (passwords are hashed).
              <div class="btn-group" style="margin-bottom:1rem;">
                <button type="button" class="btn btn-primary" id="syncExportFull">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  Export Full Backup (with users)
                </button>
                <button type="button" class="btn btn-secondary" id="syncExportEstate">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                  Export Estate Only
                </button>
              </div>
              <div id="syncExportStatus" class="sync-status"></div>
            </div>

            <div class="tab-panel" data-panel="import">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Import an estate backup file. This will replace your current data. Preview before confirming.
              </p>
              <div class="file-drop-zone" id="fileDropZone" role="button" tabindex="0" aria-label="Drop zone for importing estate backup JSON file">
                <div class="file-drop-zone-icon">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                </div>
                <div class="file-drop-zone-text">Drop a .json backup file here, or <span class="file-drop-zone-browse">browse</span></div>
                <input type="file" id="syncImportFile" accept=".json,application/json" style="display:none;">
              </div>
              <div id="syncImportPreview" class="sync-preview" style="display:none;"></div>
              <div id="syncImportStatus" class="sync-status"></div>
              <div class="form-group" style="margin-top:1rem;">
                <label class="form-label" style="display:flex; align-items:center; gap:0.5rem;">
                  <input type="checkbox" id="syncImportIncludeUsers">
                  <span>Include user accounts (logins) from backup</span>
                </label>
              </div>
              <div class="btn-group" style="margin-top:1rem;">
                <button type="button" class="btn btn-primary" id="syncImportConfirm" disabled>Confirm Import</button>
                <button type="button" class="btn btn-secondary" id="syncImportCancel">Cancel</button>
              </div>
            </div>

            <div class="tab-panel" data-panel="security">
              <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">
                Protect your estate data with a passphrase. Encrypted backups are unreadable without the passphrase.
              </p>
              <div id="securitySetPassphrase" style="display:none;">
                <div class="form-group">
                  <label class="form-label" for="newPassphrase">New Passphrase</label>
                  <input type="password" id="newPassphrase" class="form-input" placeholder="Choose a strong passphrase">
                </div>
                <div class="form-group">
                  <label class="form-label" for="confirmPassphrase">Confirm Passphrase</label>
                  <input type="password" id="confirmPassphrase" class="form-input" placeholder="Confirm passphrase">
                </div>
                <button type="button" class="btn btn-primary" id="setPassphraseBtn">Enable Encryption</button>
              </div>
              <div id="securityChangePassphrase" style="display:none;">
                <div class="form-group">
                  <label class="form-label" for="currentPassphrase">Current Passphrase</label>
                  <input type="password" id="currentPassphrase" class="form-input" placeholder="Enter current passphrase">
                </div>
                <div class="form-group">
                  <label class="form-label" for="changeNewPassphrase">New Passphrase</label>
                  <input type="password" id="changeNewPassphrase" class="form-input" placeholder="Choose a new passphrase">
                </div>
                <div class="form-group">
                  <label class="form-label" for="changeConfirmPassphrase">Confirm New Passphrase</label>
                  <input type="password" id="changeConfirmPassphrase" class="form-input" placeholder="Confirm new passphrase">
                </div>
                <div class="btn-group">
                  <button type="button" class="btn btn-primary" id="changePassphraseBtn">Change Passphrase</button>
                  <button type="button" class="btn btn-danger" id="disableEncryptionBtn">Disable Encryption</button>
                </div>
              </div>
              <div id="securityStatus" class="sync-status"></div>

              <div class="danger-zone" style="margin-top:2rem; padding:1rem; border:1px solid var(--danger-color); border-radius:var(--radius); background:rgba(239,68,68,0.05);">
                <div style="font-weight:600; color:var(--danger-color); margin-bottom:0.5rem; display:flex; align-items:center; gap:0.5rem;">
                  <svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                  Danger Zone
                </div>
                <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.85rem;">
                  Admin-only actions that permanently affect estate data.
                </p>
                <button type="button" class="btn btn-danger" id="clearAllEstateDataBtn">
                  <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
                  Clear All Estate Data
                </button>
                <div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.5rem;">
                  This removes all estate data (assets, debts, tasks, cashflow, heirs, distributions). User accounts and sessions are preserved.
                </div>
              </div>
            </div>

          </div>
        </div>
      `;
      document.body.appendChild(modal);
      this.initTabs('syncTabs');
    },

    initSyncModal() {
      this.initExportHandlers();
      this.initImportHandlers();
      this.initSecurityHandlers();
    },

    initSecurityHandlers() {
      const setPanel = document.getElementById('securitySetPassphrase');
      const changePanel = document.getElementById('securityChangePassphrase');
      const setBtn = document.getElementById('setPassphraseBtn');
      const changeBtn = document.getElementById('changePassphraseBtn');
      const disableBtn = document.getElementById('disableEncryptionBtn');
      const status = document.getElementById('securityStatus');

      const updateSecurityUI = () => {
        const encrypted = App.Crypto.isEncryptionEnabled();
        if (setPanel) setPanel.style.display = encrypted ? 'none' : 'block';
        if (changePanel) changePanel.style.display = encrypted ? 'block' : 'none';
        if (status) status.innerHTML = encrypted ? '<div class="alert alert-success">Encryption is enabled. All backups and localStorage are encrypted.</div>' : '<div class="alert alert-info">Encryption is not enabled. Your data is stored in plaintext.</div>';
      };

      // Update UI when security tab is shown
      const tabs = document.querySelectorAll('#syncTabs .tab');
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          if (tab.dataset.tab === 'security') {
            updateSecurityUI();
          }
        });
      });

      if (setBtn) {
        setBtn.addEventListener('click', async () => {
          const newPass = document.getElementById('newPassphrase').value;
          const confirmPass = document.getElementById('confirmPassphrase').value;
          if (!newPass || newPass.length < 6) {
            this.showSyncStatus('securityStatus', 'Passphrase must be at least 6 characters.', 'danger');
            return;
          }
          if (newPass !== confirmPass) {
            this.showSyncStatus('securityStatus', 'Passphrases do not match.', 'danger');
            return;
          }
          this.showSyncStatus('securityStatus', 'Encrypting data...', 'info');
          try {
            const result = await App.Crypto.setupEncryption(newPass);
            this.showSyncStatus('securityStatus', result.message, 'success');
            updateSecurityUI();
            document.getElementById('newPassphrase').value = '';
            document.getElementById('confirmPassphrase').value = '';
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Encryption failed: ' + err.message, 'danger');
          }
        });
      }

      if (changeBtn) {
        changeBtn.addEventListener('click', async () => {
          const currentPass = document.getElementById('currentPassphrase').value;
          const newPass = document.getElementById('changeNewPassphrase').value;
          const confirmPass = document.getElementById('changeConfirmPassphrase').value;
          if (!newPass || newPass.length < 6) {
            this.showSyncStatus('securityStatus', 'New passphrase must be at least 6 characters.', 'danger');
            return;
          }
          if (newPass !== confirmPass) {
            this.showSyncStatus('securityStatus', 'New passphrases do not match.', 'danger');
            return;
          }
          this.showSyncStatus('securityStatus', 'Changing passphrase...', 'info');
          try {
            const result = await App.Crypto.changePassphrase(currentPass, newPass);
            this.showSyncStatus('securityStatus', result.message, result.success ? 'success' : 'danger');
            if (result.success) {
              document.getElementById('currentPassphrase').value = '';
              document.getElementById('changeNewPassphrase').value = '';
              document.getElementById('changeConfirmPassphrase').value = '';
            }
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Change failed: ' + err.message, 'danger');
          }
        });
      }

      if (disableBtn) {
        disableBtn.addEventListener('click', async () => {
          const currentPass = document.getElementById('currentPassphrase').value;
          if (!currentPass) {
            this.showSyncStatus('securityStatus', 'Please enter your current passphrase.', 'danger');
            return;
          }
          if (!confirm('Are you sure you want to disable encryption? Your data will be stored in plaintext.')) {
            return;
          }
          this.showSyncStatus('securityStatus', 'Decrypting data...', 'info');
          try {
            const result = await App.Crypto.disableEncryption(currentPass);
            this.showSyncStatus('securityStatus', result.message, result.success ? 'success' : 'danger');
            if (result.success) {
              updateSecurityUI();
              document.getElementById('currentPassphrase').value = '';
            }
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Disable failed: ' + err.message, 'danger');
          }
        });
      }

      // Initialize UI state
      updateSecurityUI();

      const clearAllBtn = document.getElementById('clearAllEstateDataBtn');
      if (clearAllBtn) {
        clearAllBtn.addEventListener('click', async () => {
          const currentUser = App.Auth.getCurrentUser();
          if (!currentUser || currentUser.role !== 'Admin') {
            this.showSyncStatus('securityStatus', 'Only administrators can clear estate data.', 'danger');
            return;
          }
          if (!confirm('WARNING: This will permanently delete all estate data (assets, debts, tasks, cashflow, heirs, distributions).\n\nUser accounts and login sessions will NOT be affected.\n\nThis action cannot be undone. Are you sure?')) {
            return;
          }
          this.showSyncStatus('securityStatus', 'Clearing estate data...', 'info');
          try {
            const result = await App.Data.clearAllEstateData();
            this.showSyncStatus('securityStatus', result.message, result.success ? 'success' : 'danger');
            if (result.success) {
              setTimeout(() => {
                window.location.reload();
              }, 2000);
            }
          } catch (err) {
            this.showSyncStatus('securityStatus', 'Clear failed: ' + err.message, 'danger');
          }
        });
      }
    },

    initExportHandlers() {
      const exportFull = document.getElementById('syncExportFull');
      if (exportFull) {
        exportFull.addEventListener('click', () => {
          App.Sync.exportAll();
          this.showSyncStatus('syncExportStatus', 'Full backup exported!', 'success');
          this.hideBackupReminder();
        });
      }
      const exportEstate = document.getElementById('syncExportEstate');
      if (exportEstate) {
        exportEstate.addEventListener('click', () => {
          App.Sync.exportEstateOnly();
          this.showSyncStatus('syncExportStatus', 'Estate data exported!', 'success');
          this.hideBackupReminder();
        });
      }
    },

    initImportHandlers() {
      const fileDropZone = document.getElementById('fileDropZone');
      const fileInput = document.getElementById('syncImportFile');
      const importPreview = document.getElementById('syncImportPreview');
      const importConfirm = document.getElementById('syncImportConfirm');
      const importCancel = document.getElementById('syncImportCancel');
      const importStatus = document.getElementById('syncImportStatus');

      let pendingImport = null;
      let pendingFile = null;

      const showImportPreview = (validation) => {
        const v = validation;
        const estate = v.data.estate;
        const netValue = (estate.assets || []).reduce((s, a) => s + (parseFloat(a.value) || 0), 0) - (estate.debts || []).filter(d => d.status !== 'Paid').reduce((s, d) => s + (parseFloat(d.balance) || 0), 0);
        if (importPreview) importPreview.style.display = 'block';
        importPreview.innerHTML = `
          <div class="sync-preview-header">Preview of imported data:</div>
          <div class="sync-preview-grid">
            <div><strong>Version:</strong> ${v.data.version || 'N/A'}</div>
            <div><strong>Exported:</strong> ${v.data.exportedAt ? App.UI.formatDate(v.data.exportedAt.split('T')[0]) : 'N/A'}</div>
            <div><strong>Assets:</strong> ${(estate.assets || []).length}</div>
            <div><strong>Debts:</strong> ${(estate.debts || []).length}</div>
            <div><strong>Tasks:</strong> ${(estate.tasks || []).length}</div>
            <div><strong>Heirs:</strong> ${(estate.heirs || []).length}</div>
            <div><strong>Users:</strong> ${v.hasUsers ? (v.data.users || []).length : 'None'}</div>
            <div><strong>Net Value:</strong> ${App.UI.formatCurrency(netValue)}</div>
          </div>
        `;
        if (importConfirm) importConfirm.disabled = false;
        this.showSyncStatus('syncImportStatus', 'File validated. Review the preview and click Confirm Import.', 'success');
      };

      const handleImportFile = async (file, passphrase) => {
        this.showSyncStatus('syncImportStatus', 'Reading file...', 'info');
        const result = await App.Sync.importFromFile(file, passphrase);
        if (result.success) {
          pendingImport = result.validation;
          showImportPreview(result.validation);
        } else if (result.needsPassphrase) {
          pendingFile = file;
          this.showImportPassphraseModal(async (enteredPassphrase) => {
            this.showSyncStatus('syncImportStatus', 'Decrypting backup...', 'info');
            const retryResult = await App.Sync.importFromFile(pendingFile, enteredPassphrase);
            if (retryResult.success) {
              pendingImport = retryResult.validation;
              showImportPreview(retryResult.validation);
              // If this device doesn't have encryption enabled, set it up with the same passphrase
              if (!App.Crypto.isEncryptionEnabled()) {
                await App.Crypto.setupEncryption(enteredPassphrase);
              } else {
                await App.Crypto.setPassphrase(enteredPassphrase);
                App.Crypto.savePassphraseToSession();
              }
            } else {
              pendingImport = null;
              pendingFile = null;
              if (importPreview) importPreview.style.display = 'none';
              if (importConfirm) importConfirm.disabled = true;
              this.showSyncStatus('syncImportStatus', retryResult.message, 'danger');
            }
          });
        } else {
          pendingImport = null;
          pendingFile = null;
          if (importPreview) importPreview.style.display = 'none';
          if (importConfirm) importConfirm.disabled = true;
          this.showSyncStatus('syncImportStatus', result.message, 'danger');
        }
      };

      if (fileDropZone && fileInput) {
        fileDropZone.addEventListener('click', () => fileInput.click());
        fileDropZone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
          }
        });
        fileDropZone.addEventListener('dragover', (e) => {
          e.preventDefault();
          fileDropZone.classList.add('drag-over');
        });
        fileDropZone.addEventListener('dragleave', () => {
          fileDropZone.classList.remove('drag-over');
        });
        fileDropZone.addEventListener('drop', (e) => {
          e.preventDefault();
          fileDropZone.classList.remove('drag-over');
          const file = e.dataTransfer.files[0];
          if (file) handleImportFile(file);
        });
        fileInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) handleImportFile(file);
        });
      }

      if (importConfirm) {
        importConfirm.addEventListener('click', () => {
          if (!pendingImport) return;
          const includeUsers = document.getElementById('syncImportIncludeUsers')?.checked;
          const result = App.Sync.applyImport(pendingImport, { includeUsers });
          this.showSyncStatus('syncImportStatus', result.message, result.success ? 'success' : 'danger');
          if (result.success) {
            importConfirm.disabled = true;
            pendingImport = null;
            setTimeout(() => {
              window.location.reload();
            }, 2000);
          }
        });
      }

      if (importCancel) {
        importCancel.addEventListener('click', () => {
          pendingImport = null;
          pendingFile = null;
          if (importPreview) importPreview.style.display = 'none';
          if (importConfirm) importConfirm.disabled = true;
          if (fileInput) fileInput.value = '';
          if (importStatus) importStatus.innerHTML = '';
          this.closeModal('syncModal');
        });
      }
    },


    showSyncModal(activeTab) {
      let modal = document.getElementById('syncModal');
      if (!modal) {
        this.renderSyncModal();
        this.initSyncModal();
        modal = document.getElementById('syncModal');
      }
      // Clear stale status messages and preview
      modal.querySelectorAll('.sync-status').forEach(el => el.innerHTML = '');
      const preview = document.getElementById('syncImportPreview');
      const confirmBtn = document.getElementById('syncImportConfirm');
      if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
      if (confirmBtn) confirmBtn.disabled = true;
      this.openModal('syncModal');
      const tabs = document.querySelectorAll('#syncTabs .tab');
      const panels = document.querySelectorAll('#syncModal .tab-panel');
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      const targetTab = document.querySelector(`#syncTabs .tab[data-tab="${activeTab || 'export'}"]`);
      const targetPanel = document.querySelector(`#syncModal .tab-panel[data-panel="${activeTab || 'export'}"]`);
      if (targetTab) targetTab.classList.add('active');
      if (targetPanel) targetPanel.classList.add('active');
    },

    showBackupReminder() {
      if (!App.BackupReminder.shouldShowReminder()) return;
      const content = document.querySelector('.content');
      if (!content) return;
      const existing = document.getElementById('backupReminderBanner');
      if (existing) return;

      const days = App.BackupReminder.getDaysSinceLastBackup();
      const timeText = days === Infinity
        ? 'You have never backed up your estate data'
        : `You haven't backed up your estate data in ${days} day${days !== 1 ? 's' : ''}`;

      const banner = document.createElement('div');
      banner.id = 'backupReminderBanner';
      banner.className = 'backup-reminder';
      banner.setAttribute('role', 'alert');
      banner.setAttribute('aria-live', 'polite');
      banner.innerHTML = `
        <svg class="backup-reminder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        <div class="backup-reminder-text">
          <strong>${timeText}.</strong> Back up now to protect against data loss.
        </div>
        <div class="backup-reminder-actions">
          <button class="btn btn-sm btn-primary backup-reminder-btn" data-action="backup">Back Up Now</button>
          <button class="btn btn-sm btn-secondary backup-reminder-btn" data-action="dismiss-day">Dismiss 1 Day</button>
          <button class="btn btn-sm btn-secondary backup-reminder-btn" data-action="dismiss-week">Dismiss 1 Week</button>
        </div>
      `;
      content.insertBefore(banner, content.firstChild);

      banner.querySelectorAll('.backup-reminder-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const action = e.target.dataset.action;
          if (action === 'backup') {
            this.showSyncModal('export');
          } else if (action === 'dismiss-day') {
            App.BackupReminder.setDismissedUntil(24);
            banner.remove();
          } else if (action === 'dismiss-week') {
            App.BackupReminder.setDismissedUntil(24 * 7);
            banner.remove();
          }
        });
      });
    },

    hideBackupReminder() {
      const banner = document.getElementById('backupReminderBanner');
      if (banner) banner.remove();
    },

    showSyncStatus(id, message, type) {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = `<div class="alert alert-${type}">${App.UI.escapeHtml(message)}</div>`;
    }
  }
});

/* ============================================
   App init & ready callbacks
   ============================================ */
App._readyCallbacks = [];
App._ready = false;

App.onReady = function(callback) {
  if (this._ready) {
    callback();
  } else {
    this._readyCallbacks.push(callback);
  }
};

App._setReady = function() {
  this._ready = true;
  this._readyCallbacks.forEach(cb => cb());
  this._readyCallbacks = [];
};

App.init = async function() {
  // Try to restore passphrase from sessionStorage for same-session navigation
  if (this.Crypto.isEncryptionEnabled() && !this.Crypto.hasPassphrase()) {
    this.Crypto.loadPassphraseFromSession();
  }
  try {
    await this.Crypto.init();
  } catch (e) {
    console.error('Crypto.init failed during App.init:', e);
  }
  // Wire App.Auth.init.  Auth.init creates _firstAuthReadyPromise and
  // registers firebase.auth().onAuthStateChanged; the Promise resolves
  // inside _handleAuthUser AFTER profile hydration + App.Data.initAsync()
  // have populated the in-memory cache.  Awaiting here means UI.init() (and
  // therefore App._setReady() + every App.onReady() callback) only runs
  // once a Firestore estate doc is bound and ready to render against. This
  // is the keystone of Phase 2: pages no longer race the auth hydration.
  try {
    this.Auth.init();
  } catch (e) {
    console.error('Auth.init failed during App.init:', e);
  }
  try {
    await this.Auth.awaitFirstAuthReady();
  } catch (e) {
    console.error('Auth.awaitFirstAuthReady failed during App.init:', e);
  }
  this.UI.init();
};

// Track pending writes to warn before unload
App._pendingWrites = 0;
const _originalWriteStorage = App.Crypto.writeStorage.bind(App.Crypto);
App.Crypto.writeStorage = async function(key, value) {
  App._pendingWrites++;
  try {
    return await _originalWriteStorage(key, value);
  } finally {
    App._pendingWrites--;
  }
};
// Phase 2: also track Firestore flushes for the beforeunload warning so a
// debounced save that's already in flight (or a delete's immediate flush)
// can't be lost to a quick back-button navigation.
if (App.Data && typeof App.Data._flush === 'function') {
  const _originalFlush = App.Data._flush.bind(App.Data);
  App.Data._flush = async function () {
    App._pendingWrites++;
    try { return await _originalFlush(); }
    finally {
      App._pendingWrites = Math.max(0, App._pendingWrites - 1);
    }
  };
}

window.addEventListener('beforeunload', (e) => {
  if (App._pendingWrites > 0) {
    e.preventDefault();
    e.returnValue = 'Data is still being saved. Are you sure you want to leave?';
  }
});

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});


