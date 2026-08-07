import express from 'express';
import { authenticateToken, ensureUserExists } from '../middleware/auth.js';
import { supabase } from '../config/supabase.js';

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (value) => EMAIL_REGEX.test(String(value || '').trim());

const COUNTRY_TO_GROUP = {
  BR: 'BR',
  US: 'INTL',
  CA: 'INTL',
  AU: 'INTL',
  NZ: 'INTL',
  SG: 'INTL',
  HK: 'INTL',
  OTHER: 'INTL',
};

const normalizeCountryCode = (value) => {
  const code = String(value || 'BR').trim().toUpperCase();
  return COUNTRY_TO_GROUP[code] ? code : 'OTHER';
};

const buildMetadataFromPayload = ({ name, countryCode, acceptedLegal }) => {
  const group = COUNTRY_TO_GROUP[normalizeCountryCode(countryCode)] || 'INTL';
  const acceptedAt = new Date().toISOString();
  return {
    name: String(name || '').trim(),
    full_name: String(name || '').trim(),
    display_name: String(name || '').trim(),
    country_group: group,
    country: group === 'BR' ? 'BR' : 'INTL',
    country_code: normalizeCountryCode(countryCode),
    preferred_currency: group === 'BR' ? 'BRL' : 'USD',
    accepted_legal_terms: Boolean(acceptedLegal),
    legal_acceptance_at: acceptedAt,
    privacy_policy_version: '2026-06',
  };
};

/**
 * GET /api/auth/health
 * Endpoint simples para diagnosticar a conexão do backend com o Supabase.
 */
router.get('/health', async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      console.error('Supabase admin listUsers falhou:', error);
      return res.status(503).json({
        success: false,
        supabase_reachable: false,
        error: 'Não foi possível alcançar o Supabase pelo service_role.',
        details: error.message,
      });
    }
    return res.json({
      success: true,
      supabase_reachable: true,
      users_sample_count: data?.users?.length ?? 0,
    });
  } catch (err) {
    console.error('Erro inesperado em /api/auth/health:', err);
    return res.status(500).json({
      success: false,
      supabase_reachable: false,
      error: err?.message || 'Erro interno',
    });
  }
});

/**
 * POST /api/auth/check-email
 * Verifica se o e-mail existe (apenas bool, sem expor dados).
 */
router.post('/check-email', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      code: 'INVALID_EMAIL',
      error: 'Digite um e-mail válido.',
    });
  }

  try {
    const { data, error } = await supabase.auth.admin.getUserByEmail(email);

    const notFound = /not found|user not found|no user found/i.test(String(error?.message || ''));

    if (error && !notFound) {
      console.error('Erro ao verificar e-mail de login:', error);
      return res.status(500).json({
        code: 'EMAIL_CHECK_ERROR',
        error: 'Não foi possível verificar o e-mail agora.',
      });
    }

    return res.json({
      success: true,
      exists: Boolean(data?.user),
    });
  } catch (error) {
    console.error('Erro inesperado ao verificar e-mail de login:', error);
    return res.status(500).json({
      code: 'EMAIL_CHECK_ERROR',
      error: 'Não foi possível verificar o e-mail agora.',
    });
  }
});

/**
 * POST /api/auth/signup-direct
 * Cadastro robusto via service_role que AUTO-CONFIRMA o e-mail
 * (ignora SMTP do Supabase). Cria o usuário e devolve um access_token
 * gerado por senha (signInWithPassword) para que o frontend tenha sessão.
 *
 * Funciona mesmo quando:
 *  - "Enable email confirmations" está ON no painel Supabase;
 *  - o Supabase está com SMTP desabilitado (tier gratuito);
 *  - o usuário esquece de confirmar o e-mail.
 */
