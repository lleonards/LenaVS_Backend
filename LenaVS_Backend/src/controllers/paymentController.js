import crypto from 'crypto';
import axios from 'axios';
import stripe from '../config/stripe.js';
import supabase from '../config/supabase.js';
import {
  buildAccessSnapshot,
  calculateExtendedUnlimitedAccessUntil,
  getCreditsRemainingLabel,
  hasUnlimitedAccess,
  UNLIMITED_ACCESS_DAYS,
} from '../utils/access.js';

const STRIPE_PROVIDER = 'stripe';
const PAGARME_PROVIDER = 'pagarme';
const DEFAULT_MONTHLY_PRICE_BRL = Number(process.env.UNLIMITED_PRICE_BRL || 29.9);
const DEFAULT_MONTHLY_PRICE_USD = Number(process.env.UNLIMITED_PRICE_USD || 9.9);
const DEFAULT_PAGARME_API_BASE = 'https://api.pagar.me/core/v5';

const getFrontendUrl = () => String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const getBackendUrl = () => String(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000').replace(/\/$/, '');
const getPagarmeApiBase = () => String(process.env.PAGARME_API_BASE || DEFAULT_PAGARME_API_BASE).replace(/\/$/, '');
const getPagarmeSecretKey = () => String(process.env.PAGARME_SECRET_KEY || '').trim();
const getPagarmeWebhookSecret = () => String(process.env.PAGARME_WEBHOOK_SECRET || '').trim();
const isPagarmeSignatureRequired = () => String(process.env.PAGARME_REQUIRE_WEBHOOK_SIGNATURE || 'false').trim().toLowerCase() === 'true';

const asPositiveAmount = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : fallback;
};

const normalizeStatus = (value, fallback = 'pending') => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
};

const getStripePriceId = (currency = 'brl') => {
  const normalizedCurrency = String(currency || 'brl').toLowerCase();

  if (normalizedCurrency === 'usd') {
    return process.env.STRIPE_PRICE_USD || process.env.STRIPE_PRICE_BRL;
  }

  return process.env.STRIPE_PRICE_BRL || process.env.STRIPE_PRICE_USD;
};

const getMonthlyPlanPricing = (currency = 'brl') => {
  const normalizedCurrency = String(currency || 'brl').toLowerCase();

  if (normalizedCurrency === 'usd') {
    return {
      currency: 'USD',
      currencyId: 'USD',
      amount: asPositiveAmount(process.env.UNLIMITED_PRICE_USD, DEFAULT_MONTHLY_PRICE_USD),
      label: 'LenaVS Upgrade - 30 dias',
      description: 'Acesso ilimitado ao LenaVS por 30 dias',
    };
  }

  return {
    currency: 'BRL',
    currencyId: 'BRL',
    amount: asPositiveAmount(process.env.UNLIMITED_PRICE_BRL, DEFAULT_MONTHLY_PRICE_BRL),
    label: 'LenaVS Upgrade - 30 dias',
    description: 'Acesso ilimitado ao LenaVS por 30 dias',
  };
};

const getReturnUrls = (provider) => {
  const frontendUrl = getFrontendUrl();
  return {
    success: `${frontendUrl}/payment/success?provider=${provider}`,
    pending: `${frontendUrl}/payment/pending?provider=${provider}`,
    failure: `${frontendUrl}/payment/failure?provider=${provider}`,
    cancel: `${frontendUrl}/upgrade?canceled=1&provider=${provider}`,
  };
};

const parseJsonEnv = (value, fallback = {}) => {
  if (!value || !String(value).trim()) return fallback;

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    console.warn('Não foi possível interpretar JSON do ambiente:', error.message);
    return fallback;
  }
};

const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const deepMerge = (base, override) => {
  if (!isPlainObject(base)) return override;
  if (!isPlainObject(override)) return override === undefined ? base : override;

  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;

    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
      continue;
    }

    result[key] = value;
  }

  return result;
};

const compactObject = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactObject(item))
      .filter((item) => item !== undefined && item !== null && item !== '');
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.entries(value).reduce((acc, [key, currentValue]) => {
    const nextValue = compactObject(currentValue);

    if (nextValue === undefined || nextValue === null || nextValue === '') {
      return acc;
    }

    if (Array.isArray(nextValue) && nextValue.length === 0) {
      return acc;
    }

    if (isPlainObject(nextValue) && Object.keys(nextValue).length === 0) {
      return acc;
    }

    acc[key] = nextValue;
    return acc;
  }, {});
};

