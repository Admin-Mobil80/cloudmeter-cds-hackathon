/**
 * How a name someone types on WhatsApp is matched against cloud bill names.
 *
 * Providers bill under long official names: S3 is "Amazon Simple Storage
 * Service", EC2 "Amazon Elastic Compute Cloud - Compute". Nobody types those, so
 * a plain substring search for "s3" finds nothing — which is how "cost s3" was
 * answered with "no account named s3". Short names are expanded here, and the
 * words around a name in a question ("what's the cost of …") are dropped.
 */

export const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Common short names → fragments of the billed name (normalised). From real bill names. */
const ALIASES: Record<string, string[]> = {
  s3: ['simplestorageservice'],
  ec2: ['elasticcomputecloud', 'ec2'],
  rds: ['relationaldatabaseservice'],
  sqs: ['simplequeueservice'],
  ses: ['simpleemailservice'],
  sns: ['simplenotificationservice'],
  ecr: ['containerregistry'],
  ecs: ['elasticcontainerservice', 'elasticcloudserver'],
  eks: ['elastickubernetes'],
  ebs: ['elasticblockstore', 'elasticvolumeservice'],
  efs: ['elasticfilesystem'],
  elb: ['elasticloadbalanc', 'loadbalanc'],
  alb: ['elasticloadbalanc', 'loadbalanc'],
  vpc: ['virtualprivatecloud'],
  kms: ['keymanagementservice'],
  waf: ['waf', 'webapplicationfirewall'],
  cdn: ['cloudfront', 'contentdeliverynetwork'],
  dns: ['route53'],
  email: ['simpleemailservice'],
  whatsapp: ['endusermessaging'],
  vm: ['virtualmachines'],
  vms: ['virtualmachines'],
  blob: ['storage'],
  gcs: ['cloudstorage'],
  gce: ['computeengine'],
  bq: ['bigquery'],
  obs: ['objectstorageservice'],
  oss: ['objectstorageservice'],
  openai: ['gpt'],
};

/** Words that surround a name in a question rather than being part of it. */
const FILLER = new Set([
  'what', 'whats', 'what\'s', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'has', 'have', 'had', 'it', 'its',
  'to', 'at', 'by', 'from', 'with', 'about', 'check', 'get', 'find', 'the', 'a', 'an', 'of', 'for', 'on', 'in', 'my', 'our', 'we', 'us',
  'how', 'much', 'show', 'me', 'tell', 'give', 'total', 'cost', 'costs', 'costing', 'spend', 'spent', 'spending',
  'bill', 'billing', 'charges', 'this', 'month', 'so', 'far', 'please', 'service', 'services', 'account', 'accounts',
  'amazon', 'aws',
]);

/** The part of a typed phrase that names something: "What's the cost s3" → "s3". */
export function cleanQuery(raw: string): string {
  const words = raw.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  return norm((kept.length ? kept : words).join(' '));
}

/**
 * A predicate for "does this billed name match what was typed?". Matches
 * either way round (so "lambda" finds "AWS Lambda" and "Acme Technologies"
 * finds "Acme"), and expands short names.
 */
export function nameMatcher(raw: string): (label: string) => boolean {
  const q = cleanQuery(raw);
  if (!q) return () => false;
  const aliases = ALIASES[q];
  return (label: string) => {
    const n = norm(label);
    if (!n) return false;
    // The short name as a whole word ("EC2 - Other"), never as letters inside
    // another word — "ses" is in "databaSE Service".
    const words = label.toLowerCase().split(/[^a-z0-9]+/);
    if (words.includes(q)) return true;
    if (aliases) return aliases.some((f) => n.includes(f));
    if (q.length < 3) return false;
    return n.includes(q) || (n.length >= 3 && q.includes(n));
  };
}
