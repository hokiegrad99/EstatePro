/* ============================================================
 * Firebase bridge — exposes App.Firebase for the rest of the app
 * ============================================================
 * Loaded AFTER the Firebase compat SDKs and js/firebase-config.js,
 * BEFORE js/app.js. See FIREBASE-SETUP.md for the script tag order.
 *
 * After this script runs, the rest of the app can access:
 *   - App.Firebase.app              : the FirebaseApp instance
 *   - App.Firebase.auth             : firebase.auth.Auth
 *   - App.Firebase.db               : firebase.firestore.Firestore
 *   - App.Firebase.isReady()        : boolean — true means everything initialized
 *   - App.Firebase.whyNotReady()    : human-readable reason if not ready
 * ============================================================ */

(function () {
  'use strict';

  // Build the failure stub up-front so every code path can use it.
  function failStub(reason) {
    return {
      app: null,
      auth: null,
      db: null,
      isReady: function () { return false; },
      whyNotReady: function () { return reason; }
    };
  }

  // Make sure window.App exists before we attach anything.
  window.App = window.App || {};

  // ---- 1. Did the Firebase SDK scripts load at all? ------------------
  if (typeof firebase === 'undefined') {
    var sdkMsg = 'Firebase SDK scripts did not load. Check that the three ' +
      '<script> tags for firebase-app, firebase-auth and firebase-firestore ' +
      'come before js/firebase-bridge.js in your HTML.';
    console.error('[EstatePro] ' + sdkMsg);
    window.App.Firebase = failStub(sdkMsg);
    return;
  }

  // ---- 2. Did firebase-config.js actually ship a config object? -----
  var cfg = window.__FIREBASE_CONFIG__;
  if (!cfg || typeof cfg !== 'object') {
    var cfgMsg = 'window.__FIREBASE_CONFIG__ is missing or invalid. ' +
      'Open js/firebase-config.js and fill in the values from your ' +
      'Firebase project (Console -> Project settings -> General -> Your apps).';
    console.error('[EstatePro] ' + cfgMsg);
    window.App.Firebase = failStub(cfgMsg);
    return;
  }

  // Helpful nag if the user hasn't replaced the placeholders yet.
  var placeholder = 'REPLACE_WITH_';
  var hasPlaceholder = Object.keys(cfg).some(function (key) {
    return typeof cfg[key] === 'string' &&
      cfg[key].indexOf(placeholder) === 0;
  });
  if (hasPlaceholder) {
    console.warn('[EstatePro] firebase-config.js still has placeholder values. ' +
      'Edit js/firebase-config.js with your real Firebase project config.');
  }

  // ---- 3. Initialize each Firebase service separately, so we can ----
  //         catch the exact one that failed (including silent partial init).
  //
  // We tried calling them all in one try/catch first — but firebase.firestore()
  // occasionally returns undefined WITHOUT throwing when Firestore isn't enabled,
  // which makes initErr stay null and we silently end up with db:undefined.
  // That produced an unhelpful "App.Firebase is not initialized." in the UI.
  var app = null;
  var auth = null;
  var db = null;
  var failures = [];

  // (a) initializeApp
  try {
    app = firebase.initializeApp(cfg);
  } catch (e) {
    failures.push('firebase.initializeApp() threw: ' +
      (e && e.message ? e.message : String(e)));
  }
  if (app && typeof app !== 'object') {
    failures.push('firebase.initializeApp() returned a non-object.');
  }

  // (b) firebase.auth() — only if initializeApp succeeded.
  if (app) {
    try {
      auth = firebase.auth();
    } catch (e) {
      failures.push('firebase.auth() threw: ' +
        (e && e.message ? e.message : String(e)));
    }
    if (!auth) {
      failures.push('firebase.auth() returned no Auth instance. ' +
        'Email/Password sign-in may be disabled in this Firebase project.');
    }
  } else {
    failures.push('Skipped firebase.auth() because initializeApp failed.');
  }

  // (c) firebase.firestore() — the most common silent failure. When
  //     Firestore is not enabled in the Firebase project, the SDK commonly
  //     returns undefined here without throwing, so we MUST inspect the
  //     result and not just rely on try/catch.
  if (app) {
    try {
      db = firebase.firestore();
    } catch (e) {
      failures.push('firebase.firestore() threw: ' +
        (e && e.message ? e.message : String(e)));
    }
    if (!db) {
      failures.push(
        'firebase.firestore() returned no Firestore instance. ' +
        'The most common cause is that Cloud Firestore is not enabled in ' +
        'your project. Open the Firebase console -> Build -> Firestore ' +
        'Database and click "Create database". See FIREBASE-SETUP.md step 1.'
      );
    }
  } else {
    failures.push('Skipped firebase.firestore() because initializeApp failed.');
  }

  // ---- 4. Decide success vs failure, and build the stub ----------------
  if (failures.length === 0 && app && auth && db) {
    window.App.Firebase = {
      app: app,
      auth: auth,
      db: db,
      isReady: function () { return !!(this.app && this.auth && this.db); },
      whyNotReady: function () { return ''; }
    };
    return;
  }

  // Failure path. Build a single message from the collected failures so the
  // banner and register/login paths see something useful.
  var initMsg = failures.length
    ? failures.join(' ')
    : 'Firebase did not initialize, but no specific cause was captured. ' +
      'Open the browser dev console for the full error.';

  console.error('[EstatePro] ' + initMsg);
  window.App.Firebase = failStub(initMsg);
})();
