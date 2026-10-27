/**
 * Short, readable names for the line items providers bill under.
 *
 * OpenAI reports usage per model snapshot and per usage type, so one model
 * arrives as several raw rows — "gpt-realtime-2025-08-28 audio, output",
 * "gpt-realtime-2025-08-28 text, input", and so on. On a WhatsApp line those
 * read as noise and split one model's cost into pieces too small to rank.
 * shortServiceName turns each into the model's name ("GPT Realtime"), so rows
 * of the same model can be added together.
 *
 * AWS bills under long names ("Amazon Elastic Compute Cloud - Compute"); the
 * common ones get the short form people actually say ("Amazon EC2").
 *
 * Anything else is returned exactly as given.
 */

/** Cost Explorer's long service names → the short form. */
const AWS_SHORT: Record<string, string> = {
  'Amazon Elastic Compute Cloud - Compute': 'Amazon EC2',
  'Amazon Elastic Compute Cloud': 'Amazon EC2',
  'Amazon Simple Storage Service': 'Amazon S3',
  'Amazon Relational Database Service': 'Amazon RDS',
  'Amazon Elastic Container Service': 'Amazon ECS',
  'Amazon Elastic Container Service for Kubernetes': 'Amazon EKS',
  'Amazon Elastic Kubernetes Service': 'Amazon EKS',
  'Amazon EC2 Container Registry (ECR)': 'Amazon ECR',
  'Amazon Elastic Container Registry Public': 'Amazon ECR Public',
  'Amazon Elastic File System': 'Amazon EFS',
  'Amazon Elastic Block Store': 'Amazon EBS',
  'Amazon Elastic Load Balancing': 'Amazon ELB',
  'Amazon Elastic MapReduce': 'Amazon EMR',
  'Amazon Simple Email Service': 'Amazon SES',
  'Amazon Simple Notification Service': 'Amazon SNS',
  'Amazon Simple Queue Service': 'Amazon SQS',
  'Amazon Simple Workflow Service': 'Amazon SWF',
  'Amazon Virtual Private Cloud': 'Amazon VPC',
  'Amazon DocumentDB (with MongoDB compatibility)': 'Amazon DocumentDB',
  'AWS Key Management Service': 'AWS KMS',
  'AWS Identity and Access Management': 'AWS IAM',
  'AWS Database Migration Service': 'AWS DMS',
};

/** Short provider names for a one-line label: "OpenAI: GPT Image 2". */
const PROVIDER_SHORT: Record<string, string> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'Google Cloud',
  alibaba: 'Alibaba Cloud',
  huawei: 'Huawei Cloud',
  openai: 'OpenAI',
  whatsapp: 'WhatsApp',
};

/** "OpenAI: GPT Image 2", "AWS: Amazon EC2"; just the short name if the provider is unknown. */
export function serviceLabel(provider: string | undefined, name: string): string {
  const short = shortServiceName(name);
  if (!provider) return short;
  return `${PROVIDER_SHORT[provider] ?? provider}: ${short}`;
}

/** "<model>" optionally followed by " <modality>, [cached ]input|output". */
const OPENAI_ROW = /^([a-z0-9][a-z0-9.-]*)(?: [a-z]+, (?:cached )?(?:input|output))?$/;
const OPENAI_MODEL = /^(gpt|chatgpt|whisper|dall-e|tts|text-embedding|omni-moderation|o\d)/;
/** Snapshot dates: "-2025-08-28" (also the older "-0613" style). */
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

/** Words OpenAI writes in capitals, or keeps lower-case after the model name. */
const WORDS: Record<string, string> = {
  tts: 'TTS', hd: 'HD', mini: 'mini', nano: 'nano', e: 'E',
};

export function shortServiceName(name: string): string {
  if (AWS_SHORT[name]) return AWS_SHORT[name];
  const m = OPENAI_ROW.exec(name ?? '');
  if (!m || !OPENAI_MODEL.test(m[1])) return name;

  const parts = m[1].replace(SNAPSHOT, '').split('-').filter(Boolean);
  let head: string;
  if (parts[0] === 'gpt' && /^\d/.test(parts[1] ?? '')) {
    // "gpt-4o-mini" → "GPT-4o mini": the version belongs to the name.
    head = `GPT-${parts[1]}`;
    parts.splice(0, 2);
  } else if (parts[0] === 'gpt' || parts[0] === 'chatgpt' || parts[0] === 'dall') {
    head = ({ gpt: 'GPT', chatgpt: 'ChatGPT', dall: 'DALL' } as Record<string, string>)[parts.shift()!];
    // "dall-e-3" → "DALL-E 3".
    const next: string | undefined = parts[0];
    if (head === 'DALL' && next === 'e') { head = 'DALL-E'; parts.shift(); }
  } else if (/^o\d/.test(parts[0])) {
    // The o-series are written lower-case: "o3 mini".
    head = parts.shift()!;
  } else {
    head = '';
  }

  const rest = parts.map((w) => WORDS[w] ?? (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
  return [head, ...rest].filter(Boolean).join(' ');
}
