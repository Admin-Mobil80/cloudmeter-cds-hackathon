import { shortServiceName, serviceLabel } from '../functions/shared/service-names';
import { servicesLine, digestBodyValues, listedServiceValues, serviceMoney } from '../functions/shared/digest-whatsapp';
import type { Digest } from '../functions/shared/digest';

describe('shortServiceName', () => {
  it.each([
    ['gpt-image-2-2026-04-21 image, output', 'GPT Image 2'],
    ['gpt-4o-mini-tts-2025-12-15 audio, output', 'GPT-4o mini TTS'],
    ['gpt-realtime-2025-08-28 text, cached input', 'GPT Realtime'],
    ['gpt-realtime-2.1-mini audio, output', 'GPT Realtime 2.1 mini'],
    ['gpt-4o-transcribe audio, input', 'GPT-4o Transcribe'],
    ['gpt-4-0613', 'GPT-4'],
    ['whisper', 'Whisper'],
    ['dall-e-3', 'DALL-E 3'],
    ['o3-mini', 'o3 mini'],
    ['tts-1-hd', 'TTS 1 HD'],
  ])('%s → %s', (raw, short) => {
    expect(shortServiceName(raw)).toBe(short);
  });

  it.each([
    ['Amazon Elastic Compute Cloud - Compute', 'Amazon EC2'],
    ['Amazon Simple Storage Service', 'Amazon S3'],
    ['AWS Key Management Service', 'AWS KMS'],
  ])('shortens AWS %s → %s', (raw, short) => {
    expect(shortServiceName(raw)).toBe(short);
  });

  it.each([
    'AWS Lambda',
    'EC2 - Other',
    'Gemini API',
    'Utility',
    'Tax',
  ])('leaves %s alone', (name) => {
    expect(shortServiceName(name)).toBe(name);
  });
});

describe('serviceLabel', () => {
  it('puts the provider in front of the short name', () => {
    expect(serviceLabel('openai', 'gpt-image-2-2026-04-21 image, output')).toBe('OpenAI: GPT Image 2');
    expect(serviceLabel('aws', 'Amazon Elastic Compute Cloud - Compute')).toBe('AWS: Amazon EC2');
    expect(serviceLabel('gcp', 'Cloud Storage')).toBe('Google Cloud: Cloud Storage');
  });

  it('falls back to the provider id, or to the name alone', () => {
    expect(serviceLabel('newcloud', 'Compute')).toBe('newcloud: Compute');
    expect(serviceLabel(undefined, 'whisper')).toBe('Whisper');
  });
});

describe('servicesLine', () => {
  const digest = (services: Array<[string, string, number]>) => ({
    services: services.map(([provider, service, daySpend]) => ({ provider, service, daySpend, monthToDate: daySpend })),
    currency: { code: 'USD', symbol: '$', rate: 1 },
  }) as unknown as Digest;

  it('adds up the usage types of one model before ranking', () => {
    const line = servicesLine(digest([
      ['aws', 'Amazon Elastic Compute Cloud - Compute', 30],
      ['openai', 'gpt-realtime-2025-08-28 audio, output', 20],
      ['openai', 'gpt-realtime-2025-08-28 audio, input', 15],
      ['openai', 'gpt-realtime-2025-08-28 text, input', 5],
      ['openai', 'whisper', 1],
    ]));
    expect(line).toBe('OpenAI: GPT Realtime $40 · AWS: Amazon EC2 $30 · OpenAI: Whisper $1');
  });

  it('keeps the same name under two providers apart', () => {
    const line = servicesLine(digest([['aws', 'Storage', 5], ['azure', 'Storage', 4]]));
    expect(line).toBe('AWS: Storage $5 · Azure: Storage $4');
  });

  it('counts "+N more" after merging', () => {
    const line = servicesLine(digest([
      ['aws', 'a', 6], ['aws', 'b', 5], ['aws', 'c', 4],
      ['openai', 'gpt-image-2 image, output', 4], ['openai', 'gpt-image-2 text, input', 3],
    ]), 2);
    expect(line).toBe('OpenAI: GPT Image 2 $7 · AWS: a $6 · +2 more');
  });
});

