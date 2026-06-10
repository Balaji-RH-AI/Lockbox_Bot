// Restore the full Lockbox form from the backup made by trim-lockbox-for-test.js.
// Run:  node scripts/restore-lockbox.js

const fs = require('fs');
const path = require('path');

const FORMS = path.join(__dirname, '..', 'forms');
const SRC = path.join(FORMS, 'lockbox-master.json');
const BACKUP = path.join(FORMS, 'lockbox-master.full.backup.json');

if (!fs.existsSync(BACKUP)) {
  console.error('No backup found (forms/lockbox-master.full.backup.json). Nothing to restore.');
  process.exit(1);
}
fs.copyFileSync(BACKUP, SRC);
console.log('Restored full Lockbox form from backup. (Backup file left in place.)');
