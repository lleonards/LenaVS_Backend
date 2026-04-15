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
const MERCADO_PAGO_PROVIDER = 'mercadopago';
const DEFAULT_MONTHLY_PRICE_BRL = Number(process.env.UNLIMITED_PRICE_BRL || 29.9);
const DEFAULT_MONTHLY_PRICE_USD = Number(process.env.UNLIMITED_PRICE_USD || 9.9);
const MERCADO_PAGO_API_BASE = process.env.MERCADO_PAGO_API_BASE || 'https://api.mercadopago.com';

const getFrontendUrl = () => String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
const getBackendUrl = () => String(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000').replace(/\/$/, '');
const getMercadoPagoAccessToken = () => process.env.MERCADO_PAGO_ACCESS_TOKEN;

const asPositiveAmount = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : fallback;
};

const getStripePriceId = (currency = 'brl') => {
  const normalizedCurrency = String(currency || 'brl').toLowerCase();
  return normalizedCurrency === 'usd'
    ? process.env.STRIPE_PRICE_USD
    : process.env.STRIPE_PRICE_BRL;
};

const getMonthlyPlanPricing = (currency = 'brl') => {
  const normalizedCurrency = String(currency || 'brl').toLowerCase();

  if (normalizedCurrency === 'usd') {
    return {
      currency: 'USD',
      currencyId: 'USD',
      amount: asPositiveAmount(process.env.UNLIMITED_PRICE_USD, DEFAULT_MONTHLY_PRICE_USD),
      label: 'LenaVS Unlimited - 30 dias',
    };
  }

  return {
    currency: 'BRL',
    currencyId: 'BRL',
    amount: asPositiveAmount(process.env.UNLIMITED_PRICE_BRL, DEFAULT_MONTHLY_PRICE_BRL),
    label: 'LenaVS Unlimited - 30 dias',
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

const fetchMercadoPagoPayment = async (paymentId) => {
  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado');
  }

  const response = await axios.get(`${MERCADO_PAGO_API_BASE}/v1/payments/${paymentId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });

  return response.data;
};

const createMercadoPagoPreference = async ({ profile, currency = 'brl', paymentMethod = 'pix' }) => {
  const accessToken = getMercadoPagoAccessToken();

  if (!accessToken) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado');
  }

  const pricing = getMonthlyPlanPricing(currency);
  const returnUrls = getReturnUrls(MERCADO_PAGO_PROVIDER);
  const backendUrl = getBackendUrl();
  const normalizedPaymentMethod = String(paymentMethod || 'pix').toLowerCase();
  const excludedPaymentTypes = [
    { id: 'credit_card' },
    { id: 'debit_card' },
    { id: 'account_money' },
  ];

  if (normalizedPaymentMethod === 'pix') {
    excludedPaymentTypes.push({ id: 'ticket' });
  }

  if (normalizedPaymentMethod === 'boleto') {
    excludedPaymentTypes.push({ id: 'bank_transfer' });
  }

  const body = {
    items: [
      {
        id: 'lenavs-unlimited-30d',
        title: pricing.label,
        description: 'Acesso ilimitado por 30 dias ao LenaVS',
        quantity: 1,
        currency_id: pricing.currencyId,
        unit_price: pricing.amount,
      },
    ],
    payer: {
      email: profile.email,
    },
    metadata: {
      user_id: profile.id,
      email: profile.email,
      plan: 'unlimited',
      access_days: UNLIMITED_ACCESS_DAYS,
      preferred_payment_method: normalizedPaymentMethod,
    },
    external_reference: profile.id,
    notification_url: `${backendUrl}/api/payment/webhook/mercadopago`,
    back_urls: {
      success: returnUrls.success,
      pending: returnUrls.pending,
      failure: returnUrls.failure,
    },
    auto_return: 'approved',
    payment_methods: {
      excluded_payment_types: excludedPaymentTypes,
      installments: 1,
    },
    statement_descriptor: 'LENAVS',
  };

  const response = await axios.post(`${MERCADO_PAGO_API_BASE}/checkout/preferences`, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID(),
    },
    timeout: 30000,
  });

  return response.data;
};

export const createPaymentSession = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const provider = String(req.body?.provider || STRIPE_PROVIDER).toLowerCase();
    const currency = String(req.body?.currency || 'brl').toLowerCase();
    const paymentMethod = String(req.body?.paymentMethod || 'pix').toLowerCase();

    const profile = await findUserProfile({ userId: user.id });

    if (!profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (provider === MERCADO_PAGO_PROVIDER) {
      const preference = await createMercadoPagoPreference({
        profile,
        currency: 'brl',
        paymentMethod,
      });

      await upsertPaymentTransaction({
        provider: MERCADO_PAGO_PROVIDER,
        externalId: preference.id,
        userId: profile.id,
        email: profile.email,
        paymentType: paymentMethod,
        status: 'created',
        rawPayload: preference,
      });

      return res.json({
        provider: MERCADO_PAGO_PROVIDER,
        sessionUrl: preference.init_point,
        preferenceId: preference.id,
        paymentMethod,
      });
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
    console.error('❌ Erro ao criar sessão de pagamento:', err);
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

const extractMercadoPagoPaymentId = (req) => {
  const fromQuery = req.query?.['data.id'] || req.query?.id || req.query?.data_id;
  const fromBody = req.body?.data?.id || req.body?.id || null;
  return fromQuery || fromBody || null;
};

export const handleMercadoPagoWebhook = async (req, res) => {
  try {
    const paymentId = extractMercadoPagoPaymentId(req);

    if (!paymentId) {
      return res.status(200).json({ received: true, ignored: true, reason: 'payment_id_missing' });
    }

    const payment = await fetchMercadoPagoPayment(paymentId);
    const status = String(payment?.status || '').toLowerCase();
    const userId = payment?.metadata?.user_id || payment?.external_reference || null;
    const email = payment?.metadata?.email || payment?.payer?.email || null;

    const transaction = await upsertPaymentTransaction({
      provider: MERCADO_PAGO_PROVIDER,
      externalId: String(payment.id),
      userId,
      email,
      paymentType: payment?.payment_type_id || 'pix_or_boleto',
      status,
      rawPayload: payment,
    });

    if (status === 'approved' && !alreadyGrantedAccess(transaction)) {
      await applyUnlimitedAccessToUser({
        userId,
        email,
        provider: MERCADO_PAGO_PROVIDER,
        externalId: String(payment.id),
      });
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('❌ Erro no webhook Mercado Pago:', error.response?.data || error.message || error);
    return res.status(500).json({ error: 'Erro no webhook do Mercado Pago' });
  }
};

export const getSubscriptionStatus = async (req, res) => {
  try {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
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
