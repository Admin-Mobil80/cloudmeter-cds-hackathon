/**
 * Matching what people type on WhatsApp against names on cloud bills.
 *
 * "cost s3" was answered with "no account named s3": the bill calls it
 * "Amazon Simple Storage Service", and the search was a plain substring match
 * on the whole phrase. These use real billed names from production.
 */
import { cleanQuery, nameMatcher } from '../functions/assistant/names';

const BILL = [
  'Amazon Simple Storage Service',
  'Amazon Elastic Compute Cloud - Compute',
  'EC2 - Other',
  'Amazon Relational Database Service',
  'AWS Lambda',
  'Amazon Simple Email Service',
  'AmazonCloudWatch',
  'Amazon EC2 Container Registry (ECR)',
  'Virtual Machines',
  'gpt-4o-mini-transcribe-2025-12-15 audio, input',
];
const find = (q: string) => BILL.filter(nameMatcher(q));

describe('cleanQuery', () => {
  it('keeps the name and drops the question around it', () => {
    expect(cleanQuery("What's the cost s3")).toBe('s3');
    expect(cleanQuery('how much did we spend on lambda this month')).toBe('lambda');
    expect(cleanQuery('Cyberdyne account')).toBe('cyberdyne');
  });
});

describe('nameMatcher', () => {
  it('expands short names to billed names', () => {
    expect(find('cost s3')).toEqual(['Amazon Simple Storage Service']);
    expect(find('ec2')).toEqual(['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other', 'Amazon EC2 Container Registry (ECR)']);
    expect(find('rds')).toEqual(['Amazon Relational Database Service']);
    expect(find('ses')).toEqual(['Amazon Simple Email Service']);
    expect(find('vms')).toEqual(['Virtual Machines']);
  });

  it('still matches plain words inside billed names', () => {
    expect(find('lambda')).toEqual(['AWS Lambda']);
    expect(find('cloudwatch')).toEqual(['AmazonCloudWatch']);
    expect(find('transcribe')).toEqual(['gpt-4o-mini-transcribe-2025-12-15 audio, input']);
  });

  it('matches nothing for an unknown name', () => {
    expect(find('kubernetes')).toEqual([]);
  });
});
