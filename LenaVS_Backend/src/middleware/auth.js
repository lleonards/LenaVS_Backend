import { supabase } from '../config/supabase.js';

const normalizeCountryGroup = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized) return null;

  if (['br', 'brasil', 'brazil', 'pt-br', 'pt_br'].includes(normalized)) {
    return 'BR';
  }

  if (['intl', 'international', 'internacional', 'other', 'outro', 'outside_brazil', 'rest_of_world'].includes(normalized)) {
    return 'INTL';
  }

  return null;
};

const getPreferredCurrency = (countryGroup) => (countryGroup === 'BR' ? 'BRL' : 'USD');

const resolveCountryPreferenceFromUser = (user = {}) => {
  const metadata = user?.user_metadata || user?.raw_user_meta_data || {};

  const countryGroup = normalizeCountryGroup(
    metadata.country_group
    || metadata.country
    || metadata.billing_region
    || metadata.market
  );

  if (!countryGroup) {
    return {
      country_group: null,
      preferred_currency: null,
    };
  }

  return {
    country_group: countryGroup,
    preferred_currency: getPreferredCurrency(countryGroup),
  };
};

const syncCountryPreferenceIfNeeded = async (userId, existingUser, authCountryPreference) => {
  if (!existingUser || !authCountryPreference.country_group) {
    return existingUser;
  }

  const needsCountryUpdate = !existingUser.country_group || !existingUser.preferred_currency;

  if (!needsCountryUpdate) {
    return existingUser;
  }

  const { data, error } = await supabase
    .from('users')
    .update({
      country_group: authCountryPreference.country_group,
      preferred_currency: authCountryPreference.preferred_currency,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('*')
    .single();

  if (error) {
    console.warn('Não foi possível sincronizar país/moeda do usuário:', error.message);
    return {
      ...existingUser,
      country_group: existingUser.country_group || authCountryPreference.country_group,
      preferred_currency: existingUser.preferred_currency || authCountryPreference.preferred_currency,
    };
  }

  return data;
};

const ensureUserExists = async (user) => {
  try {
    const authCountryPreference = resolveCountryPreferenceFromUser(user);

    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (fetchError) {
      console.error('Erro ao buscar usuário no banco:', fetchError);
      return null;
    }

    if (existingUser) {
      return syncCountryPreferenceIfNeeded(user.id, existingUser, authCountryPreference);
    }

    const trialDays = 3;
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    const { data, error } = await supabase
      .from('users')
      .insert({
        id: user.id,
        email: user.email,
        subscription_status: 'trial',
        trial_end: trialEnd.toISOString(),
        credits: 3,
        country_group: authCountryPreference.country_group,
        preferred_currency: authCountryPreference.preferred_currency,
      })
      .select()
      .single();

    if (error) {
      console.error('Erro ao criar usuário na tabela users:', error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('Exceção em ensureUserExists:', err);
    return null;
  }
};

export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;

    if (!token) {
      return res.status(401).json({
        error: 'Token não fornecido'
      });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      console.warn('Token inválido ou expirado apresentado.');
      return res.status(403).json({
        error: 'Sessão inválida ou expirada. Faça login novamente.'
      });
    }

    const supabaseUser = data.user;
    const userRecord = await ensureUserExists(supabaseUser);

    if (!userRecord) {
      return res.status(500).json({
        error: 'Erro ao sincronizar seu perfil de usuário.'
      });
    }

    req.user = {
      id: supabaseUser.id,
      email: supabaseUser.email,
      role: supabaseUser.role || 'user',
      plan: userRecord.plan,
      subscription_status: userRecord.subscription_status,
      trial_end: userRecord.trial_end,
      country_group: userRecord.country_group || resolveCountryPreferenceFromUser(supabaseUser).country_group,
      preferred_currency: userRecord.preferred_currency || resolveCountryPreferenceFromUser(supabaseUser).preferred_currency,
      metadata: supabaseUser.user_metadata || {},
    };

    next();
  } catch (err) {
    console.error('Erro CRÍTICO no middleware authenticateToken:', err);
    return res.status(500).json({
      error: 'Erro interno de autenticação no servidor.'
    });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    if (!token) return next();

    const { data, error } = await supabase.auth.getUser(token);

    if (!error && data?.user) {
      const authCountryPreference = resolveCountryPreferenceFromUser(data.user);

      req.user = {
        id: data.user.id,
        email: data.user.email,
        country_group: authCountryPreference.country_group,
        preferred_currency: authCountryPreference.preferred_currency,
        metadata: data.user.user_metadata || {},
      };
    }
    next();
  } catch (err) {
    next();
  }
};
