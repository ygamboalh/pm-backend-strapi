'use strict';

/**
 * types service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::types.types');
