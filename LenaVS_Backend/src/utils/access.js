const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const UNLIMITED_ACCESS_DAYS = 30;

export const parseDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const isFutureDate = (value) => {
  const date = parseDateOrNull(value);
  return Boolean(date && date.getTime() > Date.now());
};

export const hasUnlimitedAccess = (user = {}) => {
  const unlimitedUntil = parseDateOrNull(user?.unlimited_access_until);

  if (unlimitedUntil) {
    return unlimitedUntil.getTime() > Date.now();
  }

  return user?.plan === 'pro' && user?.subscription_status === 'active';
};

export const getCreditsRemainingLabel = (user = {}) => (
  hasUnlimitedAccess(user) ? 'unlimited' : Math.max(0, Number(user?.credits) || 0)
);

export const calculateExtendedUnlimitedAccessUntil = (currentValue, days = UNLIMITED_ACCESS_DAYS) => {
  const now = Date.now();
  const current = parseDateOrNull(currentValue);
  const baseTime = current && current.getTime() > now ? current.getTime() : now;
  return new Date(baseTime + (days * MS_PER_DAY));
};

export const buildAccessSnapshot = (user = {}) => {
  const unlimitedUntil = parseDateOrNull(user?.unlimited_access_until);
  const unlimited = hasUnlimitedAccess(user);

  return {
    unlimited,
    unlimited_access_until: unlimitedUntil ? unlimitedUntil.toISOString() : null,
    plan: unlimited ? 'pro' : (user?.plan || 'free'),
    subscription_status: unlimited
      ? (user?.subscription_status || 'active')
      : (user?.subscription_status || 'inactive'),
    credits_remaining: getCreditsRemainingLabel(user),
  };
};
