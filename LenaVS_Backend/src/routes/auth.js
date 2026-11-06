import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { supabase, supabaseAnon } from '../config/supabase.js';
import { GENERIC_ERROR_MESSAGE } from '../utils/publicError.js';

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6;

const isValidEmail = (value) => EMAIL_REGEX.test(String(value || '').trim());
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const COUNTRY_TO_GROUP = {
  BR: 'BR', US: 'INTL', CA: 'INTL', AU: 'INTL', NZ: 'INTL',
  SG: 'INTL', HK: 'INTL', OTHER: 'INTL',
};

const normalizeCountryCode = (value) => {
  const code = String(value || 'BR').trim().toUpperCase();
  return COUNTRY_TO_GROUP[code] ? code : 'OTHER';
};

const buildMetadataFromPayload = ({ name, countryCode, acceptedLegal }) => {
  const group = COUNTRY_TO_GROUP[normalizeCountryCode(countryCode)] || 'INTL';
  return {
    name: String(name || '').trim(),
    full_name: String(name || '').trim(),
    display_name: String(name || '').trim(),
    country_group: group,
    country: group === 'BR' ? 'BR' : 'INTL',
    country_code: normalizeCountryCode(countryCode),
    preferred_currency: group === 'BR' ? 'BRL' : 'USD',
    accepted_legal_terms: Boolean(acceptedLegal),
    legal_acceptance_at: new Date().toISOString(),
    privacy_policy_version: '2026-06',
  };
};

/* =====================================================
   URL de retorno do e-mail (confirmação / recuperação)
   -----------------------------------------------------
   O Supabase só aceita um "redirect_to" que esteja na
   lista "Redirect URLs" do painel. Para não depender do
   que o navegador manda (e evitar 422 "email redirect
   not allowed"), a origem é validada no servidor.
===================================================== */

const normalizeOrigin = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
};

const getAllowedOrigins = () =>
  [
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    process.env.PUBLIC_FRONTEND_URL,
    ...String(process.env.ALLOWED_ORIGINS || '').split(','),
  ]
    .map(normalizeOrigin)
    .filter(Boolean);

const resolveRedirectTo = (requested) => {
  const allowed = getAllowedOrigins();
  const fallback = normalizeOrigin(process.env.FRONTEND_URL || process.env.APP_URL || '');
  const candidate = String(requested || '').trim();

  if (!candidate) {
    return fallback || undefined;
  }

  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) {
      return fallback || undefined;
    }
    // Envia apenas a origem: o Supabase acrescenta "#access_token=..."
    // e o HashRouter do frontend lê esse fragmento.
    const origin = normalizeOrigin(url.origin);
    if (!allowed.length) {
      return origin;
    }
    return allowed.includes(origin) ? origin : (fallback || undefined);
  } catch {
    return fallback || undefined;
  }
};

/* =====================================================
   Proteção simples contra força bruta (memória local)
===================================================== */

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_LIMIT = 20;
const authAttempts = new Map();

