'use strict';

function isInStock(product) {
  const vendor = (product.takenByVendor || '').trim();
  return !vendor || vendor === 'En stock' || vendor === 'No asignado';
}

function mediaUrl(media) {
  if (!media) return null;
  return (
    media.formats?.small?.url ||
    media.formats?.thumbnail?.url ||
    media.url ||
    null
  );
}

function mapProduct(product, status, usdPrice) {
  const usd = Number(usdPrice) || 0;
  const shopPrice = Number(product.shopPrice) || 0;
  const poundPrice = Number(product.poundPrice) || 0;
  const weight = Number(product.weight) || 0;
  const gainPercent = Number(product.gainPercent) || 0;

  const cost = Math.round(shopPrice * usd * 1.12 + weight * poundPrice * usd);
  const suggested =
    cost > 0 ? Math.round(cost * (1 + gainPercent / 100)) : 0;
  const rounded = Math.round(suggested / 1000) * 1000;
  const price = rounded > 0 ? rounded : suggested || Number(product.sellPrice) || 0;

  return {
    id: product.documentId,
    description: product.productDescription || 'Producto',
    category: product.category || 'Otros',
    price,
    image: mediaUrl(product.productImage?.[0]),
    status,
  };
}

module.exports = {
  async index(ctx) {
    const [configurations, products, types] = await Promise.all([
      strapi.documents('api::configuration.configuration').findMany({
        status: 'published',
        sort: ['configCreatedAt:desc'],
        limit: 1,
      }),
      strapi.documents('api::product.product').findMany({
        status: 'published',
        populate: ['productImage'],
        sort: ['productCreatedAt:desc'],
        limit: 1000,
      }),
      strapi.documents('api::types.types').findMany({
        status: 'published',
        sort: ['typeId:asc'],
        limit: 100,
      }),
    ]);

    const configuration = configurations[0] || {};
    const visibleProducts = (products || []).filter(
      (product) => product.category !== 'Conjunto',
    );

    const available = visibleProducts
      .filter(
        (product) =>
          ['Recibido', 'Disponible'].includes(product.deliveredStatus) &&
          isInStock(product),
      )
      .map((product) => mapProduct(product, 'available', configuration.usdPrice));

    const coming = visibleProducts
      .filter((product) => product.deliveredStatus === 'Comprado')
      .map((product) => mapProduct(product, 'coming', configuration.usdPrice));

    const categories = (types || [])
      .map((type) => type.description)
      .filter(Boolean)
      .filter((description) => description !== 'Conjunto');

    ctx.body = {
      whatsappNumber: configuration.contactPhone || '',
      categories,
      available,
      coming,
    };
  },
};
