'use strict';

/**
 * storefront router (público, sin autenticación)
 */

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/storefront',
      handler: 'storefront.index',
      config: {
        auth: false,
        policies: [],
      },
    },
  ],
};
