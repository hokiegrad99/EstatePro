/* ============================================================
 * Firebase bridge — exposes App.Firebase for the rest of the app
 * ============================================================
 * Loaded AFTER the Firebase compat SDKs and js/firebase-config.js,
 * BEFORE js/app.js. See FIREBASE-SETUP.md for the script tag order.
 *
 * After this script runs, the rest of the app can access:
 *   - App.Firebase.app   : the FirebaseApp instance
 *   - App.Firebase.auth  : firebase.auth.Auth
 *   - App.Firebase.db    : firebase.firestore.Firestore
 * ============================================================ */

(function () {
  'use strict';

  if (typeof firebase === 'undefined') {
    console.error(
      '[EstatePro] Firebase SDK is not loaded. Make sure the Firebase compat ' +
      'SDK scripts come before js/firebase-bridge.js in your HTML.'
    );
    window.App = window.App || {};
    window.App.Firebase = null;
    return;
  }

  var cfg = window.__FIREBASE_CONFIG__;
  if (!cfg || typeof cfg !== 'object') {
    console.error('[EstatePro] window.__FIREBASE_CONFIG__ is missing. ' +
      'Make sure js/firebase-config.js is loaded before js/firebase-bridge.js ' +
      'and contains your Firebase project config.');
    window.App = window.App || {};
    window.App.Firebase = null;
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

  try {
    var app = firebase.initializeApp(cfg);
    window.App = window.App || {};
    window.App.Firebase = {
      app: app,
      auth: firebase.auth(),
      db: firebase.firestore()
    };
  } catch (e) {
    console.error('[EstatePro] firebase.initializeApp threw:', e);
    window.App = window.App || {};
    window.App.Firebase = null;
  }
})();
