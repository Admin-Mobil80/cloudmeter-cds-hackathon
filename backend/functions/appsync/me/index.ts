import type { AppSyncResolverHandler, AppSyncIdentityCognito } from 'aws-lambda';
import { getMembershipForUser } from '../../shared/membership';

interface MeResult {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
  status: string;
  tenantCreatedAt: string | null;
}

export const handler: AppSyncResolverHandler<Record<string, never>, MeResult | null> = async (event) => {
  const identity = event.identity as AppSyncIdentityCognito;
  const userId = identity.sub;
  const email = (identity.claims?.email as string) ?? '';

  const membership = await getMembershipForUser(userId);
  if (!membership) return null;

  return { userId, email, ...membership };
};
