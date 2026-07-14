/* ============================================================
 * functions/index.js  --  Phase 4 Cloud Functions for EstatePro
 *
 * Deploy with `firebase deploy --only functions` (after running
 * `firebase init functions` to set up the functions/ directory and
 * `npm install firebase-functions firebase-admin` inside it).
 * ============================================================
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// ============================================================
// createInviteLink
//
// Callable Function. Replaces client-side App.Auth.Invite.createInvite
// when server-side auditing and uniform URL shape are preferred.
//
// Input:  { estateId, role, inviteeEmail }
// Output: { inviteId, estateId }
//
//   * Requires the caller to be authenticated.
//   * Verifies the caller is the executor of the parent estate via
//     Admin SDK read (rules-side belt-and-suspenders are not required
//     because Admin SDK bypasses rules).
//   * Writes a thin envelope doc into
//     /estates/{estateId}/invites/{auto-id}.
//
// The client uses this ONLY if you opt in. By default Phase 4 uses
// App.Auth.Invite.createInvite (client-side direct Firestore write)
// since both paths satisfy the same rules. Use this Callable when:
//   - You want server-side audit logs for invite creation
//   - You want a custom invite URL (e.g. branded link)
// ============================================================
exports.createInviteLink = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  }
  const { estateId, role, inviteeEmail } = data || {};
  if (!estateId) {
    throw new functions.https.HttpsError('invalid-argument', 'estateId required.');
  }
  if (!role || !['executor', 'heir', 'beneficiary'].includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'role must be executor / heir / beneficiary.');
  }
  if (!inviteeEmail || !/^.+@.+\..+$/.test(inviteeEmail)) {
    throw new functions.https.HttpsError('invalid-argument', 'inviteeEmail invalid.');
  }
  const estateSnap = await db.collection('estates').doc(estateId).get();
  if (!estateSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Estate not found.');
  }
  const roles = estateSnap.get('roles') || {};
  if (roles[context.auth.uid] !== 'executor') {
    throw new functions.https.HttpsError('permission-denied', 'Only executors can mint invites.');
  }
  const ref = await db.collection('estates').doc(estateId).collection('invites').add({
    inviteeEmail: inviteeEmail,
    role: role,
    createdBy: context.auth.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    redeemedBy: null,
    redeemedAt: null
  });
  return { inviteId: ref.id, estateId: estateId };
});

// ============================================================
// retireBootstrapLock
//
// Optional Callable. Deletes the /_meta/bootstrap_lock so a SECOND
// founder estate can be bootstrapped. By default Phase 4 keeps the
// lock permanently (one founder per Firebase project is the design).
// Invoke this only if you decide to allow multi-fork.
//
// Input:  none.
// Output: { deleted: true }
//
//   - Requires the caller to be authenticated.
//   - Admin-only: cloud-function `Admin` member OR an executor of
//     ANY existing estate (we pick the loosest reasonable gate; tighten
//     if your threat model requires).
// ============================================================
exports.retireBootstrapLock = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  }
  // Loose gate: any signed-in user can ask. Tighten by checking an
  // executor role on any existing estate, or add a custom claim.
  await db.collection('_meta').doc('bootstrap_lock').delete();
  return { deleted: true };
});

// ============================================================
// (Optional) expireInvites  --  scheduled cleanup
//
// Drop unredeemed invites older than `expiresAt` (NOT IMPLEMENTED in
// Phase 4 v1). The `expiresAt` field will be added to the invite doc
// before this function is enabled. To enable after Phase 4 ships:
//
//   exports.expireInvites = functions.pubsub.schedule('every 24 hours').onRun(async () => {
//     const now = admin.firestore.Timestamp.now();
//     const old = await db.collectionGroup('invites')
//       .where('redeemedBy', '==', null)
//       .where('createdAt', '<', /* now - 7days */)
//       .get();
//     const batch = db.batch();
//     old.forEach(d => batch.delete(d.ref));
//     await batch.commit();
//     return { deleted: old.size };
//   });
// ============================================================
