'use strict';

async function grantPermissions(strapi, uid, actions) {
  try {
    const role = await strapi
      .query('plugin::users-permissions.role')
      .findOne({ where: { type: 'authenticated' } });

    if (!role) return;

    for (const action of actions) {
      const actionId = `${uid}.${action}`;
      const existing = await strapi
        .query('plugin::users-permissions.permission')
        .findOne({ where: { action: actionId, role: role.id } });

      if (!existing) {
        await strapi
          .query('plugin::users-permissions.permission')
          .create({ data: { action: actionId, role: role.id } });
      }
    }
  } catch (error) {
    strapi.log.error(`No se pudieron asignar permisos a ${uid}: ${error.message}`);
  }
}

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    await grantPermissions(strapi, 'api::cash.cash', [
      'find',
      'findOne',
      'create',
      'update',
      'delete',
    ]);
    await grantPermissions(strapi, 'api::types.types', ['find', 'findOne']);
  },
};
