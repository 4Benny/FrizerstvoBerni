'use strict';

const appointments = require('./repo/appointments');
const customers = require('./repo/customers');
const settings = require('./settings');
const util = require('./util');

/**
 * The visit counter, kept automatically.
 *
 * Booking a termin counts as a visit. When the counter reaches the salon's
 * threshold (Nastavitve → *Število plačanih striženj do brezplačnega*) the
 * customer is shown as due a free visit; booking that one redeems it and the
 * counter goes back to zero.
 *
 * Every appointment records exactly what it did — `loyalty_delta` — so the
 * effect can be undone precisely when the termin is cancelled and redone if it
 * is re-opened. The stored figure is what makes this safe when the salon later
 * changes the threshold: reversal gives back what was actually spent, not what
 * the setting happens to say today.
 *
 * Staff can still correct the counter by hand on the customer page; nothing
 * here overrides a manual figure, it only adds and removes its own effect.
 */

/** Statuses that mean the visit is happening or has happened. */
const COUNTING_STATUSES = ['scheduled', 'completed'];

function required() {
  return Math.max(1, settings.getInt('paid_before_free') || 1);
}

function stateFor(customer) {
  return util.loyalty(customer && customer.visit_count, required());
}

/**
 * What booking this appointment now would do, without doing it.
 * Returns { isFree, delta } — delta is the change to the visit counter.
 */
function planFor(customer) {
  const target = required();
  const eligible = util.loyalty(customer && customer.visit_count, target).eligible;
  // Redeeming spends the whole balance; an ordinary visit adds one.
  return eligible ? { isFree: true, delta: -target } : { isFree: false, delta: 1 };
}

/**
 * Apply the effect an appointment has already recorded. Used when a cancelled
 * termin is re-opened, so it counts again exactly as it did before.
 */
function apply(appt) {
  if (!appt || appt.loyalty_applied) return null;
  const customer = customers.adjustVisitCount(appt.customer_id, appt.loyalty_delta);
  appointments.setLoyaltyApplied(appt.id, true);
  return customer;
}

/**
 * Undo the effect of an appointment that is no longer happening — cancelled or
 * marked as a no-show. Undoing a redeemed visit gives the credit back, so the
 * customer is owed their free visit again.
 */
function reverse(appt) {
  if (!appt || !appt.loyalty_applied) return null;
  const customer = customers.adjustVisitCount(appt.customer_id, -appt.loyalty_delta);
  appointments.setLoyaltyApplied(appt.id, false);
  return customer;
}

/**
 * Bring an appointment's loyalty effect in line with a new status. Returns the
 * updated customer when something changed, otherwise null.
 */
function syncToStatus(appt, status) {
  if (!appt) return null;
  const shouldCount = COUNTING_STATUSES.includes(status);
  if (shouldCount && !appt.loyalty_applied) return apply(appt);
  if (!shouldCount && appt.loyalty_applied) return reverse(appt);
  return null;
}

module.exports = {
  COUNTING_STATUSES,
  required,
  stateFor,
  planFor,
  apply,
  reverse,
  syncToStatus,
};