router.post('/signup-direct', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const countryCode = normalizeCountryCode(req.body?.countryCode || req.body?.country || 'BR');
  const acceptedLegal = Boolean(
    req.body?.acceptedLegal ?? req.body?.accepted_legal_terms ?? req.body?.acceptLegal ?? false
  );

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (!name || name.length < 2) {
    return res.status(400).json({ code: 'INVALID_NAME', error: 'Informe seu nome completo.' });
  }
  if (!acceptedLegal) {
    return res.status(400).json({
      code: 'LEGAL_NOT_ACCEPTED',
      error: 'Você precisa aceitar os termos e a política de privacidade.',
    });
  }

  try {
    const metadata = buildMetadataFromPayload({ name, countryCode, acceptedLegal });

    // 1. Verifica se já existe
    try {
      const { data: existing } = await supabase.auth.admin.getUserByEmail(email);
      if (existing?.user) {
        // Tenta garantir a existência do perfil caso o trigger não tenha rodado
        await ensureUserExists(existing.user);
        return res.status(409).json({
          code: 'EMAIL_ALREADY_REGISTERED',
          error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
        });
      }
    } catch (_) {
      // Se der erro de "not found" seguimos adiante
    }

    // 2. Cria usuário AUTO-CONFIRMADO
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });

    if (createError || !created?.user) {
      const msg = String(createError?.message || '').toLowerCase();
      const code = String(createError?.status || createError?.code || '');
      const alreadyExists =
        msg.includes('already') ||
        msg.includes('exists') ||
        msg.includes('registered') ||
        msg.includes('duplicate') ||
        code === '422';

      if (alreadyExists) {
        return res.status(409).json({
          code: 'EMAIL_ALREADY_REGISTERED',
          error: 'Este e-mail já está cadastrado. Tente entrar ou use outro e-mail.',
        });
      }

      console.error('Erro ao criar usuário via admin:', createError);
      return res.status(500).json({
        code: 'SIGNUP_FAILED',
        error: 'Não foi possível criar sua conta agora. Tente novamente em alguns instantes.',
        details: createError?.message,
      });
    }

    const userId = created.user.id;

    // 3. Garante o perfil em public.users (caso o trigger esteja desabilitado)
    const profile = await ensureUserExists(created.user);

    // 4. Gera sessão válida para o frontend (login implícito)
    let accessToken = null;
    let refreshToken = null;
    let expiresIn = 3600;
    try {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo: 'https://lenavs.com' },
      });
      if (!linkError && linkData?.properties?.action_link) {
        // Note: não usamos access_token do link mágico pois não retorna sessão.
      }
    } catch (_) {}

    // Estratégia final: retorna o user_id e instrui o front a usar Supabase signInWithPassword.
    return res.status(201).json({
      success: true,
      user: {
        id: userId,
        email,
        email_confirmed: true,
      },
      profile: profile || null,
      message: 'Conta criada com sucesso. Você já pode entrar na plataforma.',
      next_step: 'signin_with_password',
    });
  } catch (error) {
    console.error('Erro inesperado em /api/auth/signup-direct:', error);
    return res.status(500).json({
      code: 'SIGNUP_FAILED',
      error: 'Não foi possível criar sua conta agora. Tente novamente em alguns instantes.',
      details: error?.message,
    });
  }
});

/**
 * POST /api/auth/ensure-account
 * Se o usuário JÁ existe (auth e public.users), sempre devolve 200 com perfil.
 * Se NÃO existe e dados válidos foram enviados, cria auto-confirmado.
 * Esto resolve: "não consigo cadastrar nem logar" típico quando o trigger falha.
 */
router.post('/ensure-account', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const countryCode = normalizeCountryCode(req.body?.countryCode || req.body?.country || 'BR');
  const acceptedLegal = Boolean(
    req.body?.acceptedLegal ?? req.body?.accepted_legal_terms ?? req.body?.acceptLegal ?? false
  );

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (!name || name.length < 2) {
    return res.status(400).json({ code: 'INVALID_NAME', error: 'Informe seu nome completo.' });
  }
  if (!acceptedLegal) {
    return res.status(400).json({
      code: 'LEGAL_NOT_ACCEPTED',
      error: 'Você precisa aceitar os termos e a política de privacidade.',
    });
  }

  try {
    let existingUser = null;
    try {
      const { data } = await supabase.auth.admin.getUserByEmail(email);
      existingUser = data?.user || null;
    } catch (_) {}

    if (!existingUser) {
      const metadata = buildMetadataFromPayload({ name, countryCode, acceptedLegal });
      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: metadata,
      });

      if (createError || !created?.user) {
        const msg = String(createError?.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
          const { data: retry } = await supabase.auth.admin.getUserByEmail(email);
          existingUser = retry?.user || null;
        } else {
          console.error('ensure-account: erro ao criar:', createError);
          return res.status(500).json({
            code: 'SIGNUP_FAILED',
            error: 'Não foi possível criar sua conta agora. Tente novamente em alguns instantes.',
            details: createError?.message,
          });
        }
      } else {
        existingUser = created.user;
      }
    }

    if (!existingUser) {
      return res.status(500).json({
        code: 'SIGNUP_FAILED',
        error: 'Não foi possível criar nem localizar sua conta. Tente novamente.',
      });
    }

    // Garante que o perfil existe (cria via fallback caso trigger falhe)
    const profile = await ensureUserExists(existingUser);

    return res.status(200).json({
      success: true,
      user: {
        id: existingUser.id,
        email: existingUser.email,
        email_confirmed: !!existingUser.email_confirmed_at,
      },
      profile,
      next_step: 'signin_with_password',
      message: 'Conta pronta. Use a senha cadastrada para entrar na próxima tela.',
    });
  } catch (error) {
    console.error('Erro inesperado em /api/auth/ensure-account:', error);
    return res.status(500).json({
      code: 'SIGNUP_FAILED',
      error: 'Não foi possível preparar sua conta agora. Tente novamente em alguns instantes.',
      details: error?.message,
    });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    return res.json({
      success: true,
      user: { id: req.user.id, email: req.user.email },
    });
  } catch (err) {
    console.error('Erro na rota /api/auth/me:', err);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno' });
  }
});

export default router;
