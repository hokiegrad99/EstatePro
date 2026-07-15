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
          createdAt: null,
          // Phase 6: Firestore-not-ready path. No profile doc means no admin.
          isAdmin: false,
          isAdminClaimed: false
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
          createdAt: (profile && profile.createdAt) || null,
          // Phase 6: platform-admin flag is read from /users/{uid}.isAdmin.
          // Strictly `=== true` mirrors isPlatformAdmin() in firestore.rules,
          // so missing/null/false gracefully collapse to non-admin without
          // false positives on legacy accounts.
          isAdmin: (profile && profile.isAdmin) === true,
          isAdminClaimed: (profile && profile.isAdminClaimed) === true
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
        createdAt: null,
        // Phase 6: profile-read failure path (e.g. transient network). No
        // admin claim -- assume non-admin so we don't accidentally expose
        // admin-only UI on the next render.
        isAdmin: false,
        isAdminClaimed: false
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
      createdAt: null,
      // Phase 6: hydrateProfile hasn't run yet (no Firebase profile doc was
      // read). Safe default: non-admin. The right `_hydrateProfile` will
      // overwrite this when it completes.
      isAdmin: false,
      isAdminClaimed: false
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
      //
      // Phase 4 fix: stop silently swallowing the error. The previous version
      // returned [] on ANY failure, which made the executor's "Pending
      // Invitations" panel indistinguishable from "no invites exist" even when
      // the underlying cause was a missing composite index on
      // (redeemedBy, createdAt). We now re-throw so renderShareInvites's catch
      // can surface the message verbatim, including the hint that an index
      // deploy is needed -- exactly the actionable text the user needs when
      // this query first goes wrong.
      async listPendingInvites(estateId) {
        if (!App.Firebase || !App.Firebase.db) {
          throw new Error('Firestore not initialized.');
        }
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
          var msg = (e && e.message) ? e.message : String(e);
          console.error('[EstatePro] listPendingInvites failed:', msg);
          // Append an actionable hint when the failure is the well-known
          // missing-index error from Firestore. Console alone is not enough:
          // the executor hits this exact catch from the shareInvitesCard path.
          if (/index/i.test(msg)) {
            msg += ' (likely cause: composite index (redeemedBy ASC, createdAt DESC) on /invites not deployed. Run `firebase deploy --only firestore:indexes`. The fix is also in firestore.indexes.json at the repo root -- just deploy it.)';
          }
          throw new Error(msg);
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
            // ---- PHASE 1: ALL reads must happen before any writes. ----
            // Firestore's runTransaction contract is strict: every tx.get()
            // must complete before the first tx.update()/tx.set()/tx.delete().
            // The earlier version did tx.get(invRef), then tx.update(invRef, ...),
            // then tx.get(estRef) -- the second read after a write violates
            // the contract and Firestore rejects the transaction with
            // "Firestore transactions require all reads to be executed before
            // all writes." We now do both reads up front, then both writes.
            var invSnap = await tx.get(invRef);
            if (!invSnap.exists) throw new Error('Invite has been revoked or never existed.');
            var inv = invSnap.data();
            if (inv.redeemedBy) throw new Error('This invite was already redeemed by ' + inv.redeemedBy + '.');
            if (inv.inviteeEmail && authEmail && inv.inviteeEmail.toLowerCase() !== authEmail.toLowerCase()) {
              // Phase 4 fix: surface both emails in the error so the heir
              // (or the executor) can see at a glance which email is
              // mismatched. The previous phrasing ("You must be signed in as
              // X") was correct but a single-email message -- test subjects
              // were confused when they saw it because they didn't realize
              // they were viewing it as a different identity than the invite
              // was minted for. Naming both addresses collapses that
              // ambiguity and tells them exactly what to do.
              throw new Error('This invite was minted for ' + inv.inviteeEmail + ' but you are signed in as ' + authEmail + '. Sign in as ' + inv.inviteeEmail + ' (the address the executor used), OR ask the executor to issue a fresh invite addressed to ' + authEmail + '.');
            }
            var role = inv.role;
            if (!['executor', 'heir', 'beneficiary'].includes(role)) {
              throw new Error('Invite has an invalid role: ' + role);
            }
            // (intentionally NOT tx.get(estRef): the read rule for
            //  /estates/{estateId} is `uid in resource.data.memberIds`. The
            //  heir isn't yet a member -- that IS what consume adds -- so any
            //  client-side read of the estate doc is rejected with "Missing
            //  or insufficient permissions". We sidestep the read entirely
            //  by using FieldValue.arrayUnion() and the dot-notation write
            //  'roles.<uid>'; isInviteConsumption() in firestore.rules
            //  validates request.resource.data against resource.data on
            //  the SERVER side, where the rule engine has direct access to
            //  resource.data without our client ever having to read it.)

            // ---- PHASE 2: ALL writes now that reads are done. ----
            // (c) Mark the subdoc as redeemed.
            tx.update(invRef, {
              redeemedBy: u.uid,
              redeemedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // (d) Update parent doc -- arrayUnion + dot-notation roles.<uid>.
            // FieldValue.arrayUnion(u.uid) resolves server-side to "old +
            // [uid]" (size += 1, last element = uid), satisfying
            // isInviteConsumption()'s size-and-tail check. The 'roles.<uid>'
            // field-path write hits only the new nested key, so existing
            // executor/heir/beneficiary role entries are untouched.
            // pendingInvites is intentionally NOT modified: the rule's
            // pendingInvites.size() <= resource.data.pendingInvites.size()
            // holds because equality is the strongest <=.
            var estRefUpdate = {
              memberIds: firebase.firestore.FieldValue.arrayUnion(u.uid),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            estRefUpdate['roles.' + u.uid] = role;
            tx.update(estRef, estRefUpdate);
          });
          // Active estate switched -- the new member now has access.
          // Phase 4→5 fix: persist to localStorage as well as memory.
          // Without this, the auto-consume banner's window.location.reload()
          // preserves the in-memory _currentEstateId, but any manual refresh
          // AFTER the reload would re-read localStorage and bind to estates[0]
          // (or whatever the heir had saved before the consume), silently
          // routing them away from the freshly-joined estate. Same key as
          // switchEstate() so the two paths stay symmetric.
          if (App.Data && App.Data._currentEstateId !== estateId) {
            App.Data._currentEstateId = estateId;
            try { localStorage.setItem('estatepro_active_estate', estateId); } catch (e) { /* ignore */ }
            try { await App.Data.initAsync(); } catch (e) { /* ignore */ }
          }
          return { success: true, message: 'Welcome! You now have access to the estate.' };
        } catch (err) {
          return { success: false, message: err && err.message ? err.message : 'Could not consume invite.' };
        }
      },

      // ---- deleteInvite ----
      // Called from the executor's Pending Invitations card. Deletes an
      // UNREDEEMED invite subdoc. Rules (in firestore.rules) gate this to
      // executors of the parent estate AND require resource.data.redeemedBy
      // == null, so a redeemed invite cannot be retroactively revoked --
      // the joiner keeps their seat. Returns { success, message }; on
      // success the caller should re-render the pending-invites list.
      //
      // We intentionally do NOT confirm with the caller here -- the UI layer
      // owns that (window.revokeInvite in executor.html). Keeping client
      // prompts out of this method lets future programmatic callers (a
      // batch-cleanup tool, a Cloud Function trigger, etc.) skip the
      // modal step by calling this directly.
      async deleteInvite(estateId, inviteId) {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) {
          return { success: false, message: 'Firestore not initialized.' };
        }
        if (!estateId || !inviteId) return { success: false, message: 'Missing invite parameters.' };
        try {
          await App.Firebase.db.collection('estates').doc(estateId)
            .collection('invites').doc(inviteId).delete();
          return { success: true, message: 'Invite revoked.' };
        } catch (err) {
          return {
            success: false,
            message: 'Could not revoke invite: ' + (err && err.message ? err.message : err)
          };
        }
      },

      // ---- updateMemberRole ----
      // Phase 5: the executor's wrapper for changing an EXISTING member's
      // role (e.g. heir -> beneficiary). Reads the current estate doc (we
      // ARE a member so the read rule permits it), constructs a NEW roles
      // map with exactly one entry's value changed, then issues a single
      // .update() call. The isModifyMemberRole rule branch enforces:
      //   - exactly one roles key changed, others identical;
      //   - the new value is in [executor, heir, beneficiary];
      //   - memberIds unchanged;
      //   - at least one executor remains afterwards (last-executor guard).
      // We do the diff client-side because Firestore rules can read the diff
      // but cannot compute "modify X to Y" without an explicit target field
      // on the request payload -- which we'd rather not add to /estates/{id}.
      async updateMemberRole(estateId, targetUid, newRole) {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) {
          return { success: false, message: 'Firestore not initialized.' };
        }
        if (!['executor', 'heir', 'beneficiary'].includes(newRole)) {
          return { success: false, message: 'Invalid role. Use executor / heir / beneficiary.' };
        }
        if (!estateId || !targetUid) return { success: false, message: 'Missing parameters.' };
        try {
          var estRef = App.Firebase.db.collection('estates').doc(estateId);
          var snap = await estRef.get();
          if (!snap.exists) return { success: false, message: 'Estate not found.' };
          var cur = snap.data();
          var curRoles = (cur && cur.roles) || {};
          if (!(targetUid in curRoles)) {
            return { success: false, message: 'Target is not a member of this estate.' };
          }
          if (curRoles[targetUid] === newRole) {
            return { success: false, message: 'Role is already set to that value.' };
          }
          var newRoles = Object.assign({}, curRoles);
          newRoles[targetUid] = newRole;
          await estRef.update({ roles: newRoles });
          return { success: true, message: 'Role updated.' };
        } catch (err) {
          return {
            success: false,
            message: 'Could not update role: ' + (err && err.message ? err.message : err)
          };
        }
      },

      // ---- removeMember ----
      // Phase 5: removes a uid from BOTH the memberIds array AND the roles
      // map. Last-executor safety is enforced entirely server-side by the
      // isRemoveMember() rule branch (see firestore.rules); if we attempt to
      // remove the last executor, Firestore rejects the .update() and the
      // catch block surfaces "Missing or insufficient permissions" to the
      // executor. We do the diff client-side so the rule's
      // roles.diff().affectedKeys().hasOnly([removedKey]) check is naturally
      // satisfied without us adding a targetUid field to the request payload.
      async removeMember(estateId, targetUid) {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) {
          return { success: false, message: 'Firestore not initialized.' };
        }
        if (!estateId || !targetUid) return { success: false, message: 'Missing parameters.' };
        try {
          var estRef = App.Firebase.db.collection('estates').doc(estateId);
          var snap = await estRef.get();
          if (!snap.exists) return { success: false, message: 'Estate not found.' };
          var cur = snap.data();
          var curMemberIds = (cur && cur.memberIds) || [];
          if (curMemberIds.indexOf(targetUid) < 0) {
            return { success: false, message: 'Target is not a member of this estate.' };
          }
          var newMemberIds = curMemberIds.filter(function (id) { return id !== targetUid; });
          var newRoles = Object.assign({}, (cur && cur.roles) || {});
          delete newRoles[targetUid];
          await estRef.update({
            memberIds: newMemberIds,
            roles: newRoles
          });
          return { success: true, message: 'Member removed.' };
        } catch (err) {
          return {
            success: false,
            message: 'Could not remove member: ' + (err && err.message ? err.message : err)
          };
        }
      }
    },

    // ---- Phase 6: Platform Admin namespace ----
    // Admin powers live in /users/{uid}.isAdmin (a global flag, NOT per-estate).
    // The firestore.rules helper isPlatformAdmin() reads this flag and is
    // used as an OR-short-circuit across nearly every per-estate write branch,
    // so an Admin has executor-equivalent authority on every estate they touch
    // AND can mint new estates. The client-side helpers here cover:
    //   - isCurrentUserAdmin(): sync read from the hydrated profile (fast);
    //     falls back to Firestore read if not yet hydrated.
    //   - platformAdminExists(): returns true once /_meta/platform_admin_lock
    //     has been written. Used to decide whether to surface a "promote to
    //     admin" affordance (you can still try, but it'll fail).
    //   - claimAdmin(): runTransaction writes a /_meta/platform_admin_lock
    //     doc AND sets users/{selfUid}.{isAdmin: true, isAdminClaimed: true}
    //     atomically. The firestore.rules helper claimFirstAdmin() enforces
    //     the same atomicity server-side via existsAfter(); a single .update()
    //     without runTransaction is rejected at the server. This closes the
    //     race condition where two clients might otherwise both self-promote.
    //   - createNewEstate(): any signed-in Admin can mint a brand-new estate
    //     doc, becoming its sole executor. Bypasses the __founderSecret
    //     check (their Admin status is the credential).
    Admin: {
      async isCurrentUserAdmin() {
        var u = App.Auth.getCurrentUser();
        if (!u) return false;
        if (u.isAdmin === true) return true;
        // Fall back to a live read if _hydrateProfile hasn't finished yet
        // OR if the cached value is stale (e.g. a different tab just claimed
        // Admin). Cheap: one doc read with cache.
        if (!App.Firebase || !App.Firebase.db) return false;
        try {
          var snap = await App.Firebase.db.collection('users').doc(u.uid).get();
          return snap.exists && snap.data() && snap.data().isAdmin === true;
        } catch (e) {
          console.warn('[EstatePro] isCurrentUserAdmin live-read failed:', e && e.message);
          return false;
        }
      },

      async platformAdminExists() {
        if (!App.Firebase || !App.Firebase.db) return false;
        try {
          var snap = await App.Firebase.db.doc('_meta/platform_admin_lock').get();
          return !!snap.exists;
        } catch (e) {
          console.warn('[EstatePro] platformAdminExists failed:', e && e.message);
          return false;
        }
      },

      async claimAdmin() {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) return { success: false, message: 'Firestore not ready.' };
        // Refuse early if we already know an Admin exists, so the user gets
        // an actionable message instead of a transaction error.
        if (await this.platformAdminExists()) {
          return {
            success: false,
            message: 'A platform Admin already exists for this project. Ask the existing Admin to grant you access (they can update users/{yourUid}.isAdmin from any client).'
          };
        }
        try {
          await App.Firebase.db.runTransaction(async function (tx) {
            var lockRef = App.Firebase.db.doc('_meta/platform_admin_lock');
            var userRef = App.Firebase.db.collection('users').doc(u.uid);
            // Precondition: BOTH writes must complete. If anyone else has
            // claimed since the pre-flight read above (e.g. another tab
            // racing the same call), the lockRef.get() returns exists:true
            // and the throw rolls back our user write too.
            var lockSnap = await tx.get(lockRef);
            if (lockSnap.exists) {
              throw new Error('A platform Admin already exists.');
            }
            tx.set(lockRef, {
              uid: u.uid,
              email: (u.email || ''),
              claimedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            // Phase 6 defensive fix: use set({merge: true}) instead of
            // update() so the runTransaction works even if /users/{uid}
            // doesn't yet exist (e.g., a user signed up under an older
            // build that didn't write the profile doc on register, or
            // whose doc was deleted). update() requires the doc to
            // exist; set-with-merge creates it on-the-fly.
            //
            // Phase 6 follow-up fix: include `email`, `displayName`, and
            // `createdAt` in the merge-set payload because Firestore
            // treats `set` on a non-existent doc as a CREATE, gated by
            //   allow create: if isSelf(userId)
            //              && request.resource.data.email is string;
            // Without `email` in the payload, the create rule fails
            // and the entire transaction rolls back. We pull the
            // values from the Firebase Auth currentUser, which is
            // authenticated by Firebase itself -- no security
            // regression. For an existing doc, set-with-merge just
            // merges these fields in alongside isAdmin etc., which
            // matches what the standard register flow already writes.
            tx.set(userRef, {
              email: (u.email || ''),
              displayName: (u.displayName || u.name || u.email || ''),
              createdAt: new Date().toISOString(),
              isAdmin: true,
              isAdminClaimed: true,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          });
          // Refresh the in-memory profile so the same-tab sidebar update
          // sees isAdmin=true without waiting for the next page reload.
          if (App.Auth._currentUser) {
            App.Auth._currentUser.isAdmin = true;
            App.Auth._currentUser.isAdminClaimed = true;
          }
          return { success: true, message: 'You are now a platform Admin. Reloading...' };
        } catch (err) {
          return { success: false, message: 'Could not claim Admin: ' + (err && err.message ? err.message : String(err)) };
        }
      },

      async createNewEstate(opts) {
        var u = App.Auth.getCurrentUser();
        if (!u) return { success: false, message: 'Not signed in.' };
        if (!App.Firebase || !App.Firebase.db) return { success: false, message: 'Firestore not ready.' };
        if (!opts || !opts.decedent || !String(opts.decedent).trim()) {
          return { success: false, message: 'Decedent name is required.' };
        }
        try {
          // Firestore auto-id lets us write without a manual id allocator.
          var newRef = App.Firebase.db.collection('estates').doc();
          var payload = {
            memberIds: [u.uid],
            roles: {},
            pendingInvites: {},
            createdBy: u.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            decedent: {
              fullName: String(opts.decedent).trim(),
              dateOfDeath: opts.dateOfDeath || ''
            },
            executor: {
              name: (opts.executorName && String(opts.executorName).trim()) || u.name || u.email || 'Executor',
              relationship: 'Executor'
            },
            tasks: [], assets: [], debts: [], cashflow: [], heirs: [], distributions: []
          };
          payload.roles[u.uid] = 'executor';
          await newRef.set(payload);
          return { success: true, message: 'Estate created.', estateId: newRef.id };
        } catch (err) {
          return { success: false, message: 'Could not create estate: ' + (err && err.message ? err.message : String(err)) };
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
    // Phase 6: legacy phase-1 stub now delegates to the Phase-6 Admin
    // namespace. user-menu dropdown callers still hit this method by name.
    async promoteSelfToAdmin() { return App.Auth.Admin.claimAdmin(); },
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
      // Phase 6: Platform Admin authority is global, not per-estate. An Admin
      // can edit / invite / clear data regardless of which estate they're in
      // OR even if they're in NONE of the user's known estates. Per-estate
      // editing is unlocked as soon as the user has /users/{uid}.isAdmin=true.
      return user.isAdmin === true || user.role === 'Admin' || user.role === 'Executor';
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
      // Phase 6: same global-Admin override as canEdit.
      return user.isAdmin === true || user.role === 'Admin';
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
        // Phase 4→5 fix: honor a user's saved active-estate selection.
        // switchEstate() writes to localStorage('estatepro_active_estate');
        // we read it back here so a page refresh (or tab close + reopen)
        // doesn't bounce the user back to estates[0]. Find-or-default: if
        // the saved id is missing (executor removed the user, estate was
        // deleted, leftover entry from an earlier Firebase project),
        // fall through to the legacy estates[0] binding.
        var savedActiveId = null;
        try { savedActiveId = localStorage.getItem('estatepro_active_estate'); } catch (e) { /* ignore */ }
        var savedEstate = savedActiveId && estates.find(function (e) { return e.id === savedActiveId; });
        var estate = savedEstate || estates[0];
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
      // Phase 4→5 fix: use localStorage (NOT sessionStorage) so the active
      // estate selection survives a hard page refresh AND a tab close.
      // sessionStorage wiped on tab close; localStorage persists across both.
      // We also defend against the old sessionStorage key (no reads in this
      // file, but extensions/bookmarklets could fight us) by purging it.
      try { localStorage.setItem('estatepro_active_estate', estateId); } catch (e) { /* ignore */ }
      try { sessionStorage.removeItem('estatepro_active_estate');    } catch (e) { /* ignore */ }
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

      // Phase 4 defensive: surface a "no estate access" banner for any
      // signed-in user whose getMyEstates() returned []. Without this,
      // every signed-in page renders $0/0 tables because App.Data.initAsync
      // hits the empty-estate branch and the user has no idea why. Skipped
      // on the login page (which has its own bootstrap hint).
      if (!document.body.classList.contains('login-page')) {
        this._maybeShowNoEstateBanner();
      }

      // Phase 4: sidebar estate selector. No-op on pages that don't have the
      // selector slot, and hidden when the user has only one estate.
      this.initEstateSelector();

      // Phase 6: side-mount the "+ New Estate" PLATFORM block in the
      // sidebar if the current user is a platform Admin. Re-entrant: any
      // prior injection is removed first so this is safe to call again after
      // a successful Admin claim (pushed by the user-menu click handler).
      this.renderPlatformSidebar();

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

    // ---- Phase 6: Platform sidebar injection ----
    // Mounts a "PLATFORM" header + a "+ New Estate" action at the very top
    // of the sidebar-nav, only for users with isAdmin=true. Idempotent: any
    // prior injection is removed first. Safe to call on init AND after a
    // successful Admin claim from the user-menu dropdown. No-op on the login
    // page (which has no sidebar) and on pages without a sidebar-nav.
    renderPlatformSidebar() {
      var nav = document.querySelector('.sidebar-nav');
      if (!nav) return;
      var oldHeader = nav.querySelector('.sidebar-platform-header');
      if (oldHeader) oldHeader.remove();
      var oldItem = nav.querySelector('.sidebar-platform-item');
      if (oldItem) oldItem.remove();

      var user = App.Auth.getCurrentUser();
      if (!user || user.isAdmin !== true) return;

      // "PLATFORM" header with a divider above + below. Visually distinct
      // from the estate nav so users see it as a separate scope (it's at
      // the project level, not the estate level).
      var header = document.createElement('div');
      header.className = 'sidebar-platform-header';
      header.setAttribute('data-platform-sidebar', '1');
      header.style.cssText = 'padding:0.75rem 1rem 0.35rem; font-size:0.65rem; color:var(--sidebar-text,#94a3b8); opacity:0.55; text-transform:uppercase; letter-spacing:0.1em; border-top:1px solid rgba(255,255,255,0.08); margin-top:0.5rem; pointer-events:none;';
      header.textContent = 'Platform';
      nav.insertBefore(header, nav.firstChild);

      var ul = nav.querySelector('ul');
      if (!ul) return;
      var item = document.createElement('li');
      item.className = 'sidebar-platform-item';
      item.setAttribute('data-platform-sidebar', '1');
      item.innerHTML = '<a href="#" class="sidebar-platform-btn" data-action="new-estate" style="color:#fff; background:rgba(37,99,235,0.18); border-left:3px solid #2563eb; font-weight:600;">'
        + '<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>'
        + 'New Estate</a>';
      ul.insertBefore(item, ul.firstChild);

      var btn = item.querySelector('a');
      if (btn) btn.addEventListener('click', function (e) {
        e.preventDefault();
        App.UI.showCreateEstateModal();
      });
    },

    // ---- Phase 6: Create-estate modal ----
    // Invoked by the sidebar "+ New Estate" button. Captures dept: decedent
    // name (required) + date of death + executor name + executors handle
    // the auto-id creation via Admin.createNewEstate. On success we
    // (a) persist the new id to localStorage, (b) bind App.Data to it via
    // reload, (c) navigate to dashboard.html?welcome=1 so the new estate's
    // birth announcement banner can be shown on first visit.
    renderCreateEstateModal() {
      if (document.getElementById('createEstateModal')) return;
      var modal = document.createElement('div');
      modal.id = 'createEstateModal';
      modal.className = 'modal-overlay';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'createEstateTitle');
      modal.innerHTML =
        '<div class="modal" style="max-width:520px;">'
        + '  <div class="modal-header">'
        + '    <div class="modal-title" id="createEstateTitle">Create a new estate</div>'
        + '    <button type="button" class="modal-close" onclick="App.UI.closeModal(\'createEstateModal\')" aria-label="Close">&times;</button>'
        + '  </div>'
        + '  <form id="createEstateForm">'
        + '    <div class="modal-body">'
        + '      <p style="margin-bottom:1rem; color:var(--text-secondary); font-size:0.9rem;">As a platform Admin you can mint a new estate. You will become its sole executor; use the Invite flow on the Executor page to add heirs after creation.</p>'
        + '      <div class="form-group">'
        + '        <label class="form-label" for="ceDecedent">Decedent\'s full name <span aria-label="required">*</span></label>'
        + '        <input type="text" id="ceDecedent" class="form-input" placeholder="e.g. Jane Doe" required autocomplete="off">'
        + '      </div>'
        + '      <div class="form-row">'
        + '        <div class="form-group">'
        + '          <label class="form-label" for="ceDateOfDeath">Date of Death</label>'
        + '          <input type="date" id="ceDateOfDeath" class="form-input">'
        + '        </div>'
        + '        <div class="form-group">'
        + '          <label class="form-label" for="ceExecutorName">Your name (Executor)</label>'
        + '          <input type="text" id="ceExecutorName" class="form-input" placeholder="Defaults to your account name">'
        + '        </div>'
        + '      </div>'
        + '      <div id="ceMessage" style="margin-top:0.5rem;"></div>'
        + '    </div>'
        + '    <div class="modal-footer">'
        + '      <button type="button" class="btn btn-secondary" onclick="App.UI.closeModal(\'createEstateModal\')">Cancel</button>'
        + '      <button type="submit" class="btn btn-primary">Create Estate</button>'
        + '    </div>'
        + '  </form>'
        + '</div>';
      document.body.appendChild(modal);

      var form = document.getElementById('createEstateForm');
      var self = this;
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msgEl = document.getElementById('ceMessage');
        var submitBtn = form.querySelector('button[type="submit"]');
        msgEl.innerHTML = '';
        submitBtn.disabled = true;
        var originalLabel = submitBtn.textContent;
        submitBtn.textContent = 'Creating...';
        try {
          var decedent = document.getElementById('ceDecedent').value.trim();
          var dod = document.getElementById('ceDateOfDeath').value || '';
          var execName = document.getElementById('ceExecutorName').value.trim();
          if (!decedent) {
            msgEl.innerHTML = '<div class="alert alert-danger">Decedent name is required.</div>';
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
            return;
          }
          var result = await App.Auth.Admin.createNewEstate({
            decedent: decedent,
            dateOfDeath: dod,
            executorName: execName
          });
          if (result && result.success) {
            msgEl.innerHTML = '<div class="alert alert-success">' + App.UI.escapeHtml(result.message) + ' Switching to the new estate...</div>';
            try { localStorage.setItem('estatepro_active_estate', result.estateId); } catch (e2) {}
            setTimeout(function () {
              // Page reload so every render starts fresh against the new doc.
              // dashboard.html?welcome=1 is a no-op today but gives us a hook
              // for a future "estate just created" banner without forcing a
              // back-end change.
              window.location.href = 'dashboard.html?welcome=1&new=1';
            }, 700);
          } else {
            msgEl.innerHTML = '<div class="alert alert-danger">' + App.UI.escapeHtml(result && result.message ? result.message : 'Could not create estate.') + '</div>';
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
          }
        } catch (err) {
          msgEl.innerHTML = '<div class="alert alert-danger">' + App.UI.escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      });
    },

    showCreateEstateModal() {
      // Defensive gate: only Admins can open this modal.
      var user = App.Auth.getCurrentUser();
      if (!user || user.isAdmin !== true) {
        alert('Only platform Admins can create new estates.');
        return;
      }
      this.renderCreateEstateModal();
      // Pre-fill the executor-name field with the signed-in user's name.
      var execField = document.getElementById('ceExecutorName');
      if (execField && !execField.value && user.name) {
        execField.value = user.name;
      }
      // Reset any prior state on every open.
      var decField = document.getElementById('ceDecedent');
      if (decField) decField.value = '';
      var dodField = document.getElementById('ceDateOfDeath');
      if (dodField) dodField.value = '';
      var msgEl = document.getElementById('ceMessage');
      if (msgEl) msgEl.innerHTML = '';
      var submitBtn = document.querySelector('#createEstateForm button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Estate';
      }
      this.openModal('createEstateModal');
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
    // Phase 4 defensive helper: render a clear banner explaining why
    // the user sees empty data tables on every page. Triggered when
    // App.Data.isReady() returns false despite a signed-in Firebase user
    // (i.e. getMyEstates() returned [] because their uid is not in any
    // estate's memberIds). The banner names the cause and points the user
    // at the immediate remediation (paste their invite URL into the
    // address bar, or ask the executor for a new invite). Render functions
    // on each page still run and will show $0 / empty rows; the banner
    // sits at the top of .content so the explanation is clear.
    _maybeShowNoEstateBanner() {
      // No-op when the in-memory cache is bound to a real estate.
      if (App.Data && typeof App.Data.isReady === 'function' && App.Data.isReady()) return;
      // No-op on the login page (it has its own bootstrap hint + invite URL
      // banner via index.html).
      if (document.body.classList.contains('login-page')) return;
      // No-op when signed out.
      var u = App.Auth.getCurrentUser();
      if (!u) return;
      // Pages without a `.content` slot don't need a banner.
      var contentEl = document.querySelector('.content');
      if (!contentEl) return;
      // Don't double-insert (init() may fire twice across bfcache restores).
      if (document.getElementById('noEstateBanner')) return;

      // Phase 4 auto-consume fix: if sessionStorage has a pending invite
      // URL, fire consumeInviteFromUrl right here -- on EVERY page, not
      // just index.html. The original index.html IIFE only attempted the
      // consume on index.html itself, and a SIGNED-IN user pasting the URL
      // hits the same race: index.html's first script sees isLoggedIn()
      // === true and runs `window.location.href = 'dashboard.html';
      // return;` BEFORE handleInviteUrl can register its onAuthStateChanged
      // listener or set sessionStorage. By also attempting the consume here
      // (which App.UI.init fires on every page), we catch Path B:
      //   1. Heir pastes URL while signed-in
      //   2. index.html renders, handleInviteUrl sets sessionStorage
      //   3. First script redirects to dashboard.html
      //   4. dashboard.html loads, banner triggers, consume fires
      //   5. On success: window.location.reload() picks up new memberIds
      // sessionStorage is cleared in BOTH success and failure paths so we
      // never loop. The deferred 800 ms banner render still runs if the
      // consume fails -- the user then sees the email-mismatch explainer
      // and Refresh data button as before.
      var pendingRaw = null;
      try { pendingRaw = sessionStorage.getItem('estatepro_pending_invite'); } catch (e) {}
      if (pendingRaw) {
        var pending = null;
        try { pending = JSON.parse(pendingRaw); } catch (e) {}
        if (pending && pending.estateId && pending.inviteId
            && App.Auth && App.Auth.Invite
            && typeof App.Auth.Invite.consumeInviteFromUrl === 'function') {
          var self3 = this;
          App.Auth.Invite.consumeInviteFromUrl(pending.estateId, pending.inviteId).then(function (res) {
            try { sessionStorage.removeItem('estatepro_pending_invite'); } catch (e) {}
            if (res && res.success) {
              // Reload so initAsync re-queries with the new memberIds.
              window.location.reload();
              return;
            }
            // Failure: clear sessionStorage, then render the banner so the
            // user sees the explainer (email mismatch detail, etc.).
            self3._renderNoEstateBannerAfterWait(u, contentEl);
          }).catch(function (err) {
            try { sessionStorage.removeItem('estatepro_pending_invite'); } catch (e) {}
            console.error('[EstatePro] banner auto-consume failed:', err && err.message);
            self3._renderNoEstateBannerAfterWait(u, contentEl);
          });
          return;
        }
      }

      // Phase 4 fix: defer DOM mutation by 800 ms so a fresh sign-in -- in
      // particular the invite-URL consume path that promotes a user from
      // "no estates" to "member of one estate" in a single event loop tick
      // -- doesn't flash this banner mid-`App.Data.initAsync` round-trip. We
      // re-check the early-exit conditions inside the deferred handler so a
      // state that resolves to isReady=true during the wait is respected.
      // The actual banner construction lives in _renderNoEstateBannerAfterWait
      // to keep this method light.
      var self = this;
      setTimeout(function () {
        if (App.Data && typeof App.Data.isReady === 'function' && App.Data.isReady()) return;
        if (document.getElementById('noEstateBanner')) return;
        if (!App.Auth.getCurrentUser()) return;
        if (document.body.classList.contains('login-page')) return;
        var contentEl2 = document.querySelector('.content');
        if (!contentEl2) return;
        self._renderNoEstateBannerAfterWait(u, contentEl2);
      }, 800);
    },

    _renderNoEstateBannerAfterWait(u, contentEl) {
      var banner = document.createElement('div');
      banner.id = 'noEstateBanner';
      banner.setAttribute('role', 'alert');
      banner.setAttribute('aria-live', 'polite');
      banner.style.cssText = 'margin:1.5rem auto; padding:1.75rem 1.5rem; max-width:600px; text-align:center; background:rgba(220,38,38,0.04); border:1px solid var(--danger-color); border-radius:var(--radius);';
      // Phase 4 fix: prominent email banner + explicit email-mismatch hint.
      // The previous wording told heirs to "paste your invite URL", which is
      // great for users with a still-valid pending invite but misleading for
      // heirs who ALREADY consumed (or tried to consume) an invite issued
      // for a different address -- the symptom in the field. Surface both
      // paths so the user can act on whichever applies.
      var email = u.email || u.uid || '(unknown)';
      banner.innerHTML =
        '<h3 style="margin:0 0 0.75rem 0; color:var(--text-primary);">You don\u2019t have access to any estate yet</h3>' +
        '<div style="margin:0 0 1rem 0; padding:0.5rem 0.75rem; background:var(--bg-primary); border-radius:var(--radius); display:inline-block;">' +
          '<span style="color:var(--text-secondary); font-size:0.8rem;">Signed in as</span><br>' +
          '<strong style="color:var(--text-primary); font-size:1.05rem; font-family:monospace; word-break:break-all;">' + App.UI.escapeHtml(email) + '</strong>' +
        '</div>' +
        '<p style="color:var(--text-secondary); margin:0 0 0.75rem 0;">If you have an estate invitation link, paste it into your browser\u2019s address bar \u2014 it will sign you in (or register you) and apply the invitation automatically.</p>' +
        '<p style="color:var(--text-secondary); font-size:0.85rem; margin:0 0 0.75rem 0;">If you already tried pasting an invite and it didn\u2019t work, the executor most likely sent it for <em>a different email than the one above</em>. Either sign in with the exact email the executor addressed the invite to, or ask the executor to mint a fresh invite addressed to <strong style="color:var(--text-primary); font-family:monospace; word-break:break-all;">' + App.UI.escapeHtml(email) + '</strong>.</p>' +
        '<p style="color:var(--text-secondary); font-size:0.85rem; margin:0;">Otherwise, ask the executor of the estate to send you an invitation.</p>';
      // "Refresh data" affordance: re-runs getMyEstates and reloads if the
      // user has been silently added to an estate since this page first
      // rendered (e.g., executor just minted and we lost a race). Without
      // this, the only way out was a hard refresh (Cmd/Ctrl-R) which can be
      // confusing for end users.
      var refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'btn btn-sm btn-secondary';
      refreshBtn.style.cssText = 'margin-top:1.25rem;';
      refreshBtn.textContent = 'Refresh data';
      refreshBtn.onclick = function () {
        if (!App.Auth || typeof App.Auth.getMyEstates !== 'function') {
          refreshBtn.textContent = 'No auth available';
          return;
        }
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Checking\u2026';
        App.Auth.getMyEstates().then(function (estates) {
          if (Array.isArray(estates) && estates.length > 0 && App.Data) {
            App.Data._currentEstateId = estates[0].id;
            App.Data._cache = App.Data._normalize(estates[0]._doc);
            window.location.reload();
          } else {
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Still empty \u2014 retry';
          }
        }).catch(function (err) {
          console.error('[EstatePro] noEstateBanner refresh failed:', err && err.message);
          refreshBtn.disabled = false;
          refreshBtn.textContent = 'Error \u2014 see console';
        });
      };
      banner.appendChild(refreshBtn);
      contentEl.prepend(banner);
    },

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

      // Phase 6: the user-menu "Promote to Admin" button shows whenever the
      // current user is NOT yet a platform admin. The actual race against
      // a pre-existing admin is closed server-side by the claimFirstAdmin
      // helper in firestore.rules (existsAfter() locks the platform_admin_lock
      // atomically with the user-write). The client pre-flight
      // platformAdminExists() check in the click handler gives a friendlier
      // error message when the user is just too late.
      const promoteBtn = dropdown.querySelector('#userMenuPromoteAdmin');
      if (promoteBtn && currentUser && currentUser.isAdmin !== true) {
        promoteBtn.style.display = 'block';
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
          if (!confirm('Promote your account to Platform Admin?\n\nThis gives you:\n  - the ability to create additional estates in this same Firebase project\n  - global estate-management authority on every estate\n\nThere will only ever be one Platform Admin per Firebase project. Once claimed, the door is permanently closed.')) return;
          // Show a "Working..." indicator inline so users see the runTransaction
          // is in flight instead of wondering if the click registered.
          var selfUI = App.UI;
          promoteBtn.disabled = true;
          var originalLabel = promoteBtn.innerHTML;
          promoteBtn.innerHTML = '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle; margin-right:0.5rem; animation:spin 1.2s linear infinite;"><circle cx="12" cy="12" r="10" opacity="0.25"></circle><path d="M12 2a10 10 0 019.95 9" fill="none"></path></svg>Working...';
          var result;
          try {
            result = await App.Auth.Admin.claimAdmin();
          } catch (err) {
            result = { success: false, message: err && err.message ? err.message : String(err) };
          }
          promoteBtn.disabled = false;
          promoteBtn.innerHTML = originalLabel;
          if (result && result.success) {
            alert(result.message);
            // Re-mount the sidebar so the "+ New Estate" PLATFORM item shows.
            selfUI.renderPlatformSidebar();
            // Re-render the dropdown so the "Promote to Admin" button hides.
            // Cheap reset: bump a sentinel attribute and rebuild the menu.
            // The existing dropdown node is still in DOM with the old state;
            // simplest is to remove + re-init.
            var dropdownNode = dropdown.parentNode.querySelector('.user-menu-dropdown');
            var currentUserForRenew = App.Auth.getCurrentUser();
            dropdownNode.remove();
            // Need fresh refs after DOM removal; just call init again on this
            // .user-info element.
            selfUI.initUserMenu();
          } else {
            alert((result && result.message) || 'Could not claim Admin.');
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


