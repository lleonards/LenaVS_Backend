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
const SELLX_PROVIDER = 'sellx';
const DEFAULT_MONTHLY_PRICE_BRL = Number(process.env.UNLIMITED_PRICE_BRL || 39.9);
const DEFAULT_MONTHLY_PRICE_USD = Number(process.env.UNLIMITED_PRICE_USD || 9.9);
const SELLX_API_BASE = process.env.SELLX_API_BASE || process.env.SELLAPP_API_BASE || 'https://sell.app/api';

const getFrontendUrl = () => String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const getBackendUrl = () => String(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000').replace(/\/$/, '');
const getSellxApiKey = () => process.env.SELLX_API_KEY || process.env.SELLAPP_API_KEY;
const getSellxStoreSlug = () => process.env.SELLX_STORE_SLUG || process.env.SELLAPP_STORE_SLUG || '';
const getSellxWebhookSecret = () => process.env.SELLX_WEBHOOK_SECRET || process.env.SELLAPP_WEBHOOK_SECRET || '';

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

const getSellxApiHeaders = ({ includeJson = true } = {}) => {
  const apiKey = getSellxApiKey();

  if (!apiKey) {
    throw new Error('SELLX_API_KEY não configurada');
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };

  if (includeJson) {
    headers['Content-Type'] = 'application/json';
    headers.Accept = 'application/json';
  }

  const storeSlug = getSellxStoreSlug();
  if (storeSlug) {
    headers['X-STORE'] = storeSlug;
  }

  return headers;
};

const getSellxPaymentConfig = () => {
  const paymentMethodsRaw = String(process.env.SELLX_PAYMENT_METHODS || '').trim();
  const useAllPaymentMethods = String(process.env.SELLX_USE_ALL_PAYMENT_METHODS || 'true').trim().toLowerCase() !== 'false';

  if (paymentMethodsRaw) {
    const paymentMethods = paymentMethodsRaw
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);

    if (paymentMethods.length === 1) {
      return { payment_method: paymentMethods[0] };
    }

    if (paymentMethods.length > 1) {
      return { payment_methods: paymentMethods };
    }
  }

  if (useAllPaymentMethods) {
    return { use_all_payment_methods: true };
  }

  return { payment_method: 'STRIPE' };
};

const buildSellxReference = (profile) => `lenavs:${profile.id}`;

const extractUserIdFromReference = (reference) => {
  const rawReference = String(reference || '').trim();
  const match = rawReference.match(/lenavs:([0-9a-f-]{36})/i);
  return match?.[1] || null;
};

const fetchSellxCharge = async (chargeId) => {
  if (!chargeId) {
    throw new Error('ID da cobrança SellX ausente');
  }

  const response = await axios.get(`${SELLX_API_BASE}/v2/charges/${chargeId}`, {
    headers: getSellxApiHeaders(),
    timeout: 30000,
  });

  return response.data;
};

