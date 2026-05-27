import { supabase } from '../config/supabase.js';
import { buildAccessSnapshot, hasUnlimitedAccess } from '../utils/access.js';
import { uploadRequestFileToStorage } from '../services/storageService.js';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

const parseBoolean = (value) => TRUTHY_VALUES.has(String(value || '').trim().toLowerCase());

const normalizeDisplayName = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const deriveDisplayNameFromEmail = (email) => {
  const localPart = String(email || '').split('@')[0] || 'Usuário LenaVS';
  const normalized = localPart.replace(/[._-]+/g, ' ').trim();
  return normalized ? normalized.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Usuário LenaVS';
};

const extractDisplayNameFromMetadata = (metadata = {}) => {
  const candidates = [
    metadata?.display_name,
    metadata?.full_name,
    metadata?.name,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeDisplayName(candidate);
    if (normalized) return normalized;
  }

  return '';
};

const extractAvatarUrlFromMetadata = (metadata = {}) => {
  const candidates = [
    metadata?.avatar_url,
    metadata?.picture,
    metadata?.photo_url,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) return normalized;
  }

  return '';
};

const getMergedProfileFields = ({ profile = {}, metadata = {}, email = '' } = {}) => {
  const displayName =
    normalizeDisplayName(profile?.display_name)
    || extractDisplayNameFromMetadata(metadata)
    || deriveDisplayNameFromEmail(email);

  const avatarUrl =
    String(profile?.avatar_url || '').trim()
    || extractAvatarUrlFromMetadata(metadata)
    || null;

  return {
    display_name: displayName,
    avatar_url: avatarUrl,
  };
};

const safelyFetchUserRecord = async (userId) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

const safelyUpdateUserRecord = async (userId, patch = {}, currentProfile = null) => {
  const safePatch = {};
  const hasCurrentProfile = Boolean(currentProfile && typeof currentProfile === 'object');

  for (const [key, value] of Object.entries(patch)) {
    if (!hasCurrentProfile || Object.prototype.hasOwnProperty.call(currentProfile, key)) {
      safePatch[key] = value;
    }
  }

  if (hasCurrentProfile && Object.prototype.hasOwnProperty.call(currentProfile, 'updated_at')) {
    safePatch.updated_at = new Date().toISOString();
  }

  if (!Object.keys(safePatch).length) {
    return currentProfile;
  }

  const { data, error } = await supabase
    .from('users')
    .update(safePatch)
    .eq('id', userId)
    .select('*')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || currentProfile;
};

const updateAuthUserMetadata = async (userId, existingMetadata = {}, nextProfile = {}) => {
  const nextMetadata = {
    ...existingMetadata,
  };

  if (typeof nextProfile.display_name === 'string') {
    nextMetadata.display_name = nextProfile.display_name;
    nextMetadata.full_name = nextProfile.display_name;
    nextMetadata.name = nextProfile.display_name;
  }

  if (Object.prototype.hasOwnProperty.call(nextProfile, 'avatar_url')) {
    nextMetadata.avatar_url = nextProfile.avatar_url || null;
    nextMetadata.picture = nextProfile.avatar_url || null;
  }

  const { data, error } = await supabase.auth.admin.updateUserById(userId, {
    user_metadata: nextMetadata,
  });

  if (error) {
    throw error;
  }

  return data?.user?.user_metadata || nextMetadata;
};

const buildUserResponse = ({ profile = {}, metadata = {}, email = '' } = {}) => {
  const snapshot = buildAccessSnapshot(profile || {});
  const mergedProfile = getMergedProfileFields({ profile, metadata, email: email || profile?.email || '' });

  return {
    id: profile?.id || null,
    email: profile?.email || email || null,
    plan: snapshot.plan,
    credits: profile?.credits ?? 0,
    credits_remaining: snapshot.credits_remaining,
    subscription_status: snapshot.subscription_status,
    unlimited_access_until: snapshot.unlimited_access_until,
    unlimited: snapshot.unlimited,
    country_group: profile?.country_group || null,
    preferred_currency: profile?.preferred_currency || null,
    display_name: mergedProfile.display_name,
    avatar_url: mergedProfile.avatar_url,
  };
};

