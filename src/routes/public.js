'use strict';

const express = require('express');
const services = require('../repo/services');
const settings = require('../settings');
const util = require('../util');

const router = express.Router();

/**
 * The public website. Every piece of salon information comes from the settings
 * table and the services table, so nothing here needs editing in code.
 */
router.get('/', (req, res) => {
  const hours = settings.openingHoursList();
  const today = util.dayOfWeek(util.todayIso());

  res.render('public/home', {
    title: settings.get('salon_name'),
    services: services.active(),
    hours: hours.map((day) => ({ ...day, isToday: day.day === today })),
  });
});

module.exports = router;