const createSellxCharge = async ({ profile, currency = 'brl' }) => {
  const pricing = getMonthlyPlanPricing(currency);
  const returnUrls = getReturnUrls(SELLX_PROVIDER);
  const backendUrl = getBackendUrl();

  const body = {
    email: profile.email,
    total: Math.round(pricing.amount * 100),
    currency: pricing.currency,
    return_url: returnUrls.pending,
    cancel_url: returnUrls.cancel,
    webhook: `${backendUrl}/api/payment/webhook/sellx`,
    reference: buildSellxReference(profile),
    description: pricing.description,
    ...getSellxPaymentConfig(),
  };

  const response = await axios.post(`${SELLX_API_BASE}/v2/charges`, body, {
    headers: {
      ...getSellxApiHeaders(),
      'X-Idempotency-Key': crypto.randomUUID(),
    },
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

const normalizeSignature = (value) => String(value || '').trim().replace(/^sha256=/i, '');

const verifySellxWebhookSignature = (rawBody, signatureHeader) => {
  const secret = getSellxWebhookSecret();

  if (!secret) {
    console.warn('SELLX_WEBHOOK_SECRET não configurada. Webhook SellX será aceito sem validação de assinatura.');
    return true;
  }

  const signature = normalizeSignature(signatureHeader);
  if (!signature || !rawBody) return false;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(signature, 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
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

const extractSellxChargePayload = (payload) => {
  const containers = [
    payload,
    payload?.data,
    payload?.charge,
    payload?.payload,
    payload?.object,
    payload?.body,
    payload?.data?.charge,
    payload?.data?.object,
  ].filter(Boolean);

  const eventType = String(
    payload?.event || payload?.type || payload?.action || payload?.name || payload?.event_type || ''
  ).trim().toLowerCase();

  for (const container of containers) {
    const chargeId = findFirstValue(container, ['id', 'charge.id', 'data.id']);
    const status = findFirstValue(container, ['status', 'charge.status', 'data.status']);
    const email = findFirstValue(container, ['email', 'customer.email', 'payer.email', 'data.email']);
    const reference = findFirstValue(container, ['reference', 'data.reference', 'charge.reference']);

    if (chargeId || status || email || reference) {
      return {
        chargeId: chargeId ? String(chargeId) : null,
        status: normalizeStatus(status || (eventType.includes('completed') ? 'completed' : 'pending')),
        email: email ? String(email).trim().toLowerCase() : null,
        reference: reference ? String(reference) : null,
        eventType,
      };
    }
  }

  return {
    chargeId: null,
    status: normalizeStatus(eventType.includes('completed') ? 'completed' : ''),
    email: null,
    reference: null,
    eventType,
  };
};

const syncSellxChargeAccess = async ({
  chargeId,
  fallbackUserId = null,
  fallbackEmail = null,
  fallbackTransaction = null,
}) => {
  if (!chargeId) return null;

  const charge = await fetchSellxCharge(chargeId);
  const status = normalizeStatus(charge?.status);
  const reference = charge?.reference || fallbackTransaction?.raw_payload?.reference || null;
  const userId = extractUserIdFromReference(reference) || fallbackUserId;
  const email = (charge?.email || fallbackEmail || fallbackTransaction?.email || '').trim().toLowerCase() || null;

  const transaction = await upsertPaymentTransaction({
    provider: SELLX_PROVIDER,
    externalId: String(charge?.id || chargeId),
    userId,
    email,
    paymentType: Array.isArray(charge?.payment_methods) ? charge.payment_methods.join(',') : charge?.payment_method || 'sellx_checkout',
    status,
    rawPayload: charge,
  });

  if (status === 'completed' && !alreadyGrantedAccess(transaction)) {
    await applyUnlimitedAccessToUser({
      userId,
      email,
      provider: SELLX_PROVIDER,
      externalId: String(charge?.id || chargeId),
    });
  }

  return { charge, transaction };
};

const syncLatestSellxChargeForUser = async (userId) => {
  if (!userId) return null;

  const { data: transaction, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('provider', SELLX_PROVIDER)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn('Não foi possível consultar a última transação SellX:', error.message);
    return null;
  }

  if (!transaction?.external_id) {
    return null;
  }

  try {
    return await syncSellxChargeAccess({
      chargeId: transaction.external_id,
      fallbackUserId: userId,
      fallbackEmail: transaction.email,
      fallbackTransaction: transaction,
    });
  } catch (errorSync) {
    console.warn('Não foi possível sincronizar a cobrança SellX:', errorSync.response?.data || errorSync.message || errorSync);
    return null;
  }
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

    if (provider === SELLX_PROVIDER) {
      const charge = await createSellxCharge({
        profile,
        currency: 'brl',
      });

      await upsertPaymentTransaction({
        provider: SELLX_PROVIDER,
        externalId: String(charge.id),
        userId: profile.id,
        email: profile.email,
        paymentType: Array.isArray(charge.payment_methods) ? charge.payment_methods.join(',') : charge.payment_method || 'sellx_checkout',
        status: normalizeStatus(charge.status, 'created'),
        rawPayload: charge,
      });

      return res.json({
        provider: SELLX_PROVIDER,
        sessionUrl: charge.url,
        chargeId: String(charge.id),
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

export const handleSellxWebhook = async (req, res) => {
  try {
    const { rawBody, payload } = parseWebhookRequest(req);
    const signature = req.headers.signature || req.headers.Signature || req.headers['x-signature'];

    if (!verifySellxWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ error: 'Assinatura inválida no webhook SellX' });
    }

    const extracted = extractSellxChargePayload(payload);

    if (!extracted.chargeId) {
      return res.status(200).json({ received: true, ignored: true, reason: 'charge_id_missing' });
    }

    await syncSellxChargeAccess({
      chargeId: extracted.chargeId,
      fallbackUserId: extractUserIdFromReference(extracted.reference),
      fallbackEmail: extracted.email,
      fallbackTransaction: null,
    });

    return res.json({ received: true });
  } catch (error) {
    console.error('❌ Erro no webhook SellX:', error.response?.data || error.message || error);
    return res.status(500).json({ error: 'Erro no webhook do SellX' });
  }
};

export const getSubscriptionStatus = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const syncProvider = String(req.query?.sync_provider || '').toLowerCase();

    if (syncProvider === SELLX_PROVIDER) {
      await syncLatestSellxChargeForUser(user.id);
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
