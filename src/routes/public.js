'use strict';

const express = require('express');
const services = require('../repo/services');
const settings = require('../settings');
const booking = require('../booking');
const util = require('../util');

const router = express.Router();

/**
 * The public website. Every piece of salon information comes from the settings
 * table and the services table, so nothing here needs editing in code.
 */
router.get('/', (req, res) => {
  const hours = settings.openingHoursList();
  const today = util.dayOfWeek(util.todayIso());
  const values = res.locals.settings;

  res.render('public/home', {
    title: values.salon_name,
    highlights: settings.highlights(values),
    writtenCards: settings.serviceCards(values),
    services: services.active(),
    bookingEnabled: booking.isEnabled(),
    hours: hours.map((day) => ({ ...day, isToday: day.day === today })),
  });
});

module.exports = router;
