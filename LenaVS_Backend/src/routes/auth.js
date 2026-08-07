import express from 'express';
import { authenticateToken, ensureUserExists } from '../middleware/auth.js';
import { supabase } from '../config/supabase.js';

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (value) => EMAIL_REGEX.test(String(value || '').trim());

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

// =====================================================
// Mapeia erros do Supabase em mensagens claras em PT-BR.
// Sem isso, quota/quota-storage/restricted viravam 500 genérico.
// =====================================================
const SUPABASE_ERROR_MAP = [
  {
    test: (m) => /exceed_storage_size_quota|exceed storage size|storage quota/i.test(m),
    status: 402,
    code: 'STORAGE_QUOTA_EXCEEDED',
    message:
      'O serviço do Supabase do LenaVS está temporariamente restrito por cota de armazenamento. '
      + 'Libere espaço em Storage no painel do Supabase (ou remova o spend cap) e tente novamente em alguns minutos.',
  },
  {
    test: (m) => /restricted due to/i.test(m),
    status: 402,
    code: 'SUPABASE_RESTRICTED',
    message:
      'O serviço do Supabase do LenaVS está temporariamente restrito. '
      + 'Aguarde alguns minutos ou verifique a fatura do projeto no Supabase.',
  },
  {
    test: (m) => /billing|spend cap|plan upgrade/i.test(m),
    status: 402,
    code: 'BILLING_RESTRICTED',
    message:
      'O projeto Supabase do LenaVS atingiu o limite do plano gratuito. '
      + 'Remova o spend cap no painel do Supabase ou faça upgrade do plano para continuar.',
  },
  {
    test: (m) => /already (registered|exists|in use)/i.test(m),
    status: 409,
    code: 'EMAIL_ALREADY_REGISTERED',
    message: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
  },
  {
    test: (m) => /password should be at least|weak password|password.*too short/i.test(m),
    status: 400,
    code: 'WEAK_PASSWORD',
    message: 'A senha precisa ter pelo menos 6 caracteres.',
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
  console.warn(`[auth] erro Supabase reconhecido (${mapped.code}):`, error?.message);
  return res.status(mapped.status).json({ code: mapped.code, error: mapped.message, details: mapped.raw_message });
};

/**
 * GET /api/auth/health
 */
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
        error: 'Não foi possível alcançar o Supabase pelo service_role.', details: error.message,
      });
    }
    return res.json({ success: true, supabase_reachable: true, users_sample_count: data?.users?.length ?? 0 });
  } catch (err) {
    console.error('Erro inesperado em /api/auth/health:', err);
    return res.status(500).json({ success: false, supabase_reachable: false, error: err?.message || 'Erro interno' });
  }
});

/**
 * POST /api/auth/check-email
 */
router.post('/check-email', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }

  try {
    const { data, error } = await supabase.auth.admin.getUserByEmail(email);
    const notFound = /not found|user not found|no user found/i.test(String(error?.message || ''));

    if (error && !notFound) {
      const mapped = sendMappedSupabaseError(res, error);
      if (mapped) return mapped;
      console.error('Erro ao verificar e-mail de login:', error);
      return res.status(500).json({ code: 'EMAIL_CHECK_ERROR', error: 'Não foi possível verificar o e-mail agora.' });
    }

    return res.json({ success: true, exists: Boolean(data?.user) });
  } catch (error) {
    console.error('Erro inesperado ao verificar e-mail de login:', error);
    return res.status(500).json({ code: 'EMAIL_CHECK_ERROR', error: 'Não foi possível verificar o e-mail agora.' });
  }
});

/**
 * POST /api/auth/signup-direct
 */