const isRateLimited = (key) => {
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || now - entry.first > ATTEMPT_WINDOW_MS) {
    authAttempts.set(key, { first: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > ATTEMPT_LIMIT;
};

const clearRateLimit = (key) => authAttempts.delete(key);

/* =====================================================
   Erros técnicos nunca são enviados ao navegador.
===================================================== */

const SUPABASE_ERROR_MAP = [
  {
    test: (m) => /invalid login credentials|invalid credentials|invalid password|password is incorrect/i.test(m),
    status: 401,
    code: 'INVALID_LOGIN_CREDENTIALS',
    message: 'Senha incorreta. Tente novamente.',
  },
  {
    test: (m) => /email not confirmed|email is not confirmed|email_not_confirmed/i.test(m),
    status: 403,
    code: 'EMAIL_NOT_CONFIRMED',
    message: 'Confirme seu e-mail antes de entrar.',
  },
  {
    test: (m) => /for security purposes.*\d+ seconds|only request this after/i.test(m),
    status: 429,
    code: 'TOO_MANY_REQUESTS',
    message: 'Aguarde alguns instantes antes de pedir outro e-mail.',
  },
  {
    test: (m) => /rate limit|too many requests|over_email_send_rate_limit/i.test(m),
    status: 429,
    code: 'TOO_MANY_REQUESTS',
    message: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.',
  },
  {
    test: (m) => /signups? not allowed|signup is disabled|email signups are disabled|signups are disabled/i.test(m),
    status: 403,
    code: 'SIGNUP_DISABLED',
    message: 'O cadastro está temporariamente indisponível. Tente novamente mais tarde.',
  },
  {
    test: (m) => /email address .* not authorized|not authorized/i.test(m),
    status: 403,
    code: 'EMAIL_NOT_AUTHORIZED',
    message: 'Este e-mail não pode ser cadastrado. Use outro e-mail.',
  },
  {
    test: (m) => /exceed_storage_size_quota|exceed storage size|storage quota/i.test(m),
    status: 402,
    code: 'STORAGE_QUOTA_EXCEEDED',
    message: GENERIC_ERROR_MESSAGE,
  },
  {
    test: (m) => /restricted due to/i.test(m),
    status: 402,
    code: 'SUPABASE_RESTRICTED',
    message: GENERIC_ERROR_MESSAGE,
  },
  {
    test: (m) => /billing|spend cap|plan upgrade/i.test(m),
    status: 402,
    code: 'BILLING_RESTRICTED',
    message: GENERIC_ERROR_MESSAGE,
  },
  {
    test: (m) => /already (registered|exists|in use)|user already registered/i.test(m),
    status: 409,
    code: 'EMAIL_ALREADY_REGISTERED',
    message: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
  },
  {
    test: (m) => /password should be at least|weak password|password.*too short|password.*characters/i.test(m),
    status: 400,
    code: 'WEAK_PASSWORD',
    message: 'A senha precisa ter pelo menos 6 caracteres.',
  },
  {
    test: (m) => /unable to validate email|invalid email|invalid format/i.test(m),
    status: 400,
    code: 'INVALID_EMAIL',
    message: 'Digite um e-mail válido.',
  },
  {
    test: (m) => /database error saving new user|database error/i.test(m),
    status: 500,
    code: 'SIGNUP_DATABASE_ERROR',
    message: 'Não foi possível criar sua conta agora. Tente novamente.',
  },
];

const mapSupabaseError = (error) => {
  const raw = String(error?.message || error || '');
  for (const rule of SUPABASE_ERROR_MAP) if (rule.test(raw)) return { ...rule, raw_message: raw };
  return null;
};

const sendMappedSupabaseError = (res, error) => {
  const mapped = mapSupabaseError(error);
  if (!mapped) return null;

  // "database error saving new user" quase sempre significa que o trigger
  // handle_new_user falhou (schema desatualizado). O usuário recebe a
  // mensagem neutra; o administrador vê a pista no log.
  if (mapped.code === 'SIGNUP_DATABASE_ERROR') {
    console.error(
      '[auth] O Supabase recusou a criação do usuário por erro no banco. ' +
      'Rode novamente o script supabase_schema.sql (trigger handle_new_user / tabela public.users).',
      error
    );
  } else {
    console.error(`[auth] erro Supabase reconhecido (${mapped.code}):`, error);
  }

  return res.status(mapped.status).json({ code: mapped.code, error: mapped.message });
};

/**
 * Procura um e-mail já cadastrado.
 *
 * CORRIGIDO: a versão anterior usava `supabase.auth.admin.getUserByEmail()`,
 * método que NÃO existe no @supabase/supabase-js. Isso lançava TypeError,
 * caía no catch e devolvia 500 em toda chamada de /check-email.
 * Agora a busca é feita primeiro na tabela pública (rápida) e, como
 * fallback, na listagem de usuários do Auth.
 */
const emailAlreadyRegistered = async (email) => {
  const target = normalizeEmail(email);

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .ilike('email', target)
      .limit(1);

    if (!error && Array.isArray(data) && data.length > 0) {
      return true;
    }
  } catch (error) {
    console.warn('[auth] Falha ao consultar public.users por e-mail:', error?.message);
  }

  try {
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (!error && Array.isArray(data?.users)) {
      return data.users.some((user) => normalizeEmail(user?.email) === target);
    }
  } catch (error) {
    console.warn('[auth] Falha ao listar usuários do Auth:', error?.message);
  }

  return false;
};

/* =====================================================
   GET /api/auth/health
===================================================== */

router.get('/health', async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });

    if (error) {
      const mapped = mapSupabaseError(error);
      if (mapped) {
        return res.status(mapped.status).json({
          success: false, supabase_reachable: false, code: mapped.code, error: mapped.message,
        });
      }
      console.error('Supabase admin listUsers falhou:', error);
      return res.status(503).json({
        success: false, supabase_reachable: false,
        error: GENERIC_ERROR_MESSAGE,
      });
    }

    return res.json({ success: true, supabase_reachable: true, users_sample_count: data?.users?.length ?? 0 });
  } catch (err) {
    console.error('Erro inesperado em /api/auth/health:', err);
    return res.status(500).json({ success: false, supabase_reachable: false, error: GENERIC_ERROR_MESSAGE });
  }
});

/* =====================================================
   POST /api/auth/check-email
===================================================== */

