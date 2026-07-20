import axios from 'axios';
import { supabase } from './supabase';
import { goToAppRoute } from '../utils/appPath';

const DEFAULT_PRODUCTION_API_URL = 'https://lenavs-backend-1-gv24.onrender.com';
const API_ROUTE_PROBE_PATH = '/api/legal/privacy-policy';
const HEALTH_PROBE_PATH = '/health';
const RUNTIME_OVERRIDE_KEY = 'LENAVS_API_URL';

const normalizeBase = (value) => String(value || '').trim().replace(/\/+$/, '');

const isLocalHostname = (hostname = '') => /^(localhost|127\.0\.0\.1)$/i.test(String(hostname || '').trim());

const getRuntimeOverrideBase = () => {
  const browserOverride = typeof window !== 'undefined'
    ? normalizeBase(window.__LENAVS_API_URL__)
    : '';

  if (browserOverride) {
    return browserOverride;
  }

  const storageOverride = typeof window !== 'undefined'
    ? normalizeBase(window.localStorage?.getItem(RUNTIME_OVERRIDE_KEY))
    : '';

  return storageOverride;
};

const buildCandidateBases = () => {
  const candidates = [];
  const push = (value) => {
    const normalized = normalizeBase(value);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  push(getRuntimeOverrideBase());
  push(import.meta.env.VITE_API_URL);

  if (typeof window !== 'undefined') {
    const { origin, hostname, protocol } = window.location;

    if (isLocalHostname(hostname)) {
      push('http://localhost:10000');
    } else {
      push(origin);

      if (/onrender\.com$/i.test(hostname)) {
        push(`${protocol}//${hostname.replace(/frontend/gi, 'backend')}`);
      }
    }
  }

  if (import.meta.env.MODE === 'production') {
    push(DEFAULT_PRODUCTION_API_URL);
  } else {
    push('http://localhost:10000');
  }

  return candidates;
};

const probeBase = async (base) => {
  const normalized = normalizeBase(base);
  if (!normalized || typeof fetch === 'undefined') {
    return false;
  }

  const tryFetch = async (url) => {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    });

    return response.ok;
  };

  try {
    if (await tryFetch(`${normalized}${API_ROUTE_PROBE_PATH}`)) {
      return true;
    }
  } catch {
    // tenta fallback abaixo
  }

  try {
    return await tryFetch(`${normalized}${HEALTH_PROBE_PATH}`);
  } catch {
    return false;
  }
};

let activeBase = normalizeBase(getRuntimeOverrideBase())
  || normalizeBase(import.meta.env.VITE_API_URL)
  || normalizeBase(import.meta.env.MODE === 'production' ? DEFAULT_PRODUCTION_API_URL : 'http://localhost:10000');

let baseResolutionPromise = null;

const setActiveBase = (base) => {
  const normalized = normalizeBase(base);
  if (normalized) {
    activeBase = normalized;

    if (typeof window !== 'undefined') {
      window.localStorage?.setItem(RUNTIME_OVERRIDE_KEY, normalized);
    }
  }

  return activeBase;
};

const resolveApiBase = async ({ force = false } = {}) => {
  if (baseResolutionPromise && !force) {
    return baseResolutionPromise;
  }

  baseResolutionPromise = (async () => {
    const candidates = buildCandidateBases();

    if (!force && activeBase) {
      candidates.unshift(activeBase);
    }

    const uniqueCandidates = [...new Set(candidates.map(normalizeBase).filter(Boolean))];

    for (const candidate of uniqueCandidates) {
      if (await probeBase(candidate)) {
        return setActiveBase(candidate);
      }
    }

    return activeBase;
  })();

  try {
    return await baseResolutionPromise;
  } finally {
    baseResolutionPromise = null;
  }
};

const buildApiUrl = (base) => `${normalizeBase(base)}/api`;

const api = axios.create({
  baseURL: buildApiUrl(activeBase),
  withCredentials: false,
  timeout: 900000,
});

api.interceptors.request.use(
  async (config) => {
    try {
      const resolvedBase = await resolveApiBase();
      config.baseURL = buildApiUrl(resolvedBase);

      const { data } = await supabase.auth.getSession();
      const session = data?.session;

      if (session?.access_token) {
        config.headers = {
          ...config.headers,
          Authorization: `Bearer ${session.access_token}`,
        };
      }

      return config;
    } catch (error) {
      console.error('Erro ao preparar requisição da API:', error);
      return config;
    }
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response?.status;
    const message = String(error.response?.data?.error || '').toLowerCase();
    const originalConfig = error.config || {};

    const shouldRetryWithAnotherBase = (
      status === 404
      && !originalConfig.__retriedWithResolvedBase
      && typeof window !== 'undefined'
    );

    if (shouldRetryWithAnotherBase) {
      try {
        const fallbackBase = await resolveApiBase({ force: true });
        if (fallbackBase && buildApiUrl(fallbackBase) !== originalConfig.baseURL) {
          originalConfig.__retriedWithResolvedBase = true;
          originalConfig.baseURL = buildApiUrl(fallbackBase);
          return api.request(originalConfig);
        }
      } catch (resolutionError) {
        console.warn('Não foi possível resolver uma nova base da API após 404:', resolutionError);
      }
    }

    const shouldForceLogout =
      status === 401 ||
      (status === 403 && (
        message.includes('sessão inválida') ||
        message.includes('sessao invalida') ||
        message.includes('token inválido') ||
        message.includes('token invalido') ||
        message.includes('expirada')
      ));

    if (shouldForceLogout) {
      console.warn('Sessão inválida ou expirada. Limpando sessão...');
      await supabase.auth.signOut();
      localStorage.clear();
      sessionStorage.clear();
      goToAppRoute('/login');
    }

    return Promise.reject(error);
  }
);

export const getApiBaseUrl = async () => resolveApiBase();

export default api;
