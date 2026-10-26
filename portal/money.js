// ---- money ----------------------------------------------------------
//
// Every figure CloudMeter stores is USD — that is what makes six providers
// addable — so display currency is applied here, at the point of rendering,
// and nowhere else. One helper rather than a formatter per page: the failure
// worth avoiding is a screen showing one card in rupees and the next in
// dollars, which is worse than showing everything in dollars.
//
// The rate arrives on /me, so it is available to every page as soon as
// auth-guard has run.

/** USD -> the tenant's display currency. Falls back to USD until /me lands. */
function CM_money(usd, opts) {
  const c = (window.CM_ME && window.CM_ME.currency) || { symbol: '$', rate: 1, code: 'USD' };
  const value = (Number(usd) || 0) * (c.rate || 1);
  const decimals = opts && opts.decimals !== undefined
    ? opts.decimals
    : (Math.abs(value) >= 100 ? 0 : 2);
  const locale = c.code === 'INR' ? 'en-IN' : 'en-US';
  return c.symbol + value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Just the converted number, for callers doing their own formatting. */
function CM_amount(usd) {
  const c = (window.CM_ME && window.CM_ME.currency) || { rate: 1 };
  return (Number(usd) || 0) * (c.rate || 1);
}

function CM_currencySymbol() {
  const c = (window.CM_ME && window.CM_ME.currency) || { symbol: '$' };
  return c.symbol;
}

// CloudMeter — cost trend chart. Plots only real ingested cost data; when
// there's nothing to plot it says so rather than drawing a placeholder curve.

const TREND_PROVIDER_META = {
  aws: { name: 'AWS', hex: '#2a78d6' },
  azure: { name: 'Azure', hex: '#eb6834' },
  gcp: { name: 'GCP', hex: '#1baf7a' },
  alibaba: { name: 'Alibaba Cloud', hex: '#eda100' },
  huawei: { name: 'Huawei Cloud', hex: '#e87ba4' },
  openai: { name: 'OpenAI', hex: '#10a37f' },
  whatsapp: { name: 'WhatsApp Business', hex: '#25d366' },
};