const nameFromEmail = (email) => {
  const local = String(email || '').split('@')[0] || 'Cliente LenaVS';
  const cleaned = local.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Cliente LenaVS';
};

const getNestedValue = (obj, path) => {
  if (!obj || typeof obj !== 'object') return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
};

const findFirstValue = (obj, paths) => {
  for (const path of paths) {
    const value = getNestedValue(obj, path);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
};

const findUserProfile = async ({ userId = null, email = null } = {}) => {
  if (userId) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (!error && data) return data;
  }

  if (email) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .ilike('email', String(email).trim())
      .maybeSingle();

    if (!error && data) return data;
  }

  return null;
};

const upsertPaymentTransaction = async ({
  provider,
  externalId,
  userId = null,
  email = null,
  paymentType = null,
  status = null,
  rawPayload = {},
}) => {
  if (!provider || !externalId) return null;

  const payload = {
    provider,
    external_id: String(externalId),
    user_id: userId,
    email: email ? String(email).trim().toLowerCase() : null,
    payment_type: paymentType,
    status,
    raw_payload: rawPayload,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('payment_transactions')
    .upsert(payload, { onConflict: 'provider,external_id' })
    .select('*')
    .maybeSingle();

  if (error) {
    console.warn('Não foi possível registrar transação de pagamento:', error.message);
    return null;
  }

  return data;
};

const markPaymentGranted = async (provider, externalId) => {
  if (!provider || !externalId) return;

  const { error } = await supabase
    .from('payment_transactions')
    .update({ access_granted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('provider', provider)
    .eq('external_id', String(externalId));

  if (error) {
    console.warn('Não foi possível marcar a transação como liberada:', error.message);
  }
};

const alreadyGrantedAccess = (transaction) => Boolean(transaction?.access_granted_at);

const applyUnlimitedAccessToUser = async ({
  userId = null,
  email = null,
  provider,
  externalId,
  customerId = null,
  subscriptionId = null,
}) => {
  const profile = await findUserProfile({ userId, email });

  if (!profile) {
    throw new Error('Usuário do pagamento não encontrado');
  }

  const nextUnlimitedUntil = calculateExtendedUnlimitedAccessUntil(profile.unlimited_access_until, UNLIMITED_ACCESS_DAYS);

  const updatePayload = {
    plan: 'pro',
    subscription_status: 'active',
    unlimited_access_until: nextUnlimitedUntil.toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (provider === STRIPE_PROVIDER && customerId) {
    updatePayload.stripe_customer_id = String(customerId);
  }

  if (subscriptionId) {
    updatePayload.stripe_customer_id = customerId || profile.stripe_customer_id || null;
  }

  const { data, error } = await supabase
    .from('users')
    .update(updatePayload)
    .eq('id', profile.id)
    .select('*')
    .single();

  if (error) throw error;

  await markPaymentGranted(provider, externalId);

  return data;
};

const updateStripeSubscriptionState = async ({ customerId = null, email = null, subscriptionStatus = 'active' }) => {
  if (!customerId && !email) return;

  let query = supabase
    .from('users')
    .update({ subscription_status: subscriptionStatus, updated_at: new Date().toISOString() })
    .select('id');

  if (customerId) {
    query = query.eq('stripe_customer_id', String(customerId));
  } else {
    query = query.ilike('email', String(email).trim());
  }

  const { error } = await query.maybeSingle();
  if (error) {
    console.warn('Não foi possível atualizar status da assinatura Stripe:', error.message);
  }
};

const fetchStripeCustomerEmail = async (customerId) => {
  if (!customerId) return null;

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer?.deleted ? null : customer?.email || null;
  } catch (error) {
    console.warn('Não foi possível recuperar o cliente Stripe:', error.message);
    return null;
  }
};

const buildReferenceFromUserId = (userId) => (userId ? `lenavs:${userId}` : '');

const extractUserIdFromReference = (reference) => {
  const rawReference = String(reference || '').trim();
  const match = rawReference.match(/lenavs:([0-9a-f-]{36})/i);
  return match?.[1] || null;
};

const getPagarmeApiHeaders = () => {
  const apiKey = getPagarmeSecretKey();

  if (!apiKey) {
    throw new Error('PAGARME_SECRET_KEY não configurada');
  }

  return {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
};

const getPagarmeAcceptedPaymentMethods = () => {
  const raw = String(process.env.PAGARME_ACCEPTED_PAYMENT_METHODS || 'pix,credit_card,boleto').trim();
  const methods = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return methods.length ? [...new Set(methods)] : ['pix', 'credit_card', 'boleto'];
};

const getPagarmeRequestUrl = (path) => `${getPagarmeApiBase()}${path}`;

const resolvePagarmeSessionUrl = (payload = {}) => (
  payload?.url
  || payload?.short_url
  || payload?.payment_url
  || payload?.checkout_url
  || payload?.checkout?.url
  || payload?.data?.url
  || null
);

const createPagarmePaymentLink = async ({ profile, currency = 'brl' }) => {
  const normalizedCurrency = String(currency || 'brl').toLowerCase();
  const pricing = getMonthlyPlanPricing(normalizedCurrency === 'usd' ? 'usd' : 'brl');
  const returnUrls = getReturnUrls(PAGARME_PROVIDER);
  const amountInCents = Math.round(Number(pricing.amount || 0) * 100);
  const reference = buildReferenceFromUserId(profile.id);
  const expiresInMinutes = Number(process.env.PAGARME_EXPIRES_IN_MINUTES || 1440);
  const template = parseJsonEnv(process.env.PAGARME_PAYMENT_LINK_TEMPLATE_JSON, {});

  const productName = String(pricing.label || '').trim();
  const productDescription = String(pricing.description || '').trim();

  if (!productName) {
    throw new Error('pricing.label não pode estar vazio para criar o payment link do Pagar.me');
  }

  if (!productDescription) {
    throw new Error('pricing.description não pode estar vazio para criar o payment link do Pagar.me');
  }

  if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
    throw new Error('O valor do payment link do Pagar.me deve estar em centavos e ser maior que zero');
  }

  const basePayload = compactObject({
    name: `${productName} [${reference}]`.slice(0, 64),
    type: String(process.env.PAGARME_LINK_TYPE || 'order').trim().toLowerCase() || 'order',
    expires_in: Number.isFinite(expiresInMinutes) && expiresInMinutes > 0 ? expiresInMinutes : 1440,
    max_paid_sessions: 1,
   payment_settings: {
  accepted_payment_methods: ['pix', 'credit_card'],
  
  pix_settings: {
    expires_in: 3600
  },

  credit_card_settings: {
    installments: {
      max_installments: 1
    }
  },

  success_url: returnUrls.success,
  pending_url: returnUrls.pending,
  canceled_url: returnUrls.cancel,
} 
     success_url: returnUrls.success,
      pending_url: returnUrls.pending,
      canceled_url: returnUrls.cancel,
    },
    customer_settings: {
      customer: {
        name: nameFromEmail(profile.email),
        email: profile.email,
        type: 'individual',
      },
    },
    cart_settings: {
      items: [
        {
          name: productName,
          description: productDescription,
          amount: amountInCents,
          default_quantity: 1,
        },
      ],
    },
    layout_settings: {
      title: productName,
      success_url: returnUrls.success,
      pending_url: returnUrls.pending,
      canceled_url: returnUrls.cancel,
    },
    metadata: {
      user_id: profile.id,
      email: profile.email,
      reference,
      plan: 'unlimited_30_days',
    },
  });

  const body = compactObject(deepMerge(basePayload, template));

  const response = await axios.post(getPagarmeRequestUrl('/paymentlinks'), body, {
    headers: getPagarmeApiHeaders(),
    timeout: 30000,
  });

  return response.data;
};

const parseWebhookRequest = (req) => {
  if (Buffer.isBuffer(req.body)) {
    const rawBody = req.body.toString('utf8');
    return {
      rawBody,
      payload: rawBody ? JSON.parse(rawBody) : {},
    };
  }

  if (typeof req.body === 'string') {
    return {
      rawBody: req.body,
      payload: req.body ? JSON.parse(req.body) : {},
    };
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  return {
    rawBody: JSON.stringify(payload),
    payload,
  };
};

const normalizeSignature = (value) => String(value || '').trim().replace(/^sha(1|256)=/i, '');

const verifyPagarmeWebhookSignature = (rawBody, req) => {
  const secret = getPagarmeWebhookSecret();
  const signatureHeaders = [
    req.headers['x-hub-signature-256'],
    req.headers['x-hub-signature'],
    req.headers['x-signature'],
    req.headers.signature,
    req.headers['x-pagarme-signature'],
  ].filter(Boolean);

  if (!secret) {
    return true;
  }

  if (!rawBody || signatureHeaders.length === 0) {
    if (isPagarmeSignatureRequired()) {
      return false;
    }

    console.warn('PAGARME_WEBHOOK_SECRET configurada, mas nenhum header de assinatura foi enviado. O webhook será aceito porque PAGARME_REQUIRE_WEBHOOK_SIGNATURE=false.');
    return true;
  }

  const sha256 = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sha1 = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');

  return signatureHeaders.some((headerValue) => {
    const received = normalizeSignature(headerValue);
    if (!received) return false;

    return [sha256, sha1].some((expectedHash) => {
      const expected = Buffer.from(expectedHash, 'utf8');
      const provided = Buffer.from(received, 'utf8');
      return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
    });
  });
};

const extractPagarmeWebhookData = (payload) => {
  const eventType = String(
    payload?.type || payload?.event || payload?.name || payload?.event_type || payload?.action || ''
  ).trim().toLowerCase();

  const containers = [
    payload,
    payload?.data,
    payload?.body,
    payload?.current,
    payload?.object,
    payload?.order,
    payload?.charge,
    payload?.invoice,
    payload?.subscription,
    payload?.data?.order,
    payload?.data?.charge,
    payload?.data?.invoice,
    payload?.data?.subscription,
    payload?.data?.object,
  ].filter(Boolean);

  let entityId = null;
  let orderId = null;
  let chargeId = null;
  let subscriptionId = null;
  let email = null;
  let paymentType = null;
  let status = null;
  let userId = null;
  let reference = null;

  for (const container of containers) {
    if (!entityId) {
      entityId = findFirstValue(container, ['id', 'data.id', 'object.id']);
    }

    if (!orderId) {
      orderId = findFirstValue(container, ['order.id', 'last_transaction.order_id', 'data.order.id']);
    }

    if (!chargeId) {
      chargeId = findFirstValue(container, ['charge.id', 'last_transaction.charge_id', 'charges.0.id', 'data.charge.id']);
    }

    if (!subscriptionId) {
      subscriptionId = findFirstValue(container, ['subscription.id', 'data.subscription.id']);
    }

    if (!email) {
      email = findFirstValue(container, [
        'customer.email',
        'customer.emails.0',
        'payer.email',
        'data.customer.email',
        'charges.0.customer.email',
        'last_transaction.customer.email',
        'metadata.email',
        'data.metadata.email',
      ]);
    }

    if (!paymentType) {
      paymentType = findFirstValue(container, [
        'payment_method',
        'last_transaction.payment_method',
        'charge.payment_method',
        'charges.0.payment_method',
      ]);
    }

    if (!status) {
      status = findFirstValue(container, [
        'status',
        'order.status',
        'charge.status',
        'invoice.status',
        'subscription.status',
        'last_transaction.status',
        'charges.0.status',
      ]);
    }

    if (!reference) {
      reference = findFirstValue(container, [
        'metadata.reference',
        'metadata.user_reference',
        'metadata.user_id',
        'data.metadata.reference',
        'checkout_settings.metadata.reference',
        'items.0.code',
        'charges.0.metadata.reference',
      ]);
    }

    if (!userId) {
      userId = findFirstValue(container, [
        'metadata.user_id',
        'data.metadata.user_id',
        'checkout_settings.metadata.user_id',
      ]);
    }
  }

  const normalizedReference = reference || null;
  const extractedUserId = extractUserIdFromReference(normalizedReference) || extractUserIdFromReference(entityId) || userId || null;
  const externalId = orderId || chargeId || subscriptionId || entityId || null;

  return {
    eventType,
    externalId: externalId ? String(externalId) : null,
    orderId: orderId ? String(orderId) : null,
    chargeId: chargeId ? String(chargeId) : null,
    subscriptionId: subscriptionId ? String(subscriptionId) : null,
    userId: extractedUserId ? String(extractedUserId) : null,
    email: email ? String(email).trim().toLowerCase() : null,
    paymentType: paymentType ? String(paymentType).trim().toLowerCase() : null,
    status: normalizeStatus(status || (eventType.includes('.paid') ? 'paid' : 'pending')),
    reference: normalizedReference ? String(normalizedReference) : null,
  };
};

const isPagarmePaymentConfirmed = ({ eventType = '', status = '' }) => {
  const normalizedEvent = String(eventType || '').toLowerCase();
  const normalizedStatus = String(status || '').toLowerCase();

  return (
    normalizedEvent.includes('.paid')
    || ['paid', 'succeeded', 'authorized', 'captured'].includes(normalizedStatus)
  );
};

const syncLatestPagarmeTransactionForUser = async (userId) => {
  if (!userId) return null;

  const { data: transaction, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('provider', PAGARME_PROVIDER)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('Não foi possível consultar a última transação Pagar.me:', error.message);
    return null;
  }

  return transaction || null;
};

export const createPaymentSession = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const provider = String(req.body?.provider || STRIPE_PROVIDER).toLowerCase();
    const currency = String(req.body?.currency || 'brl').toLowerCase();

    const profile = await findUserProfile({ userId: user.id });

    if (!profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (provider === PAGARME_PROVIDER) {
      const paymentLink = await createPagarmePaymentLink({
        profile,
        currency: 'brl',
      });

      const sessionUrl = resolvePagarmeSessionUrl(paymentLink);

      if (!sessionUrl) {
        return res.status(500).json({
          error: 'A resposta do Pagar.me não retornou uma URL de checkout.',
        });
      }

      const paymentLinkId = String(paymentLink.id || paymentLink.payment_link_id || crypto.randomUUID());

      await upsertPaymentTransaction({
        provider: PAGARME_PROVIDER,
        externalId: paymentLinkId,
        userId: profile.id,
        email: profile.email,
        paymentType: getPagarmeAcceptedPaymentMethods().join(','),
        status: normalizeStatus(paymentLink.status, 'created'),
        rawPayload: paymentLink,
      });

      return res.json({
        provider: PAGARME_PROVIDER,
        sessionUrl,
        sessionId: paymentLinkId,
        openMode: 'new_tab',
        statusUrl: `/payment/pending?provider=${PAGARME_PROVIDER}`,
      });
    }

    if (provider !== STRIPE_PROVIDER) {
      return res.status(400).json({ error: 'Provedor de pagamento inválido' });
    }

    const priceId = getStripePriceId(currency);

    if (!priceId) {
      return res.status(500).json({
        error: 'Price ID do Stripe não configurado no ambiente',
      });
    }

    const returnUrls = getReturnUrls(STRIPE_PROVIDER);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: profile.email,
      client_reference_id: profile.id,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        user_id: profile.id,
        email: profile.email,
        plan: 'unlimited',
      },
      subscription_data: {
        metadata: {
          user_id: profile.id,
          email: profile.email,
          plan: 'unlimited',
        },
      },
      success_url: `${returnUrls.success}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: returnUrls.cancel,
    });

    await upsertPaymentTransaction({
      provider: STRIPE_PROVIDER,
      externalId: session.id,
      userId: profile.id,
      email: profile.email,
      paymentType: 'card',
      status: 'created',
      rawPayload: session,
    });

    return res.json({
      provider: STRIPE_PROVIDER,
      sessionUrl: session.url,
      sessionId: session.id,
      openMode: 'redirect',
    });
  } catch (err) {
    console.error('❌ Erro ao criar sessão de pagamento:', err.response?.data || err.message || err);
    return res.status(500).json({
      error: 'Erro ao criar sessão de pagamento',
      details: err.message,
    });
  }
};

export const handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Erro ao verificar webhook Stripe:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerEmail = session.customer_email || session.customer_details?.email || session.metadata?.email || null;
      const userId = session.client_reference_id || session.metadata?.user_id || null;

      const transaction = await upsertPaymentTransaction({
        provider: STRIPE_PROVIDER,
        externalId: session.id,
        userId,
        email: customerEmail,
        paymentType: 'card',
        status: session.payment_status || 'completed',
        rawPayload: session,
      });

      if (!alreadyGrantedAccess(transaction)) {
        await applyUnlimitedAccessToUser({
          userId,
          email: customerEmail,
          provider: STRIPE_PROVIDER,
          externalId: session.id,
          customerId: session.customer,
          subscriptionId: session.subscription,
        });
      }
    }

    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const customerEmail = invoice.customer_email || await fetchStripeCustomerEmail(invoice.customer);
      const userId = invoice.parent?.subscription_details?.metadata?.user_id || invoice.lines?.data?.[0]?.metadata?.user_id || null;
      const transactionId = invoice.id || invoice.payment_intent || `invoice-${invoice.subscription || Date.now()}`;

      const transaction = await upsertPaymentTransaction({
        provider: STRIPE_PROVIDER,
        externalId: transactionId,
        userId,
        email: customerEmail,
        paymentType: 'card',
        status: invoice.status || 'paid',
        rawPayload: invoice,
      });

      if (!alreadyGrantedAccess(transaction)) {
        await applyUnlimitedAccessToUser({
          userId,
          email: customerEmail,
          provider: STRIPE_PROVIDER,
          externalId: transactionId,
          customerId: invoice.customer,
          subscriptionId: invoice.subscription,
        });
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerEmail = invoice.customer_email || await fetchStripeCustomerEmail(invoice.customer);
      await updateStripeSubscriptionState({
        customerId: invoice.customer,
        email: customerEmail,
        subscriptionStatus: 'past_due',
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerEmail = await fetchStripeCustomerEmail(subscription.customer);
      await updateStripeSubscriptionState({
        customerId: subscription.customer,
        email: customerEmail,
        subscriptionStatus: 'canceled',
      });
    }

    if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object;
      const customerEmail = await fetchStripeCustomerEmail(subscription.customer);
      const nextStatus = subscription.status === 'active' ? 'active' : subscription.status || 'inactive';
      await updateStripeSubscriptionState({
        customerId: subscription.customer,
        email: customerEmail,
        subscriptionStatus: nextStatus,
      });
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('❌ Erro interno webhook Stripe:', err);
    return res.status(500).json({ error: 'Erro no webhook Stripe' });
  }
};

export const handlePagarmeWebhook = async (req, res) => {
  try {
    const { rawBody, payload } = parseWebhookRequest(req);

    if (!verifyPagarmeWebhookSignature(rawBody, req)) {
      return res.status(400).json({ error: 'Assinatura inválida no webhook Pagar.me' });
    }

    const extracted = extractPagarmeWebhookData(payload);

    if (!extracted.externalId) {
      return res.status(200).json({ received: true, ignored: true, reason: 'external_id_missing' });
    }

    const transaction = await upsertPaymentTransaction({
      provider: PAGARME_PROVIDER,
      externalId: extracted.externalId,
      userId: extracted.userId,
      email: extracted.email,
      paymentType: extracted.paymentType || 'pagarme_checkout',
      status: extracted.status,
      rawPayload: payload,
    });

    if (isPagarmePaymentConfirmed(extracted) && !alreadyGrantedAccess(transaction)) {
      await applyUnlimitedAccessToUser({
        userId: extracted.userId,
        email: extracted.email,
        provider: PAGARME_PROVIDER,
        externalId: extracted.externalId,
      });
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('❌ Erro no webhook Pagar.me:', error.response?.data || error.message || error);
    return res.status(500).json({ error: 'Erro no webhook do Pagar.me' });
  }
};

export const getSubscriptionStatus = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const syncProvider = String(req.query?.sync_provider || '').toLowerCase();

    if (syncProvider === PAGARME_PROVIDER) {
      await syncLatestPagarmeTransactionForUser(user.id);
    }

    const profile = await findUserProfile({ userId: user.id });

    if (!profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const snapshot = buildAccessSnapshot(profile);

    return res.json({
      plan: snapshot.plan,
      credits: profile.credits,
      credits_remaining: snapshot.credits_remaining,
      subscription_status: snapshot.subscription_status,
      unlimited_access_until: snapshot.unlimited_access_until,
      unlimited: snapshot.unlimited,
      access_type: snapshot.unlimited ? 'unlimited' : 'credits',
      should_upgrade: !hasUnlimitedAccess(profile) && !getCreditsRemainingLabel(profile),
    });
  } catch (err) {
    console.error('❌ Erro ao buscar assinatura:', err.message);
    return res.status(500).json({
      error: 'Erro ao buscar assinatura',
    });
  }
};