export const getCurrentUser = async (req, res) => {
  try {
    const userId = req.user.id;
    let profile = await safelyFetchUserRecord(userId);

    if (!profile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const resetDate = profile?.credits_reset_at ? new Date(profile.credits_reset_at) : null;
    const resetDateMs = resetDate instanceof Date && !Number.isNaN(resetDate.getTime()) ? resetDate.getTime() : 0;
    const diffDays = resetDateMs ? (Date.now() - resetDateMs) / (1000 * 60 * 60 * 24) : Number.POSITIVE_INFINITY;

    if (!hasUnlimitedAccess(profile) && (profile.plan === 'free' || !profile.plan) && diffDays >= 30) {
      profile = await safelyUpdateUserRecord(
        userId,
        {
          credits: 3,
          credits_reset_at: new Date().toISOString(),
        },
        profile
      );
    }

    return res.json(buildUserResponse({
      profile,
      metadata: req.user.metadata || {},
      email: req.user.email,
    }));
  } catch (error) {
    console.error('Erro ao buscar perfil do usuário:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
};

export const updateCurrentUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const currentProfile = await safelyFetchUserRecord(userId);

    if (!currentProfile) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const incomingName = normalizeDisplayName(req.body?.name);
    const removeAvatar = parseBoolean(req.body?.removeAvatar);
    const hasAvatarFile = Boolean(req.file);

    if (!incomingName && !hasAvatarFile && !removeAvatar) {
      return res.status(400).json({ error: 'Nada para atualizar no perfil.' });
    }

    if (!incomingName) {
      return res.status(400).json({ error: 'Informe um nome válido para o perfil.' });
    }

    if (incomingName.length < 2) {
      return res.status(400).json({ error: 'O nome precisa ter pelo menos 2 caracteres.' });
    }

    if (incomingName.length > 80) {
      return res.status(400).json({ error: 'O nome precisa ter no máximo 80 caracteres.' });
    }

    let avatarUrl = getMergedProfileFields({
      profile: currentProfile,
      metadata: req.user.metadata || {},
      email: req.user.email,
    }).avatar_url;

    if (hasAvatarFile) {
      const uploadedAvatar = await uploadRequestFileToStorage(req.file, {
        userId,
        category: 'profiles/avatars',
        prefix: 'avatar',
        fallbackExtension: '.jpg',
      });
      avatarUrl = uploadedAvatar.publicUrl;
    } else if (removeAvatar) {
      avatarUrl = null;
    }

    const nextProfileFields = {
      display_name: incomingName,
      avatar_url: avatarUrl,
    };

    const updatedMetadata = await updateAuthUserMetadata(userId, req.user.metadata || {}, nextProfileFields);
    const updatedProfile = await safelyUpdateUserRecord(userId, nextProfileFields, currentProfile);

    return res.json(buildUserResponse({
      profile: updatedProfile,
      metadata: updatedMetadata,
      email: req.user.email,
    }));
  } catch (error) {
    console.error('Erro ao atualizar perfil do usuário:', error);
    return res.status(500).json({
      error: error?.message || 'Não foi possível atualizar o perfil.',
    });
  }
};

export const consumeCredit = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await safelyFetchUserRecord(userId);

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (hasUnlimitedAccess(user)) {
      return res.json({
        success: true,
        message: 'Plano unlimited - acesso liberado',
        unlimited: true,
      });
    }

    if ((user.credits ?? 0) <= 0) {
      return res.status(403).json({
        error: 'Sem créditos disponíveis',
        code: 'NO_CREDITS',
      });
    }

    await safelyUpdateUserRecord(userId, { credits: Math.max(0, Number(user.credits || 0) - 1) }, user);

    return res.json({
      success: true,
      remaining_credits: Math.max(0, Number(user.credits || 0) - 1),
      unlimited: false,
    });
  } catch (error) {
    console.error('Erro ao consumir crédito:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
