'use strict';

/**
 * encargo service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::encargo.encargo');