router.post('/signup-direct', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const countryCode = normalizeCountryCode(req.body?.countryCode || req.body?.country || 'BR');
  const acceptedLegal = Boolean(
    req.body?.acceptedLegal ?? req.body?.accepted_legal_terms ?? req.body?.acceptLegal ?? false
  );

  if (!email || !isValidEmail(email)) return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  if (!password || password.length < 6) return res.status(400).json({ code: 'WEAK_PASSWORD', error: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (!name || name.length < 2) return res.status(400).json({ code: 'INVALID_NAME', error: 'Informe seu nome completo.' });
  if (!acceptedLegal) return res.status(400).json({ code: 'LEGAL_NOT_ACCEPTED', error: 'Você precisa aceitar os termos e a política de privacidade.' });

  try {
    const metadata = buildMetadataFromPayload({ name, countryCode, acceptedLegal });

    try {
      const { data: existing } = await supabase.auth.admin.getUserByEmail(email);
      if (existing?.user) {
        await ensureUserExists(existing.user);
        return res.status(409).json({ code: 'EMAIL_ALREADY_REGISTERED', error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.' });
      }
    } catch (_) { /* not found */ }

    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: metadata,
    });

    if (createError || !created?.user) {
      const mapped = sendMappedSupabaseError(res, createError);
      if (mapped) return mapped;

      const msg = String(createError?.message || '').toLowerCase();
      const code = String(createError?.status || createError?.code || '');
      const alreadyExists = msg.includes('already') || msg.includes('exists') || msg.includes('registered') || msg.includes('duplicate') || code === '422';

      if (alreadyExists) {
        return res.status(409).json({ code: 'EMAIL_ALREADY_REGISTERED', error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.' });
      }

      console.error('Erro ao criar usuário via admin:', createError);
      return res.status(500).json({ code: 'SIGNUP_FAILED', error: 'Não foi possível criar sua conta agora. Tente novamente em alguns instantes.', details: createError?.message });
    }

    const userId = created.user.id;
    const profile = await ensureUserExists(created.user);

    return res.status(201).json({
      success: true,
      user: { id: userId, email, email_confirmed: true },
      profile: profile || null,
      message: 'Conta criada com sucesso. Você já pode entrar na plataforma.',
      next_step: 'signin_with_password',
    });
  } catch (error) {
    console.error('Erro inesperado em /api/auth/signup-direct:', error);
    const mapped = sendMappedSupabaseError(res, error);
    if (mapped) return mapped;
    return res.status(500).json({ code: 'SIGNUP_FAILED', error: 'Não foi possível criar sua conta agora. Tente novamente em alguns instantes.', details: error?.message });
  }
});

/**
 * POST /api/auth/ensure-account
 */
router.post('/ensure-account', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const countryCode = normalizeCountryCode(req.body?.countryCode || req.body?.country || 'BR');
  const acceptedLegal = Boolean(
    req.body?.acceptedLegal ?? req.body?.accepted_legal_terms ?? req.body?.acceptLegal ?? false
  );

  if (!email || !isValidEmail(email)) return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  if (!password || password.length < 6) return res.status(400).json({ code: 'WEAK_PASSWORD', error: 'A senha precisa ter pelo menos 6 caracteres.' });
  if (!name || name.length < 2) return res.status(400).json({ code: 'INVALID_NAME', error: 'Informe seu nome completo.' });
  if (!acceptedLegal) return res.status(400).json({ code: 'LEGAL_NOT_ACCEPTED', error: 'Você precisa aceitar os termos e a política de privacidade.' });

  try {
    let existingUser = null;
    try {
      const { data } = await supabase.auth.admin.getUserByEmail(email);
      existingUser = data?.user || null;
    } catch (_) { /* not found */ }

    if (!existingUser) {
      const metadata = buildMetadataFromPayload({ name, countryCode, acceptedLegal });
      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: metadata,
      });

      if (createError || !created?.user) {
        const mapped = sendMappedSupabaseError(res, createError);
        if (mapped) return mapped;

        const msg = String(createError?.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
          const { data: retry } = await supabase.auth.admin.getUserByEmail(email);
          existingUser = retry?.user || null;
        } else {
          console.error('ensure-account: erro ao criar:', createError);
          return res.status(500).json({ code: 'SIGNUP_FAILED', error: 'Não foi possível criar sua conta agora. Tente novamente em alguns instantes.', details: createError?.message });
        }
      } else {
        existingUser = created.user;
      }
    }

    if (!existingUser) {
      return res.status(500).json({ code: 'SIGNUP_FAILED', error: 'Não foi possível criar nem localizar sua conta. Tente novamente.' });
    }

    const profile = await ensureUserExists(existingUser);

    return res.status(200).json({
      success: true,
      user: { id: existingUser.id, email: existingUser.email, email_confirmed: !!existingUser.email_confirmed_at },
      profile,
      next_step: 'signin_with_password',
      message: 'Conta pronta. Use a senha cadastrada para entrar na próxima tela.',
    });
  } catch (error) {
    console.error('Erro inesperado em /api/auth/ensure-account:', error);
    const mapped = sendMappedSupabaseError(res, error);
    if (mapped) return mapped;
    return res.status(500).json({ code: 'SIGNUP_FAILED', error: 'Não foi possível preparar sua conta agora. Tente novamente em alguns instantes.', details: error?.message });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    return res.json({ success: true, user: { id: req.user.id, email: req.user.email } });
  } catch (err) {
    console.error('Erro na rota /api/auth/me:', err);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
  }
});

export default router;
