import stripe from '../config/stripe.js';
import { supabase } from '../config/supabase.js';
import { GENERIC_ERROR_MESSAGE, logInternalError } from '../utils/publicError.js';

const getFrontendUrl = () => String(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

const buildFrontendRouteUrl = (route = '/') => {
  const normalizedRoute = String(route || '/').startsWith('/') ? String(route || '/') : `/${route}`;
  return `${getFrontendUrl()}/#${normalizedRoute}`;
};

const normalizeStripeId = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.id || null;
  return null;
};

const fetchUserProfile = async (userId) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
};

const persistStripeCustomerIdIfNeeded = async (userId, currentProfile, customerId) => {
  if (!customerId || currentProfile?.stripe_customer_id === customerId) {
    return;
  }

  const updatePayload = { stripe_customer_id: customerId };
  if (currentProfile && Object.prototype.hasOwnProperty.call(currentProfile, 'updated_at')) {
    updatePayload.updated_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('users')
    .update(updatePayload)
    .eq('id', userId);

  if (error) {
    console.warn('Não foi possível salvar stripe_customer_id do usuário:', error.message);
  }
};

const resolveStripeCustomerId = async (profile) => {
  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  if (profile?.stripe_subscription_id) {
    try {
      const subscription = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      const customerId = normalizeStripeId(subscription?.customer);
      if (customerId) {
        await persistStripeCustomerIdIfNeeded(profile.id, profile, customerId);
        return customerId;
      }
    } catch (error) {
      console.warn('Falha ao recuperar cliente Stripe pela assinatura:', error.message);
    }
  }

  if (profile?.email) {
    try {
      const customers = await stripe.customers.list({ email: profile.email, limit: 1 });
      const customerId = normalizeStripeId(customers?.data?.[0]);
      if (customerId) {
        await persistStripeCustomerIdIfNeeded(profile.id, profile, customerId);
        return customerId;
      }
    } catch (error) {
      console.warn('Falha ao localizar cliente Stripe por e-mail:', error.message);
    }
  }

  return null;
};

export const createBillingPortalSession = async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      logInternalError('billing-portal:config', new Error('STRIPE_SECRET_KEY ausente'));
      return res.status(500).json({
        code: 'INTERNAL_ERROR',
        error: GENERIC_ERROR_MESSAGE,
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Entre na sua conta para continuar.',
      });
    }

    const profile = await fetchUserProfile(userId);
    if (!profile) {
      return res.status(404).json({
        code: 'USER_NOT_FOUND',
        error: 'Não encontramos sua conta. Entre novamente para continuar.',
      });
    }

    const customerId = await resolveStripeCustomerId(profile);

    if (!customerId) {
      return res.status(400).json({
        code: 'NO_BILLING_ACCOUNT',
        error: 'Você ainda não tem uma assinatura para gerenciar.',
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: buildFrontendRouteUrl('/editor'),
    });

    return res.json({ url: session.url });
  } catch (error) {
    logInternalError('billing-portal:create-session', error);
    return res.status(500).json({
      code: 'BILLING_PORTAL_FAILED',
      error: 'Não foi possível abrir o portal de cobrança. Tente novamente.',
    });
  }
};