describe('digestBodyValues', () => {
  const d = {
    tenantName: 'Mobil80',
    dayKey: '2026-10-24',
    dayLabel: '24 Oct 2026',
    daySpend: 100,
    monthToDate: 2000,
    monthDeltaPct: 12,
    movers: [{ provider: 'openai', service: 'gpt-image-2 image, output', accountName: 'x', spend: 9, baseline: 2, delta: 7 }],
    services: [{ provider: 'aws', service: 'Amazon Simple Storage Service', daySpend: 3, monthToDate: 3 }],
    currency: { code: 'USD', symbol: '$', rate: 1 },
  } as unknown as Digest;

  it('sends five values for the original template', () => {
    expect(digestBodyValues(d, 'cloudmeter_daily_digest')).toHaveLength(5);
  });

  it('adds the services line for v2', () => {
    const v = digestBodyValues(d, 'cloudmeter_daily_digest_v2');
    expect(v).toHaveLength(6);
    expect(v[5]).toBe('AWS: Amazon S3 $3');
  });

  it('adds the short day, then the services line, for v3', () => {
    const v = digestBodyValues(d, 'cloudmeter_daily_digest_v3');
    expect(v).toHaveLength(7);
    expect(v[4]).toBe('OpenAI: GPT Image 2, up $7');
    expect(v[5]).toBe('24 Oct');
    expect(v[6]).toBe('AWS: Amazon S3 $3');
  });
});

describe('v5: one service per line', () => {
  const base = {
    tenantName: 'WONKA', dayKey: '2026-10-25', dayLabel: '25 Oct 2026', daySpend: 6, monthToDate: 142,
    monthDeltaPct: -1, movers: [], currency: { code: 'USD', symbol: '$', rate: 1 },
  };
  const make = (services: Array<[string, number]>) => ({
    ...base,
    services: services.map(([service, daySpend]) => ({ provider: 'aws', service, daySpend, monthToDate: daySpend })),
  }) as unknown as Digest;

  it('sends ten values: the day, three services, then the rest', () => {
    const v = digestBodyValues(make([
      ['EC2 - Other', 1.24], ['Amazon Elastic Compute Cloud - Compute', 0.98],
      ['Amazon Simple Storage Service', 0.61], ['AWS Lambda', 0.2], ['AWS Key Management Service', 0.1],
    ]), 'cloudmeter_daily_digest_v5');
    expect(v).toHaveLength(10);
    expect(v.slice(5)).toEqual([
      '25 Oct',
      'AWS: EC2 - Other $1.24',
      'AWS: Amazon EC2 $0.98',
      'AWS: Amazon S3 $0.61',
      '+2 more in the dashboard',
    ]);
  });

  it('fills empty lines with a dash and says there are no others', () => {
    expect(listedServiceValues(make([['AWS Lambda', 12.4]]))).toEqual(['AWS: AWS Lambda $12', '—', '—', 'No other services']);
  });

  it('says so when no service had a cost', () => {
    expect(listedServiceValues(make([]))).toEqual(['—', '—', '—', 'No service cost reported that day']);
  });
});

describe('serviceMoney', () => {
  const usd = { code: 'USD', symbol: '$', rate: 1 } as unknown as Digest['currency'];
  const inr = { code: 'INR', symbol: '₹', rate: 88 } as unknown as Digest['currency'];
  it.each([
    [0.61, usd, '$0.61'],
    [9.994, usd, '$9.99'],
    [12.4, usd, '$12'],
    [0.004, usd, 'under $0.01'],
    [0.05, inr, '₹4.40'],
    [2, inr, '₹176'],
  ])('%s → %s', (n, c, out) => {
    expect(serviceMoney(n as number, c as Digest['currency'])).toBe(out);
  });
});
