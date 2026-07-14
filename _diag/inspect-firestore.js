// Comprehensive Firestore state inspector for EstatePro Phase 4 diagnostics.
// Loaded via `NODE_PATH=/tmp/ftdiag/node_modules node inspect-firestore.js`.
//
// Reads (via firebase-tools API which uses the firebase CLI's logged-in OAuth):
//   - /estates (top-level collection) + each doc's full body
//   - /_meta (top-level collection)
//   - /estates/{docId}/invites (subcollection on each estate doc)
//
// Output is JSON, with section markers so we can grep for each.
//
// Required env: NODE_PATH=/tmp/ftdiag/node_modules (firebase-tools installed there).

const M = require('/tmp/ftdiag/node_modules/firebase-tools');

async function main() {
  console.log('=== SECTION: /estates top-level list ===');
  let docs = [];
  try {
    docs = await M.Firestore.list('/estates', { project: 'estatepro-58f7b' });
    console.log(JSON.stringify(docs, null, 2));
  } catch (e) {
    console.error('LIST /estates fail:', e.message);
  }

  console.log('=== SECTION: /_meta top-level list ===');
  try {
    const meta = await M.Firestore.list('/_meta', { project: 'estatepro-58f7b' });
    console.log(JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error('LIST /_meta fail:', e.message);
  }

  console.log('=== SECTION: each estate doc full body + invites subcollection ===');
  if (!docs || !docs.length) {
    console.log('NO ESTATE DOCS at /estates in this project.');
  } else {
    for (const doc of docs) {
      const docId = (doc.name || '').split('/').pop();
      console.log('--- /estates/' + docId + ' (full doc) ---');
      try {
        const full = await M.Firestore.get('/estates/' + docId, { project: 'estatepro-58f7b' });
        console.log(JSON.stringify(full, null, 2));
      } catch (e) {
        console.error('  get-doc fail:', e.message);
      }
      console.log('--- /estates/' + docId + '/invites (subcollection) ---');
      try {
        const inv = await M.Firestore.list('/estates/' + docId + '/invites', { project: 'estatepro-58f7b' });
        console.log(JSON.stringify(inv, null, 2));
      } catch (e) {
        console.error('  list-invites fail:', e.message);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
