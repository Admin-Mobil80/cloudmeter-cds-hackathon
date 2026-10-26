import type { ProviderAdapter } from './types';
import { awsAdapter } from './aws';
import { azureAdapter } from './azure';
import { gcpAdapter } from './gcp';
import { alibabaAdapter } from './alibaba';
import { huaweiAdapter } from './huawei';
import { openaiAdapter } from './openai';
import { whatsappAdapter } from './whatsapp';
import { adhocAdapter } from './adhoc';

const ADAPTERS: ProviderAdapter[] = [
  awsAdapter,
  azureAdapter,
  gcpAdapter,
  alibabaAdapter,
  huaweiAdapter,
  openaiAdapter,
  whatsappAdapter,
  adhocAdapter,
];

export const PROVIDER_KEYS = ADAPTERS.map((a) => a.key);

export function getAdapter(key: string): ProviderAdapter | null {
  return ADAPTERS.find((a) => a.key === key) ?? null;
}

/** Credential-field metadata for the connect UI — never includes any values. */
export function describeProviders() {
  return ADAPTERS.map((a) => ({
    key: a.key,
    displayName: a.displayName,
    verified: a.verified,
    credentialFields: a.credentialFields,
  }));
}

export * from './types';
