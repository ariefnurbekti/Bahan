const MAX_BODY_BYTES = 24 * 1024;
const MAX_ITEMS = 50;
const MAX_QUANTITY = 1000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = corsHeaders(env, origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (origin && origin !== env.STOREFRONT_ORIGIN) {
      return jsonResponse({ error: 'Origin tidak diizinkan.' }, 403, headers);
    }
    if (!origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/midtrans/notification') {
      return jsonResponse({ error: 'Origin tidak diizinkan.' }, 403, headers);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse({ ok: true }, 200, headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/checkout') {
        return await createCheckout(request, env, headers);
      }
      if (request.method === 'POST' && url.pathname === '/api/midtrans/notification') {
        return await handleNotification(request, env, headers);
      }
      if (request.method === 'GET' && url.pathname === '/api/payment-status') {
        return await readPaymentStatus(url, env, headers);
      }
      return jsonResponse({ error: 'Endpoint tidak ditemukan.' }, 404, headers);
    } catch (error) {
      console.error('Payment API request failed:', error.message);
      return jsonResponse({ error: error.message || 'Permintaan pembayaran gagal.' }, error.status || 500, headers);
    }
  }
};

async function createCheckout(request, env, headers) {
  requireConfig(env, [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'MIDTRANS_SERVER_KEY',
    'MIDTRANS_ENVIRONMENT',
    'STOREFRONT_ORIGIN',
    'STOREFRONT_URL'
  ]);
  if (!['sandbox', 'production'].includes(env.MIDTRANS_ENVIRONMENT)) {
    throw httpError('MIDTRANS_ENVIRONMENT harus sandbox atau production.', 500);
  }
  let storefrontUrl;
  try {
    const allowedOrigin = new URL(env.STOREFRONT_ORIGIN);
    storefrontUrl = new URL(env.STOREFRONT_URL);
    if (
      allowedOrigin.protocol !== 'https:' ||
      allowedOrigin.origin !== env.STOREFRONT_ORIGIN ||
      storefrontUrl.protocol !== 'https:' ||
      storefrontUrl.origin !== allowedOrigin.origin
    ) throw new Error('Invalid storefront URL configuration');
  } catch {
    throw httpError('STOREFRONT_ORIGIN dan STOREFRONT_URL harus HTTPS dan berasal dari situs yang sama.', 500);
  }

  const body = await readJson(request);
  const customer = validateCustomer(body.customer);
  const requestedItems = validateRequestedItems(body.items);
  const catalog = await loadCatalog(env);
  const products = new Map(catalog.products.map(product => [String(product.id), product]));
  const items = requestedItems.map(({ product_id, quantity }) => {
    const product = products.get(product_id);
    if (!product || !Number.isSafeInteger(product.price) || product.price < 1 || product.price > 1_000_000_000) {
      throw httpError(`Produk "${product_id}" tidak tersedia atau belum memiliki harga pembayaran yang valid.`, 400);
    }
    const subtotal = product.price * quantity;
    if (!Number.isSafeInteger(subtotal)) throw httpError('Nilai pesanan terlalu besar.', 400);
    return {
      product_id,
      name: String(product.name || product_id).slice(0, 50),
      quantity,
      unit_price: product.price,
      subtotal
    };
  });
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  if (!Number.isSafeInteger(total) || total < 1) throw httpError('Total pembayaran tidak valid.', 400);

  const midtransOrderId = `TT-${crypto.randomUUID()}`;
  const orderRows = await supabaseRequest(env, '/rest/v1/orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      items,
      total_amount: total,
      payment_status: 'pending',
      payment_gateway: 'midtrans',
      midtrans_order_id: midtransOrderId
    })
  });
  if (!Array.isArray(orderRows) || orderRows.length !== 1 || !orderRows[0].id) {
    throw httpError('Pesanan tidak berhasil disimpan. Silakan coba kembali.', 502);
  }

  storefrontUrl.searchParams.set('payment', 'finish');
  storefrontUrl.searchParams.set('order_id', midtransOrderId);
  const midtransHost = env.MIDTRANS_ENVIRONMENT === 'production'
    ? 'https://app.midtrans.com'
    : 'https://app.sandbox.midtrans.com';
  let transaction;
  try {
    transaction = await fetch(`${midtransHost}/snap/v1/transactions`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.MIDTRANS_SERVER_KEY}:`)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        transaction_details: { order_id: midtransOrderId, gross_amount: total },
        item_details: items.map(item => ({
          id: item.product_id.slice(0, 50),
          price: item.unit_price,
          quantity: item.quantity,
          name: item.name
        })),
        customer_details: {
          first_name: customer.name,
          phone: customer.phone,
          shipping_address: { first_name: customer.name, phone: customer.phone, address: customer.address }
        },
        callbacks: { finish: storefrontUrl.href }
      })
    });
  } catch {
    await updateOrder(env, orderRows[0].id, { payment_status: 'failed', transaction_status: 'creation_failed' });
    throw httpError('Midtrans tidak dapat dihubungi. Silakan coba kembali.', 502);
  }
  if (!transaction.ok) {
    await updateOrder(env, orderRows[0].id, { payment_status: 'failed', transaction_status: 'creation_failed' });
    console.error('Midtrans Snap API rejected transaction:', transaction.status);
    throw httpError('Midtrans gagal membuat transaksi. Silakan coba kembali atau hubungi toko.', 502);
  }

  let result;
  try {
    result = await transaction.json();
  } catch {
    await updateOrder(env, orderRows[0].id, { payment_status: 'failed', transaction_status: 'invalid_response' });
    throw httpError('Respons Midtrans tidak valid. Silakan coba kembali.', 502);
  }
  if (typeof result.redirect_url !== 'string' || !isMidtransRedirect(result.redirect_url)) {
    await updateOrder(env, orderRows[0].id, { payment_status: 'failed', transaction_status: 'invalid_redirect' });
    throw httpError('Midtrans memberikan alamat pembayaran yang tidak valid.', 502);
  }
  return jsonResponse({ order_id: midtransOrderId, redirect_url: result.redirect_url }, 201, headers);
}

async function handleNotification(request, env, headers) {
  requireConfig(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'MIDTRANS_SERVER_KEY']);
  const notification = await readJson(request);
  const { order_id: orderId, status_code: statusCode, gross_amount: grossAmount, signature_key: signature } = notification;
  if (
    typeof orderId !== 'string' || orderId.length > 50 ||
    typeof statusCode !== 'string' || typeof grossAmount !== 'string' ||
    typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)
  ) {
    throw httpError('Notifikasi Midtrans tidak valid.', 400);
  }
  const expected = await sha512Hex(`${orderId}${statusCode}${grossAmount}${env.MIDTRANS_SERVER_KEY}`);
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    throw httpError('Signature notifikasi tidak valid.', 401);
  }

  const matches = await supabaseRequest(
    env,
    `/rest/v1/orders?midtrans_order_id=eq.${encodeURIComponent(orderId)}&select=id,total_amount,payment_status&limit=1`,
    { method: 'GET' }
  );
  if (!Array.isArray(matches) || matches.length !== 1) throw httpError('Pesanan tidak ditemukan.', 404);
  const notifiedAmount = Number(grossAmount);
  if (!Number.isSafeInteger(notifiedAmount) || notifiedAmount !== Number(matches[0].total_amount)) {
    throw httpError('Jumlah pembayaran pada notifikasi tidak sesuai pesanan.', 400);
  }

  const paymentStatus = mapPaymentStatus(notification);
  if (!paymentStatus) return jsonResponse({ received: true, ignored: true }, 200, headers);
  const currentStatus = matches[0].payment_status;
  if (currentStatus === 'paid' && ['pending', 'failed', 'cancelled', 'expired'].includes(paymentStatus)) {
    return jsonResponse({ received: true, ignored: true }, 200, headers);
  }
  if (['failed', 'cancelled', 'expired'].includes(currentStatus) && paymentStatus === 'pending') {
    return jsonResponse({ received: true, ignored: true }, 200, headers);
  }

  const update = {
    payment_status: paymentStatus,
    transaction_status: String(notification.transaction_status || '').slice(0, 40),
    payment_type: typeof notification.payment_type === 'string' ? notification.payment_type.slice(0, 40) : null,
    midtrans_transaction_id: typeof notification.transaction_id === 'string' ? notification.transaction_id : null
  };
  if (paymentStatus === 'paid') update.paid_at = new Date().toISOString();
  const allowedPreviousStatuses = {
    paid: ['pending', 'failed', 'cancelled', 'expired'],
    refunded: ['paid', 'partially_refunded'],
    partially_refunded: ['paid', 'partially_refunded'],
    disputed: ['paid', 'partially_refunded', 'disputed']
  }[paymentStatus] || ['pending'];
  const updated = await updateOrder(env, matches[0].id, update, allowedPreviousStatuses);
  if (!updated) return jsonResponse({ received: true, ignored: true }, 200, headers);
  return jsonResponse({ received: true }, 200, headers);
}

async function readPaymentStatus(url, env, headers) {
  requireConfig(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const orderId = url.searchParams.get('order_id') || '';
  if (!/^TT-[0-9a-f-]{36}$/i.test(orderId)) throw httpError('ID pesanan tidak valid.', 400);
  const matches = await supabaseRequest(
    env,
    `/rest/v1/orders?midtrans_order_id=eq.${encodeURIComponent(orderId)}&select=payment_status,transaction_status&limit=1`,
    { method: 'GET' }
  );
  if (!Array.isArray(matches) || matches.length !== 1) throw httpError('Pesanan tidak ditemukan.', 404);
  return jsonResponse({
    payment_status: matches[0].payment_status,
    transaction_status: matches[0].transaction_status
  }, 200, headers);
}

async function loadCatalog(env) {
  const rows = await supabaseRequest(env, '/rest/v1/store_catalog?select=catalog&id=eq.true&limit=1', { method: 'GET' });
  if (!Array.isArray(rows) || !rows[0]?.catalog || !Array.isArray(rows[0].catalog.products)) {
    throw httpError('Katalog toko belum tersedia.', 503);
  }
  return rows[0].catalog;
}

async function updateOrder(env, orderId, values, allowedPaymentStatuses) {
  let path = `/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`;
  const headers = { Prefer: 'return=minimal' };
  if (allowedPaymentStatuses) {
    const filter = allowedPaymentStatuses.length === 1
      ? `eq.${allowedPaymentStatuses[0]}`
      : `in.(${allowedPaymentStatuses.join(',')})`;
    path += `&payment_status=${encodeURIComponent(filter)}`;
    headers.Prefer = 'return=representation';
  }
  const result = await supabaseRequest(env, path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(values)
  });
  return allowedPaymentStatuses ? Array.isArray(result) && result.length > 0 : true;
}

async function supabaseRequest(env, path, options) {
  const baseUrl = new URL(env.SUPABASE_URL);
  if (baseUrl.protocol !== 'https:') throw httpError('SUPABASE_URL harus menggunakan HTTPS.', 500);
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  if (!response.ok) {
    console.error('Supabase request failed:', options.method, response.status);
    throw httpError('Layanan penyimpanan pesanan sedang bermasalah.', 502);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) throw httpError('Permintaan terlalu besar.', 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw httpError('Permintaan terlalu besar.', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw httpError('Format JSON tidak valid.', 400);
  }
}

function validateCustomer(customer) {
  if (!customer || typeof customer !== 'object') throw httpError('Data pelanggan tidak lengkap.', 400);
  const name = cleanText(customer.name, 120);
  const phone = cleanText(customer.phone, 40);
  const address = cleanText(customer.address, 1000);
  if (!name || !phone || !address) throw httpError('Nama, nomor telepon, dan alamat wajib diisi.', 400);
  return { name, phone, address };
}

function validateRequestedItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
    throw httpError(`Pesanan harus berisi 1 sampai ${MAX_ITEMS} produk.`, 400);
  }
  const seen = new Set();
  return items.map(item => {
    const productId = typeof item?.product_id === 'string' ? item.product_id.trim() : '';
    const quantity = item?.quantity;
    if (!productId || productId.length > 100 || seen.has(productId)) {
      throw httpError('Daftar produk tidak valid atau berisi produk duplikat.', 400);
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw httpError(`Jumlah produk harus berupa bilangan bulat antara 1 dan ${MAX_QUANTITY}.`, 400);
    }
    seen.add(productId);
    return { product_id: productId, quantity };
  });
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function mapPaymentStatus(notification) {
  switch (notification.transaction_status) {
    case 'settlement':
      return 'paid';
    case 'capture':
      return notification.fraud_status === 'accept' ? 'paid' : 'pending';
    case 'pending':
      return 'pending';
    case 'deny':
    case 'failure':
      return 'failed';
    case 'cancel':
      return 'cancelled';
    case 'expire':
      return 'expired';
    case 'refund':
      return 'refunded';
    case 'partial_refund':
      return 'partially_refunded';
    case 'chargeback':
    case 'partial_chargeback':
      return 'disputed';
    default:
      return null;
  }
}

function corsHeaders(env, origin) {
  const allowedOrigin = env.STOREFRONT_ORIGIN;
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  });
  if (allowedOrigin && (!origin || origin === allowedOrigin)) headers.set('Access-Control-Allow-Origin', allowedOrigin);
  return headers;
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function requireConfig(env, names) {
  const missing = names.filter(name => !env[name]);
  if (missing.length) throw httpError(`Konfigurasi Worker belum lengkap: ${missing.join(', ')}.`, 503);
}

function isMidtransRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['app.midtrans.com', 'app.sandbox.midtrans.com'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function sha512Hex(value) {
  const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}
