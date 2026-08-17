#!/usr/bin/env node
'use strict';
/**
 * Reset an employee's password, or list the accounts, straight against the
 * database. This is the way back in if the administrator password is lost —
 * there is deliberately no password reset over the web.
 *
 *   node scripts/reset-password.js --list
 *   node scripts/reset-password.js admin 'novo-geslo'
 *   node scripts/reset-password.js admin            # generates one for you
 *
 * Honours SALON_DB, so on a server run it with the same value the service uses:
 *   sudo -u salon SALON_DB=/opt/salon/data/salon.db node scripts/reset-password.js admin
 */

const path = require('path');
const crypto = require('crypto');

const employees = require(path.join(__dirname, '..', 'src', 'repo', 'employees'));
const util = require(path.join(__dirname, '..', 'src', 'util'));
const { DB_FILE } = require(path.join(__dirname, '..', 'src', 'db'));

const args = process.argv.slice(2);

function listAccounts() {
  const all = employees.list();
  if (!all.length) {
    console.log('No accounts exist yet. Start the app once to create the first administrator.');
    return;
  }
  console.log(`Database: ${DB_FILE}\n`);
  console.log('username        role      status     name');
  console.log('--------------- --------- ---------- --------------------');
  for (const e of all) {
    console.log(
      `${e.username.padEnd(15)} ${e.role.padEnd(9)} ` +
      `${(e.active ? 'active' : 'INACTIVE').padEnd(10)} ${util.fullName(e)}`
    );
  }
}

if (!args.length || args[0] === '--help' || args[0] === '-h') {
  console.log(`Reset an employee password.

  node scripts/reset-password.js --list
  node scripts/reset-password.js <username> [new-password]

Omit the password and a strong one is generated and printed.`);
  process.exitCode = 0;
} else if (args[0] === '--list' || args[0] === '-l') {
  listAccounts();
} else {
  const username = args[0];
  const employee = employees.byUsername(username);

  if (!employee) {
    console.error(`No account with username "${username}".\n`);
    listAccounts();
    process.exitCode = 1;
  } else {
    let password = args[1];
    let generated = false;
    if (!password) {
      // url-safe, no ambiguous characters to mistype
      password = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
      generated = true;
    }

    if (password.length < 6) {
      console.error('Password must be at least 6 characters.');
      process.exitCode = 1;
    } else {
      employees.setPassword(employee.id, password);

      // A deactivated account cannot log in however good the password is.
      let note = '';
      if (!employee.active) {
        employees.update(employee.id, { ...employee, active: 1 });
        note = ' (account was inactive — reactivated)';
      }

      console.log(`Password reset for ${util.fullName(employee)} [${employee.username}]${note}`);
      if (generated) console.log(`New password: ${password}`);
      console.log('\nSign in, then change it under Zaposleni -> Uredi -> Ponastavi geslo.');
    }
  }
}
