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

  window.App = window.App || {};

  if (typeof firebase === 'undefined') {
    var msg = 'Firebase SDK scripts did not load. Check that the three ' +
      '<script> tags for firebase-app, firebase-auth and firebase-firestore ' +
      'come before js/firebase-bridge.js in your HTML.';
    console.error('[EstatePro] ' + msg);
    window.App.Firebase = {
      app: null,
      auth: null,
      db: null,
      isReady: function () { return false; },
      whyNotReady: function () { return msg; }
    };
    return;
  }

  var cfg = window.__FIREBASE_CONFIG__;
  if (!cfg || typeof cfg !== 'object') {
    var cfgMsg = 'window.__FIREBASE_CONFIG__ is missing or invalid. ' +
      'Open js/firebase-config.js and fill in the values from your ' +
      'Firebase project (Console -> Project settings -> General -> Your apps).';
    console.error('[EstatePro] ' + cfgMsg);
    window.App.Firebase = {
      app: null,
      auth: null,
      db: null,
      isReady: function () { return false; },
      whyNotReady: function () { return cfgMsg; }
    };
    return;
  }

  var placeholder = 'REPLACE_WITH_';
  var hasPlaceholder = Object.keys(cfg).some(function (key) {
    return typeof cfg[key] === 'string' && cfg[key].indexOf(placeholder) === 0;
  });
  if (hasPlaceholder) {
    console.warn('[EstatePro] firebase-config.js still has placeholder values. ' +
      'Edit js/firebase-config.js with your real Firebase project config.');
  }

  var app, auth, db, initErr = null;
  try {
    app = firebase.initializeApp(cfg);
    auth = firebase.auth();
    db = firebase.firestore();
  } catch (e) {
    initErr = e;
  }

  if (initErr) {
    var initMsg = 'firebase.initializeApp() threw: ' +
      (initErr && initErr.message ? initErr.message : String(initErr)) +
      '. Open the browser console for the full error.';
    console.error('[EstatePro] ' + initMsg, initErr);
    window.App.Firebase = {
      app: null,
      auth: null,
      db: null,
      isReady: function () { return false; },
      whyNotReady: function () { return initMsg; }
    };
    return;
  }

  // Success.
  window.App.Firebase = {
    app: app,
    auth: auth,
    db: db,
    isReady: function () { return !!(this.app && this.auth && this.db); },
    whyNotReady: function () { return ''; }
  };
})();