router.post('/check-email', async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }

  try {
    const exists = await emailAlreadyRegistered(email);
    return res.json({ success: true, exists });
  } catch (error) {
    console.error('Erro inesperado ao verificar e-mail de login:', error);
    return res.status(500).json({ code: 'EMAIL_CHECK_ERROR', error: GENERIC_ERROR_MESSAGE });
  }
});

/* =====================================================
   POST /api/auth/login
===================================================== */

router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const rateKey = `login:${email || req.ip}`;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }

  if (!password) {
    return res.status(400).json({ code: 'PASSWORD_REQUIRED', error: 'Digite sua senha.' });
  }

  if (isRateLimited(rateKey)) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      error: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.',
    });
  }

  try {
    const { data, error } = await supabaseAnon.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      const mapped = sendMappedSupabaseError(res, error);
      if (mapped) return mapped;

      console.error('Erro ao fazer login pelo Supabase:', error);
      return res.status(500).json({
        code: 'LOGIN_FAILED',
        error: GENERIC_ERROR_MESSAGE,
      });
    }

    if (!data?.session) {
      console.error('Login do Supabase não retornou uma sessão.');
      return res.status(500).json({
        code: 'LOGIN_FAILED',
        error: GENERIC_ERROR_MESSAGE,
      });
    }

    clearRateLimit(rateKey);

    return res.json({
      success: true,
      session: data.session,
      user: data.user
        ? { id: data.user.id, email: data.user.email }
        : null,
    });
  } catch (error) {
    console.error('Erro inesperado ao fazer login:', error);
    const mapped = sendMappedSupabaseError(res, error);
    if (mapped) return mapped;

    return res.status(500).json({
      code: 'LOGIN_FAILED',
      error: GENERIC_ERROR_MESSAGE,
    });
  }
});

/* =====================================================
   POST /api/auth/signup-direct (e /ensure-account)
   -----------------------------------------------------
   Usa SEMPRE o cliente ANON: o Supabase envia o e-mail de
   confirmação e mantém email_confirmed_at nulo até o link
   ser clicado. O service_role jamais cria/confirma contas.
===================================================== */

const createPendingAccount = async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const countryCode = normalizeCountryCode(req.body?.countryCode || req.body?.country || 'BR');
  const acceptedLegal = Boolean(
    req.body?.acceptedLegal ?? req.body?.accepted_legal_terms ?? req.body?.acceptLegal ?? false
  );
  const rateKey = `signup:${email || req.ip}`;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (!name || name.length < 2) {
    return res.status(400).json({ code: 'INVALID_NAME', error: 'Informe seu nome completo.' });
  }
  if (!acceptedLegal) {
    return res.status(400).json({ code: 'LEGAL_NOT_ACCEPTED', error: 'Você precisa aceitar os termos e a política de privacidade.' });
  }

  if (isRateLimited(rateKey)) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      error: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.',
    });
  }

  try {
    const metadata = buildMetadataFromPayload({ name, countryCode, acceptedLegal });

    // A conta já existe? Devolve 409 antes de tentar o signUp (evita o
    // comportamento silencioso de "email enumeration protection").
    if (await emailAlreadyRegistered(email)) {
      return res.status(409).json({
        code: 'EMAIL_ALREADY_REGISTERED',
        error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
      });
    }

    const { data: created, error: createError } = await supabaseAnon.auth.signUp({
      email,
      password,
      options: {
        data: metadata,
        emailRedirectTo: resolveRedirectTo(req.body?.emailRedirectTo),
      },
    });

    if (createError || !created?.user) {
      const mapped = sendMappedSupabaseError(res, createError);
      if (mapped) return mapped;

      const msg = String(createError?.message || '').toLowerCase();
      const alreadyExists = msg.includes('already') || msg.includes('exists') || msg.includes('registered');

      if (alreadyExists) {
        return res.status(409).json({
          code: 'EMAIL_ALREADY_REGISTERED',
          error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
        });
      }

      console.error('Erro ao criar usuário pelo Supabase:', createError);
      return res.status(500).json({ code: 'SIGNUP_FAILED', error: GENERIC_ERROR_MESSAGE });
    }

    // Com "email enumeration protection" ligado, o Supabase devolve um
    // usuário "fantasma" (identities vazio) quando o e-mail já existe.
    if (Array.isArray(created.user.identities) && created.user.identities.length === 0) {
      return res.status(409).json({
        code: 'EMAIL_ALREADY_REGISTERED',
        error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
      });
    }

    const emailConfirmed = Boolean(created.user.email_confirmed_at);
    clearRateLimit(rateKey);

    return res.status(201).json({
      success: true,
      user: { id: created.user.id, email, email_confirmed: emailConfirmed },
      email_confirmation_required: !emailConfirmed,
      message: emailConfirmed
        ? 'Cadastro realizado. Você já pode entrar.'
        : 'Cadastro realizado. Verifique seu e-mail para confirmar a conta antes de entrar.',
      next_step: emailConfirmed ? 'login' : 'confirm_email',
    });
  } catch (error) {
    console.error('Erro inesperado ao cadastrar usuário:', error);
    const mapped = sendMappedSupabaseError(res, error);
    if (mapped) return mapped;

    return res.status(500).json({ code: 'SIGNUP_FAILED', error: GENERIC_ERROR_MESSAGE });
  }
};

