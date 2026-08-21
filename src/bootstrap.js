'use strict';

const { db } = require('./db');
const employees = require('./repo/employees');
const services = require('./repo/services');
const products = require('./repo/products');
const customers = require('./repo/customers');
const settings = require('./settings');

/**
 * First-run setup. Creates an admin account so the salon can sign in, plus a
 * small set of example services and products. Runs only when the database is
 * empty, so it never overwrites real salon data.
 */
function ensureSeed() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM employees').get();
  if (n > 0) return false;

  const password = process.env.ADMIN_PASSWORD || 'admin123';

  employees.create({
    first_name: 'Salon',
    last_name: 'Skrbnik',
    username: 'admin',
    email: '',
    password,
    role: 'admin',
    active: 1,
  });
  employees.create({
    first_name: 'Maja',
    last_name: 'Novak',
    username: 'maja',
    email: '',
    password,
    role: 'employee',
    active: 1,
  });
  employees.create({
    first_name: 'Sara',
    last_name: 'Kovač',
    username: 'sara',
    email: '',
    password,
    role: 'employee',
    active: 1,
  });

  const exampleServices = [
    { name: 'Žensko striženje', duration_min: 45, price_cents: 2500, sort_order: 1 },
    { name: 'Moško striženje', duration_min: 30, price_cents: 1800, sort_order: 2 },
    { name: 'Barvanje las', duration_min: 90, price_cents: 5500, sort_order: 3 },
    { name: 'Umivanje in fen', duration_min: 30, price_cents: 1500, sort_order: 4 },
    { name: 'Otroško striženje', duration_min: 20, price_cents: 1200, sort_order: 5 },
  ];
  for (const service of exampleServices) {
    services.create({ ...service, description: '', active: 1 });
  }

  const exampleProducts = [
    { name: 'Šampon', quantity: 12, price_cents: 1490 },
    { name: 'Maska za lase', quantity: 5, price_cents: 1990 },
    { name: 'Lak za lase', quantity: 18, price_cents: 990 },
  ];
  for (const product of exampleProducts) {
    products.create({ ...product, description: '', active: 1 });
  }

  const exampleCustomers = [
    { first_name: 'Ana', last_name: 'Novak', phone: '031 123 456', visit_count: 8 },
    { first_name: 'Marko', last_name: 'Horvat', phone: '041 555 111', visit_count: 3 },
    { first_name: 'Sara', last_name: 'Kovač', phone: '040 222 333', visit_count: 9 },
  ];
  for (const customer of exampleCustomers) {
    customers.create({ ...customer, email: '', notes: '' });
  }

  // Give the salon a usable starting identity; the admin edits this in Settings.
  settings.setMany({
    salon_name: 'Frizerstvo Berni',
    slogan: 'Frizerske storitve',
    phone: '031 123 456',
    logo_url: '/img/logo.png',
    emblem_url: '/img/emblem.jpg',
  });

  console.log('Prvi zagon: ustvarjen skrbniški račun.');
  console.log(`  username: admin    password: ${password}`);
  return true;
}

module.exports = { ensureSeed };
