'use strict';

const express = require('express');
const sms = require('../sms');

const router = express.Router();

/**
 * Delivery receipts from the gateway.
 *
 * Mounted before the session and CSRF layers: the caller is a provider, not a
 * browser, so it has no session and cannot hold a CSRF token. The shared secret
 * in the path is what authenticates it, so SMS_DLR_SECRET must be long and
 * random. Without that variable the endpoint does not exist at all.
 *
 * Give the provider this URL:
 *   https://your-domain/sms/dlr/<SMS_DLR_SECRET>
 */
router.post('/sms/dlr/:secret', (req, res) => {
  const expected = process.env.SMS_DLR_SECRET;
  if (!expected) return res.status(404).json({ ok: false });

  // Compare in a way that does not leak the length through early exit.
  const supplied = String(req.params.secret || '');
  if (supplied.length !== expected.length || supplied !== expected) {
    return res.status(403).json({ ok: false });
  }

  const result = sms.applyReceipt(req.body);
  if (!result.ok) {
    // Answer 200 anyway: a provider that sees an error will keep redelivering
    // the same receipt forever. The reason is logged for the operator instead.
    console.warn('[SMS] neuporabno sporočilo o dostavi:', result.error);
    return res.json({ ok: false, error: result.error });
  }
  return res.json({ ok: true, status: result.status || 'ignored' });
});

module.exports = router;