router.post('/signup-direct', createPendingAccount);
router.post('/ensure-account', createPendingAccount);

/* =====================================================
   POST /api/auth/resend-confirmation
   Reenvia o e-mail de confirmação de cadastro.
===================================================== */

router.post('/resend-confirmation', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const rateKey = `resend:${email || req.ip}`;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }

  if (isRateLimited(rateKey)) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      error: 'Aguarde alguns minutos antes de pedir outro e-mail.',
    });
  }

  try {
    const { error } = await supabaseAnon.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: resolveRedirectTo(req.body?.emailRedirectTo) },
    });

    if (error) {
      const mapped = mapSupabaseError(error);
      if (mapped && mapped.code !== 'EMAIL_ALREADY_REGISTERED') {
        console.error(`[auth] erro ao reenviar confirmação (${mapped.code}):`, error);
        return res.status(mapped.status).json({ code: mapped.code, error: mapped.message });
      }
      // Não revelamos se o e-mail existe ou não.
    }

    return res.json({
      success: true,
      message: 'Se este e-mail precisar de confirmação, enviamos um novo link. Verifique sua caixa de entrada e o spam.',
    });
  } catch (error) {
    console.error('Erro inesperado ao reenviar confirmação:', error);
    return res.status(500).json({ code: 'RESEND_FAILED', error: GENERIC_ERROR_MESSAGE });
  }
});

/* =====================================================
   POST /api/auth/forgot-password
   Envia o link de redefinição de senha.
===================================================== */

router.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const rateKey = `forgot:${email || req.ip}`;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }

  if (isRateLimited(rateKey)) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      error: 'Aguarde alguns minutos antes de pedir outro e-mail.',
    });
  }

  // Resposta sempre igual: não confirmamos se o e-mail existe.
  const genericResponse = {
    success: true,
    message: 'Se este e-mail estiver cadastrado, enviamos um link para redefinir a senha.',
  };

  try {
    const { error } = await supabaseAnon.auth.resetPasswordForEmail(email, {
      redirectTo: resolveRedirectTo(req.body?.emailRedirectTo || req.body?.redirectTo),
    });

    if (error) {
      const mapped = mapSupabaseError(error);
      if (mapped && mapped.status === 429) {
        return res.status(429).json({ code: mapped.code, error: mapped.message });
      }
      console.error('[auth] erro ao enviar recuperação de senha:', error);
    }

    return res.json(genericResponse);
  } catch (error) {
    console.error('Erro inesperado ao enviar recuperação de senha:', error);
    return res.json(genericResponse);
  }
});

/* =====================================================
   POST /api/auth/update-password (autenticado)
   Usado pela tela de redefinição de senha.
===================================================== */

router.post('/update-password', authenticateToken, async (req, res) => {
  const password = String(req.body?.password || '');

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      code: 'WEAK_PASSWORD',
      error: 'A senha precisa ter pelo menos 6 caracteres.',
    });
  }

  try {
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password });

    if (error) {
      const mapped = sendMappedSupabaseError(res, error);
      if (mapped) return mapped;
      console.error('Erro ao atualizar senha:', error);
      return res.status(500).json({ code: 'PASSWORD_UPDATE_FAILED', error: GENERIC_ERROR_MESSAGE });
    }

    return res.json({ success: true, message: 'Senha atualizada. Entre com a nova senha.' });
  } catch (error) {
    console.error('Erro inesperado ao atualizar senha:', error);
    return res.status(500).json({ code: 'PASSWORD_UPDATE_FAILED', error: GENERIC_ERROR_MESSAGE });
  }
});

/* =====================================================
   GET /api/auth/me
===================================================== */

router.get('/me', authenticateToken, async (req, res) => {
  try {
    return res.json({ success: true, user: { id: req.user.id, email: req.user.email } });
  } catch (err) {
    console.error('Erro na rota /api/auth/me:', err);
    return res.status(500).json({ code: 'INTERNAL_ERROR', error: GENERIC_ERROR_MESSAGE });
  }
});

export default router;
