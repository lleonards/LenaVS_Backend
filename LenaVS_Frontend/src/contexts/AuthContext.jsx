import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { hasSupabaseConfig, supabase } from '../services/supabase';
import api from '../services/api';

const AuthContext = createContext(null);
const AUTH_BOOT_TIMEOUT_MS = 5000;

const withTimeout = async (promise, timeoutMs, fallbackValue, timeoutMessage) => {
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      if (timeoutMessage) {
        console.warn(timeoutMessage);
      }
      resolve(fallbackValue);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseDateOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normalizeDisplayName = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const deriveProfileFromSessionUser = (sessionUser) => {
  const metadata = sessionUser?.user_metadata || {};
  const displayName =
    normalizeDisplayName(metadata.display_name)
    || normalizeDisplayName(metadata.full_name)
    || normalizeDisplayName(metadata.name)
    || '';

  const avatarUrl = String(metadata.avatar_url || metadata.picture || metadata.photo_url || '').trim() || null;

  return {
    displayName,
    avatarUrl,
    email: sessionUser?.email || null,
  };
};

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [credits, setCredits] = useState(0);
  const [plan, setPlan] = useState('free');
  const [subscriptionStatus, setSubscriptionStatus] = useState('inactive');
  const [unlimitedUntil, setUnlimitedUntil] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [userEmail, setUserEmail] = useState(null);

  const resetLocalUserState = () => {
    setCredits(0);
    setPlan('free');
    setSubscriptionStatus('inactive');
    setUnlimitedUntil(null);
    setDisplayName('');
    setAvatarUrl(null);
    setUserEmail(null);
  };

  const applyUserSnapshot = (data, fallbackUser = null) => {
    const fallbackProfile = deriveProfileFromSessionUser(fallbackUser);

    setCredits(data?.credits ?? 0);
    setPlan(data?.plan ?? 'free');
    setSubscriptionStatus(data?.subscription_status ?? 'inactive');
    setUnlimitedUntil(data?.unlimited_access_until ?? null);
    setDisplayName(normalizeDisplayName(data?.display_name) || fallbackProfile.displayName || '');
    setAvatarUrl(String(data?.avatar_url || '').trim() || fallbackProfile.avatarUrl || null);
    setUserEmail(data?.email || fallbackProfile.email || null);

    return data ?? null;
  };

  const fetchUserData = async (userId, fallbackUser = session?.user ?? null) => {
    try {
      if (!userId || !hasSupabaseConfig) {
        resetLocalUserState();
        return null;
      }

      try {
        const backendResponse = await withTimeout(
          api.get('/user/me'),
          AUTH_BOOT_TIMEOUT_MS,
          null,
          '⚠️ Timeout ao buscar dados do usuário no backend. Tentando fallback direto no Supabase.'
        );

        if (backendResponse?.data) {
          return applyUserSnapshot(backendResponse.data, fallbackUser);
        }
      } catch (backendError) {
        console.warn('Falha ao sincronizar usuário pelo backend, usando fallback Supabase:', backendError?.response?.data?.error || backendError.message);
      }

      const { data, error } = await withTimeout(
        supabase
          .from('users')
          .select('credits, plan, subscription_status, unlimited_access_until')
          .eq('id', userId)
          .maybeSingle(),
        AUTH_BOOT_TIMEOUT_MS,
        { data: null, error: new Error('Timeout ao buscar dados do usuário.') },
        '⚠️ Timeout ao buscar dados do usuário no Supabase. Seguindo com plano free.'
      );

      if (error) {
        console.warn('Erro ao buscar dados do usuário:', error.message);
        resetLocalUserState();
        return null;
      }

      return applyUserSnapshot(data, fallbackUser);
    } catch (err) {
      console.error('Erro inesperado fetchUserData:', err);
      resetLocalUserState();
      return null;
    }
  };

  const refreshCredits = async () => {
    const userId = session?.user?.id;
    if (!userId) return null;
    return fetchUserData(userId, session?.user ?? null);
  };

  const updateProfile = async ({ displayName: nextDisplayName, avatarFile = null, removeAvatar = false } = {}) => {
    const normalizedDisplayName = normalizeDisplayName(nextDisplayName);

    const formData = new FormData();
    formData.append('name', normalizedDisplayName);

    if (avatarFile) {
      formData.append('avatar', avatarFile);
    }

    if (removeAvatar) {
      formData.append('removeAvatar', 'true');
    }

    const { data } = await api.put('/user/profile', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    applyUserSnapshot(data, session?.user ?? null);
    return data;
  };

  useEffect(() => {
    let isMounted = true;

    const initializeAuth = async () => {
      try {
        if (!hasSupabaseConfig) {
          if (isMounted) {
            setSession(null);
            resetLocalUserState();
          }
          return;
        }

        const { data, error } = await withTimeout(
          supabase.auth.getSession(),
          AUTH_BOOT_TIMEOUT_MS,
          { data: { session: null }, error: new Error('Timeout ao recuperar a sessão.') },
          '⚠️ Timeout ao recuperar sessão do Supabase. Liberando a interface para evitar tela infinita de carregamento.'
        );

        if (error) {
          console.error('Erro getSession:', error.message);
        }

        const currentSession = data?.session ?? null;

        if (!isMounted) return;

        setSession(currentSession);

        if (currentSession?.user) {
          await fetchUserData(currentSession.user.id, currentSession.user);
        } else {
          resetLocalUserState();
        }
      } catch (err) {
        console.error('Erro inesperado initializeAuth:', err);
        if (isMounted) {
          setSession(null);
          resetLocalUserState();
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    initializeAuth();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!isMounted) return;

      setSession(newSession ?? null);

      if (newSession?.user) {
        const fallbackProfile = deriveProfileFromSessionUser(newSession.user);
        setDisplayName(fallbackProfile.displayName || '');
        setAvatarUrl(fallbackProfile.avatarUrl || null);
        setUserEmail(fallbackProfile.email || null);
        void fetchUserData(newSession.user.id, newSession.user);
      } else {
        resetLocalUserState();
      }
    });

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && session?.user?.id) {
        void fetchUserData(session.user.id, session.user);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      isMounted = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      listener?.subscription?.unsubscribe?.();
    };
  }, [session?.user?.id]);

  const signUp = async (email, password, name, countryCode = 'BR', acceptedLegal = false) => {
    const normalizedName = String(name || '').trim();
    const normalizedCountryCode = String(countryCode || 'BR').trim().toUpperCase();
    const normalizedCountryGroup = normalizedCountryCode === 'BR' ? 'BR' : 'INTL';
    const preferredCurrency = normalizedCountryGroup === 'BR' ? 'BRL' : 'USD';
    const countryLabelMap = {
      BR: 'Brasil',
      US: 'Estados Unidos',
      CA: 'Canadá',
      AU: 'Austrália',
      NZ: 'Nova Zelândia',
      SG: 'Singapura',
      HK: 'Hong Kong',
      OTHER: 'Outros',
    };
    const selectedCountryLabel = countryLabelMap[normalizedCountryCode] || 'Outros';

    if (!acceptedLegal) {
      throw new Error('Você precisa aceitar os termos de uso e a política de privacidade para criar a conta.');
    }

    const acceptedAt = new Date().toISOString();

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name: normalizedName,
          full_name: normalizedName,
          display_name: normalizedName,
          country_group: normalizedCountryGroup,
          country: normalizedCountryCode,
          country_code: normalizedCountryCode,
          country_label: selectedCountryLabel,
          preferred_currency: preferredCurrency,
          accepted_legal_terms: true,
          legal_acceptance_at: acceptedAt,
          privacy_policy_version: '2026-06',
        },
      },
    });

    if (error) throw error;

    return { emailConfirmationRequired: true, message: 'Verifique seu e-mail para confirmar sua conta antes de fazer login.' };
  };

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    resetLocalUserState();
  };

  const hasUnlimitedAccess = useMemo(() => {
    const untilDate = parseDateOrNull(unlimitedUntil);
    if (untilDate) {
      return untilDate.getTime() > Date.now();
    }
    return plan === 'pro' && subscriptionStatus === 'active';
  }, [plan, subscriptionStatus, unlimitedUntil]);

  const creditsLabel = hasUnlimitedAccess ? 'unlimited' : Math.max(0, Number(credits) || 0);

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        isAuthenticated: !!session,
        loading,
        credits,
        creditsLabel,
        plan,
        subscriptionStatus,
        unlimitedUntil,
        hasUnlimitedAccess,
        displayName,
        avatarUrl,
        userEmail,
        signUp,
        signIn,
        signOut,
        refreshCredits,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
