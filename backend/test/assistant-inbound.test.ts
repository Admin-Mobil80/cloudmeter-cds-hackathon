/**
 * The WhatsApp assistant must never answer its own messages.
 *
 * AWS End User Messaging Social sends status updates for every message we send
 * (sent, delivered, read) to the same SNS topic as customers' messages. If one
 * of those were mistaken for a question, each reply would produce a receipt,
 * the receipt another reply, and so on — billed on every pass. extractInbound
 * is the gate: only genuine customer messages to our number get through.
 */
import { extractInbound } from '../functions/assistant/inbound';

// As CloudMeter stores it (bin/infra.ts) — and as the event's ARN spells it.
const OUR_PHONE_ID = 'phone-number-id-fff203cf061549b79b6b5b950addfbf4';
const OUR_PHONE_ARN = 'arn:aws:social-messaging:us-east-1:111122223333:phone-number-id/fff203cf061549b79b6b5b950addfbf4';
const OUR_NUMBER = '918105823737';

function event(value: object, phoneArn = OUR_PHONE_ARN) {
  return JSON.stringify({
    context: { MetaPhoneNumberIds: [{ metaPhoneNumberId: 'x', arn: phoneArn }] },
    whatsAppWebhookEntry: JSON.stringify({
      id: 'waba',
      changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: OUR_NUMBER }, ...value } }],
    }),
  });
}

const customerText = {
  contacts: [{ wa_id: '919900000001', profile: { name: 'Neeta' } }],
  messages: [{ id: 'wamid.1', from: '919900000001', type: 'text', text: { body: '  How much this month? ' } }],
};

describe('extractInbound', () => {
  it('passes a customer text message through', () => {
    expect(extractInbound(event(customerText), OUR_PHONE_ID)).toEqual([
      { id: 'wamid.1', from: '919900000001', type: 'text', text: 'How much this month?', profileName: 'Neeta' },
    ]);
  });

  it('ignores delivery receipts for our own replies', () => {
    const receipts = { statuses: [{ id: 'wamid.reply', status: 'delivered', recipient_id: '919900000001' }] };
    expect(extractInbound(event(receipts), OUR_PHONE_ID)).toEqual([]);
  });

  it('ignores anything sent from our own number', () => {
    const own = { messages: [{ id: 'wamid.2', from: OUR_NUMBER, type: 'text', text: { body: 'hi' } }] };
    expect(extractInbound(event(own), OUR_PHONE_ID)).toEqual([]);
  });

  it('ignores events for a different phone number', () => {
    const other = event(customerText, 'arn:aws:social-messaging:us-east-1:111122223333:phone-number-id/0123456789abcdef');
    expect(extractInbound(other, OUR_PHONE_ID)).toEqual([]);
  });

  it('passes non-text messages through without text, so they get the text-only reply', () => {
    const image = { messages: [{ id: 'wamid.3', from: '919900000001', type: 'image' }] };
    expect(extractInbound(event(image), OUR_PHONE_ID)).toEqual([
      { id: 'wamid.3', from: '919900000001', type: 'image', text: null, profileName: null },
    ]);
  });

  it('survives malformed input', () => {
    expect(extractInbound('not json', OUR_PHONE_ID)).toEqual([]);
    expect(extractInbound(JSON.stringify({ context: {}, whatsAppWebhookEntry: '{' }), OUR_PHONE_ID)).toEqual([]);
  });
});
