'use strict';

/**
 * Migración de la base antigua (Prisma/SQLite) a Strapi.
 *
 * Uso:
 *   node scripts/migrate-old-data.js --dry-run   (solo reporte)
 *   node scripts/migrate-old-data.js             (borra y migra)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const mime = require('mime-types');
const sharp = require('sharp');

const BASE_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const EMAIL = process.env.STRAPI_EMAIL || 'demo@primera-mano.local';
const PASSWORD = process.env.STRAPI_PASSWORD || 'Demo1234!';

const OLD_DB =
  process.env.OLD_DB || 'D:/Work/Proyectos/cuba-arbitraje-app-main/prisma/bd.db';
const OLD_UPLOADS =
  process.env.OLD_UPLOADS ||
  'D:/Work/Proyectos/cuba-arbitraje-app-main/public/uploads';
const NEW_DB =
  process.env.NEW_DB || 'D:/Work/Proyectos/pm-backend-strapi/.tmp/data.db';

const DRY_RUN = process.argv.includes('--dry-run');
const GAIN_PERCENT = 35;

const CATEGORY_MAP = {
  'Zapatos de niños': 'Zapatos de niño',
  Ventiladores: 'Ventilador recargable',
  'Relojes inteligentes': 'Reloj inteligente',
};

const STATUS_MAP = {
  Entregado: 'Entregado',
  Pendiente: 'Pendiente',
  Recibido: 'Recibido',
  Comprado: 'Comprado',
};

let token = null;
let tokenAt = 0;

const round = (value) => Math.round(Number(value) || 0);
const num = (value) => Number(value) || 0;
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const iso = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const addMonth = (value) => {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return null;
  date.setMonth(date.getMonth() + 1);
  return date.toISOString();
};

function mapSentBy(value) {
  if (!value) return 'Avion';
  if (value === 'Avión' || value === 'Avion') return 'Avion';
  return value === 'Barco' ? 'Barco' : 'Avion';
}

function mapProductStatus(product) {
  if (product.availableStatus === 'Eliminado') return null;
  if (product.arrivedStatus === 'Comprado') return 'Comprado';
  if (product.availableStatus === 'Vendido') return 'Vendido';
  if (product.arrivedStatus === 'Recibido') return 'Recibido';
  return 'Comprado';
}

async function login() {
  const response = await fetch(`${BASE_URL}/api/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: EMAIL, password: PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(`Login falló (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  token = data.jwt;
  tokenAt = Date.now();
}

async function ensureToken() {
  if (!token || Date.now() - tokenAt > 8 * 60 * 1000) {
    await login();
  }
}

async function request(urlPath, options = {}) {
  await ensureToken();

  const response = await fetch(`${BASE_URL}${urlPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method || 'GET'} ${urlPath} → ${response.status}: ${body}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchCollection(plural, { published = true } = {}) {
  const pageSize = 100;
  let page = 1;
  let pageCount = 1;
  const items = [];

  do {
    const params = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': String(pageSize),
    });
    if (published) params.set('status', 'published');

    const json = await request(`/api/${plural}?${params.toString()}`);
    items.push(...(json?.data ?? []));
    pageCount = json?.meta?.pagination?.pageCount ?? 1;
    page += 1;
  } while (page <= pageCount);

  return items;
}

async function deleteAll(plural) {
  const documents = new Map();
  const published = await fetchCollection(plural, { published: true });
  published.forEach((item) => documents.set(item.documentId, item));

  try {
    const drafts = await fetchCollection(plural, { published: false });
    drafts.forEach((item) => documents.set(item.documentId, item));
  } catch {
    // Algunos modelos no permiten status=draft; los publicados ya están cubiertos.
  }

  for (const documentId of documents.keys()) {
    await request(`/api/${plural}/${documentId}`, { method: 'DELETE' });
  }

  return documents.size;
}

async function fetchAllMedia() {
  const pageSize = 100;
  let page = 1;
  let pageCount = 1;
  const items = [];

  do {
    const json = await request(
      `/api/upload/files?pagination[page]=${page}&pagination[pageSize]=${pageSize}`,
    );
    const files = Array.isArray(json) ? json : json?.data ?? [];
    items.push(...files);
    pageCount = json?.meta?.pagination?.pageCount ?? 1;
    page += 1;
  } while (page <= pageCount);

  return items;
}

async function uploadBuffer(buffer, filename, type) {
  const form = new FormData();
  form.append('files', new Blob([buffer], { type }), filename);

  const response = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Upload ${filename} → ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  const file = Array.isArray(json) ? json[0] : json?.data ?? json;

  if (!file?.id) {
    throw new Error(`Upload ${filename} no devolvió un archivo válido`);
  }

  return file;
}

async function placeholderPng() {
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
      <rect width="100%" height="100%" fill="#121D33"/>
      <text x="50%" y="50%" fill="#64748B" font-family="Arial, sans-serif"
        font-size="44" text-anchor="middle" dominant-baseline="middle">Sin imagen</text>
    </svg>`,
  );

  return sharp({
    create: { width: 640, height: 640, channels: 3, background: '#121D33' },
  })
    .composite([{ input: label, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function ensureMediaFolders() {
  const db = new Database(NEW_DB);
  db.pragma('busy_timeout = 5000');

  const maxPath = db.prepare('select max(path_id) as value from upload_folders').get();
  let nextPathId = (Number(maxPath?.value) || 0) + 1;
  const now = Date.now();
  const folders = {};

  for (const name of ['products', 'encargos', 'tax']) {
    const existing = db
      .prepare('select * from upload_folders where name = ? order by id asc limit 1')
      .get(name);

    if (existing) {
      folders[name] = existing;
      continue;
    }

    const documentId = crypto.randomBytes(12).toString('hex');
    const info = db
      .prepare(
        `insert into upload_folders
          (document_id, name, path_id, path, created_at, updated_at, published_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(documentId, name, nextPathId, `/${nextPathId}`, now, now, now);

    folders[name] = {
      id: Number(info.lastInsertRowid),
      name,
      path: `/${nextPathId}`,
    };
    nextPathId += 1;
  }

  db.close();
  return folders;
}

function assignFilesToFolder(fileIds, folder) {
  if (fileIds.length === 0) return;

  const db = new Database(NEW_DB);
  db.pragma('busy_timeout = 5000');
  const update = db.prepare('update files set folder_path = ? where id = ?');
  const link = db.prepare(
    'insert into files_folder_lnk (file_id, folder_id, file_ord) values (?, ?, ?)',
  );

  fileIds.forEach((id, index) => {
    update.run(folder.path, id);
    link.run(id, folder.id, index);
  });

  db.close();
}

function oldRows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function oldSum(db, sql) {
  return db.prepare(sql).get()?.value || 0;
}

function loadOldData() {
  const db = new Database(OLD_DB, { readonly: true });

  const products = oldRows(db, 'select * from Product order by id asc').filter(
    (product) => mapProductStatus(product) !== null,
  );
  const excluded = oldRows(
    db,
    "select id from Product where availableStatus = 'Eliminado'",
  ).length;
  const encargos = oldRows(db, 'select * from Encargo order by id asc');
  const shoppings = oldRows(db, 'select * from Shopping order by id asc');
  const cash = oldRows(db, 'select * from Efectivo order by createdAt asc');
  const taxes = oldRows(db, 'select * from Tax order by id asc');
  const summary = db.prepare('select * from Summary limit 1').get() || null;

  const encargoCounts = new Map();
  for (const encargo of encargos) {
    encargoCounts.set(
      encargo.shoppingId,
      (encargoCounts.get(encargo.shoppingId) || 0) + 1,
    );
  }

  const shoppingById = new Map(shoppings.map((item) => [item.id, item]));

  const productImagePaths = new Set(
    products.map((product) => product.photoURL).filter(Boolean),
  );
  const encargoImagePaths = new Set(
    encargos.map((encargo) => encargo.photoLink).filter(Boolean),
  );
  const taxImagePaths = new Set(taxes.map((tax) => tax.screenShotLink).filter(Boolean));

  const missingImages = new Set();
  for (const imagePath of productImagePaths) {
    const full = path.join(OLD_UPLOADS, imagePath.replace(/^\//, ''));
    if (!fs.existsSync(full)) missingImages.add(imagePath);
  }

  db.close();

  return {
    products,
    excluded,
    encargos,
    shoppings,
    cash,
    taxes,
    summary,
    encargoCounts,
    shoppingById,
    productImagePaths,
    encargoImagePaths,
    taxImagePaths,
    missingImages,
  };
}

function validateOldData(old) {
  const unmappedCategories = new Set();
  const unmappedStatuses = new Set();
  const unmappedEncargoStatus = new Set();

  for (const product of old.products) {
    const category = CATEGORY_MAP[product.category] || product.category;
    if (!category) unmappedCategories.add(product.category);
    if (product.category === 'Audífonos') continue;

    const status = mapProductStatus(product);
    if (!status) unmappedStatuses.add(product.availableStatus);
  }

  for (const encargo of old.encargos) {
    if (!STATUS_MAP[encargo.status]) unmappedEncargoStatus.add(encargo.status);
  }

  return { unmappedCategories, unmappedStatuses, unmappedEncargoStatus };
}

async function uploadImages(old, folders) {
  const filesByPath = new Map();
  const productIds = [];
  const encargoIds = [];
  const taxIds = [];

  async function uploadPath(imagePath, bucket) {
    if (filesByPath.has(imagePath)) {
      const cached = filesByPath.get(imagePath);
      if (bucket === 'products') productIds.push(cached.id);
      if (bucket === 'encargos') encargoIds.push(cached.id);
      if (bucket === 'tax') taxIds.push(cached.id);
      return cached;
    }

    const full = path.join(OLD_UPLOADS, imagePath.replace(/^\//, ''));
    if (!fs.existsSync(full)) {
      throw new Error(`Imagen no encontrada: ${full}`);
    }

    const filename = path.basename(full);
    const type = mime.lookup(filename) || 'application/octet-stream';
    const file = await uploadBuffer(fs.readFileSync(full), filename, type);
    filesByPath.set(imagePath, file);

    if (bucket === 'products') productIds.push(file.id);
    if (bucket === 'encargos') encargoIds.push(file.id);
    if (bucket === 'tax') taxIds.push(file.id);

    return file;
  }

  let uploaded = 0;
  const total =
    old.productImagePaths.size + old.encargoImagePaths.size + old.taxImagePaths.size + 1;

  const placeholder = await uploadBuffer(
    await placeholderPng(),
    'sin-imagen.png',
    'image/png',
  );
  uploaded += 1;
  console.log(`  [${uploaded}/${total}] sin-imagen.png (imagen de relleno)`);

  for (const imagePath of old.productImagePaths) {
    if (old.missingImages.has(imagePath)) {
      filesByPath.set(imagePath, placeholder);
      continue;
    }
    await uploadPath(imagePath, 'products');
    uploaded += 1;
    if (uploaded % 10 === 0) console.log(`  [${uploaded}/${total}] imágenes subidas`);
  }

  for (const imagePath of old.encargoImagePaths) {
    await uploadPath(imagePath, 'encargos');
    uploaded += 1;
    if (uploaded % 10 === 0) console.log(`  [${uploaded}/${total}] imágenes subidas`);
  }

  for (const imagePath of old.taxImagePaths) {
    await uploadPath(imagePath, 'tax');
    uploaded += 1;
  }

  assignFilesToFolder(productIds, folders.products);
  assignFilesToFolder(encargoIds, folders.encargos);
  assignFilesToFolder(taxIds, folders.tax);

  return { filesByPath, placeholder };
}

async function createConfiguration(summary) {
  if (!summary) {
    console.log('  Sin Summary: se omite la configuración.');
    return;
  }

  await request('/api/configurations?status=published', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        configCreatedAt: new Date().toISOString(),
        usdPrice: round(summary.usdPrice),
        poundPrice: num(summary.poundPrice),
        gainPercentForBusiness: round(summary.gainPercentForBusiness ?? GAIN_PERCENT),
        transferPercent: round(summary.transferPercent),
        totalGain: round(summary.totalGain),
        totalEncargos: round(summary.totalEncargos),
        pendingEncargos: round(summary.pendingEncargos),
        deliveredEncargos: round(summary.deliveredEncargos),
        totalShippingSpent: round(summary.totalShippingSpent),
        totalWeight: num(summary.totalWeight),
        totalBuySpent: round(summary.totalBuySpent),
        contactPhone: '',
      },
    }),
  });
}

async function createShoppings(old) {
  const idMap = new Map();
  let index = 0;

  for (const shopping of old.shoppings) {
    const json = await request('/api/shoppings?status=published', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          shoppingCreatedAt: iso(shopping.createdAt),
          totalWeight: num(shopping.totalWeight),
          shippingSpent: num(shopping.shippingSpent),
          buySpent: round(shopping.buySpent),
          usdPrice: round(shopping.usdPrice),
          poundPrice: num(shopping.poundPrice),
          gain: round(shopping.gain),
          totalSpent: round(shopping.totalSpent),
          isClosed: shopping.isClosed === 'Si',
          givenMoney: round(shopping.givenMoney),
          totalEncargos: old.encargoCounts.get(shopping.id) || 0,
          totalSpentUSD:
            shopping.totalSpentUSD !== null && shopping.totalSpentUSD !== undefined
              ? num(shopping.totalSpentUSD)
              : round2((Number(shopping.totalSpent) || 0) / (Number(shopping.usdPrice) || 1)),
          sentBy: 'Avion',
        },
      }),
    });

    idMap.set(shopping.id, {
      id: json.data.id,
      documentId: json.data.documentId,
    });
    index += 1;
    if (index % 5 === 0) console.log(`  ${index}/${old.shoppings.length} compras`);
  }

  return idMap;
}

async function createProducts(old, filesByPath, placeholder) {
  let index = 0;

  for (const product of old.products) {
    const status = mapProductStatus(product);
    const imagePath = product.photoURL;
    const file = filesByPath.get(imagePath) || placeholder;
    const category = CATEGORY_MAP[product.category] || product.category;

    await request('/api/products?status=published', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          productCreatedAt: iso(product.createdAt),
          usdPrice: round(product.usdPrice),
          poundPrice: num(product.poundPrice),
          shopPrice: num(product.shopPrice),
          sellPrice: round(product.sellPrice),
          soldPrice: round(product.soldPrice),
          totalCost: round(product.totalCost),
          weight: num(product.weight),
          soldDate: iso(product.soldDate) || iso(product.buyDate) || iso(product.createdAt),
          category,
          buyDate: iso(product.buyDate) || iso(product.createdAt),
          gainPlanned: round(product.gainPlanned),
          gainReal: round(product.gainReal),
          gainPercent: GAIN_PERCENT,
          productImage: [file.id],
          deliveredStatus: status,
          arrivedAt:
            status === 'Recibido' || status === 'Vendido'
              ? iso(product.buyDate) || iso(product.createdAt)
              : null,
          productDescription: product.productDescription || 'Sin descripción',
          shopName: product.shopName || 'Temu',
          sentBy: mapSentBy(product.sentBy),
          takenByVendor: (product.takenByVendor || '').trim() || 'En stock',
          dateTakenByVendor: iso(product.dayTakenByVendor),
        },
      }),
    });

    index += 1;
    if (index % 25 === 0) console.log(`  ${index}/${old.products.length} productos`);
  }
}

async function createEncargos(old, filesByPath, shoppingMap) {
  let index = 0;

  for (const encargo of old.encargos) {
    const file = filesByPath.get(encargo.photoLink);
    const shopping = old.shoppingById.get(encargo.shoppingId);
    const shoppingRef = shoppingMap.get(encargo.shoppingId);
    const shoppingId = shoppingRef?.id;

    if (!file) {
      throw new Error(`Encargo ${encargo.id} sin imagen: ${encargo.photoLink}`);
    }

    if (!shoppingId) {
      throw new Error(`Encargo ${encargo.id} apunta a compra inexistente ${encargo.shoppingId}`);
    }

    const poundPrice = num(encargo.poundPrice) || num(shopping?.poundPrice) || 4.5;
    const createdAt = iso(encargo.createdAt);
    const arrivedAt = addMonth(encargo.createdAt);

    await request('/api/encargos?status=published', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          shoppingId,
          ...(shoppingRef?.documentId ? { shopping: shoppingRef.documentId } : {}),
          ownerName: encargo.name || 'Sin nombre',
          encargoCreatedAt: createdAt,
          ownerPhoneNumber: encargo.phone || '—',
          shopName: encargo.shopName || 'Temu',
          productLink: encargo.productLink || 'Sin enlace',
          deliveredStatus: STATUS_MAP[encargo.status] || 'Pendiente',
          lastPaid: iso(encargo.lastpaid) || createdAt,
          payStatus: encargo.paystatus === 'Pagado' ? 'Pagado' : 'No pagado',
          productPrice: round(encargo.price),
          shopPrice: num(encargo.shopPrice),
          productWeight: num(encargo.weight),
          productDescription: encargo.productDescription || 'Sin descripción',
          poundPrice,
          sentBy: mapSentBy(encargo.sentBy),
          observation: encargo.observation || null,
          productImage: file.id,
          arrivedAt,
          deliveredAt: arrivedAt,
        },
      }),
    });

    index += 1;
    if (index % 10 === 0) console.log(`  ${index}/${old.encargos.length} encargos`);
  }
}

async function createTaxes(old, filesByPath) {
  for (const tax of old.taxes) {
    const file = filesByPath.get(tax.screenShotLink);

    if (!file) {
      throw new Error(`Impuesto ${tax.id} sin imagen: ${tax.screenShotLink}`);
    }

    await request('/api/taxes?status=published', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          taxCreatedAt: iso(tax.createdAt),
          description: tax.description || '',
          screenShotImage: file.id,
          month: tax.month || 'Sin mes',
          code: tax.reference || 'Sin código',
          amount: round(tax.amount),
          realPaid: num(tax.realPaid),
          paymentDate: iso(tax.paymentDay) || iso(tax.createdAt),
          gain: round((Number(tax.amount) || 0) - (Number(tax.realPaid) || 0)),
        },
      }),
    });
  }
}

async function createCash(old) {
  let index = 0;

  for (const movement of old.cash) {
    await request('/api/cashes', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          gasto: round(movement.gasto),
          ganancia: round(movement.ganancia),
          resto: round(movement.resto),
          motivoGasto: movement.motivoGasto || '',
          motivoGanancia: movement.motivoGanancia || '',
          movementDate: iso(movement.createdAt),
        },
      }),
    });

    index += 1;
    if (index % 25 === 0) console.log(`  ${index}/${old.cash.length} movimientos`);
  }
}

async function validateMigration(old) {
  const counts = {};
  for (const plural of [
    'products',
    'encargos',
    'shoppings',
    'taxes',
    'cashes',
    'configurations',
  ]) {
    const json = await request(`/api/${plural}?pagination[pageSize]=1`);
    counts[plural] = json?.meta?.pagination?.total ?? 0;
  }

  const newProducts = [];
  const pageSize = 100;
  let page = 1;
  let pageCount = 1;
  do {
    const json = await request(
      `/api/products?status=published&fields[0]=totalCost&fields[1]=soldPrice&fields[2]=gainReal&pagination[page]=${page}&pagination[pageSize]=${pageSize}`,
    );
    newProducts.push(...(json?.data ?? []));
    pageCount = json?.meta?.pagination?.pageCount ?? 1;
    page += 1;
  } while (page <= pageCount);

  const sumOld = (items, field) =>
    items.reduce((total, item) => total + (Number(item[field]) || 0), 0);
  const sumNew = (items, field) =>
    items.reduce((total, item) => total + (Number(item[field]) || 0), 0);

  const expected = {
    products: old.products.length,
    encargos: old.encargos.length,
    shoppings: old.shoppings.length,
    taxes: old.taxes.length,
    cashes: old.cash.length,
    configurations: 1,
  };

  console.log('\n=== Validación');
  for (const [plural, expectedCount] of Object.entries(expected)) {
    const actual = counts[plural];
    console.log(`  ${plural}: ${actual} / ${expectedCount}${actual === expectedCount ? ' OK' : ' ⚠'}`);
  }

  console.log(
    `  totalCost: ${sumNew(newProducts, 'totalCost')} / ${sumOld(old.products, 'totalCost')}`,
  );
  console.log(
    `  soldPrice: ${sumNew(newProducts, 'soldPrice')} / ${sumOld(old.products, 'soldPrice')}`,
  );
  console.log(
    `  gainReal: ${sumNew(newProducts, 'gainReal')} / ${sumOld(old.products, 'gainReal')}`,
  );

  const latestCash = await request('/api/cashes?sort=movementDate:desc&pagination[pageSize]=1');
  console.log(
    `  saldo final caja: ${latestCash?.data?.[0]?.resto ?? '—'} / ${
      old.cash[old.cash.length - 1]?.resto ?? '—'
    }`,
  );
}

async function main() {
  console.log('=== Migración base antigua → Strapi');
  console.log(`Modo: ${DRY_RUN ? 'DRY RUN' : 'ESCRITURA'}`);

  const old = loadOldData();
  const validation = validateOldData(old);

  console.log('\n=== Datos antiguos');
  console.log(`  Productos a importar: ${old.products.length} (excluidos ${old.excluded})`);
  console.log(`  Compras: ${old.shoppings.length}`);
  console.log(`  Encargos: ${old.encargos.length}`);
  console.log(`  Caja: ${old.cash.length}`);
  console.log(`  Impuestos: ${old.taxes.length}`);
  console.log(`  Configuración: ${old.summary ? 'sí' : 'no'}`);
  console.log(
    `  Imágenes únicas: productos ${old.productImagePaths.size}, encargos ${old.encargoImagePaths.size}, impuestos ${old.taxImagePaths.size}`,
  );

  if (old.missingImages.size > 0) {
    console.log(`  Imágenes faltantes: ${[...old.missingImages].join(', ')}`);
  }

  if (validation.unmappedStatuses.size > 0) {
    console.log(`  Estados sin mapear: ${[...validation.unmappedStatuses].join(', ')}`);
  }
  if (validation.unmappedEncargoStatus.size > 0) {
    console.log(
      `  Estados de encargo sin mapear: ${[...validation.unmappedEncargoStatus].join(', ')}`,
    );
  }
  if (validation.unmappedCategories.size > 0) {
    console.log(
      `  Categorías vacías: ${[...validation.unmappedCategories].join(', ')}`,
    );
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN: no se ha modificado nada.');
    return;
  }

  await login();
  console.log('\nAutenticado en Strapi.');

  console.log('\n=== Vaciando contenido actual');
  for (const plural of [
    'encargos',
    'products',
    'shoppings',
    'taxes',
    'cashes',
    'configurations',
  ]) {
    const deleted = await deleteAll(plural);
    console.log(`  ${plural}: ${deleted} eliminados`);
  }

  console.log('\n=== Vaciando medios');
  const media = await fetchAllMedia();
  for (const file of media) {
    await request(`/api/upload/files/${file.id}`, { method: 'DELETE' });
  }
  console.log(`  ${media.length} archivos eliminados`);

  console.log('\n=== Subiendo imágenes');
  const folders = ensureMediaFolders();
  const { filesByPath, placeholder } = await uploadImages(old, folders);

  console.log('\n=== Configuración');
  await createConfiguration(old.summary);

  console.log('\n=== Compras');
  const shoppingMap = await createShoppings(old);

  console.log('\n=== Productos');
  await createProducts(old, filesByPath, placeholder);

  console.log('\n=== Encargos');
  await createEncargos(old, filesByPath, shoppingMap);

  console.log('\n=== Impuestos');
  await createTaxes(old, filesByPath);

  console.log('\n=== Caja');
  await createCash(old);

  await validateMigration(old);
  console.log('\nMigración completada.');
}

main().catch((error) => {
  console.error('\n✖ Error de migración:', error.message);
  process.exit(1);
});
