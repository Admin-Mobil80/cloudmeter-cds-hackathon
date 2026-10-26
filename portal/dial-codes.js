// CloudMeter — international dialling codes, and a best guess at which one a
// given user wants.
//
// The guess matters more than the list: almost everyone is entering their own
// number, in their own country, so a correct default means they type digits and
// nothing else. Getting it wrong is cheap — the field is a normal dropdown.

const CM_DIAL_CODES = [
  { iso: 'AF', name: 'Afghanistan', dial: '+93' },
  { iso: 'AL', name: 'Albania', dial: '+355' },
  { iso: 'DZ', name: 'Algeria', dial: '+213' },
  { iso: 'AR', name: 'Argentina', dial: '+54' },
  { iso: 'AM', name: 'Armenia', dial: '+374' },
  { iso: 'AU', name: 'Australia', dial: '+61' },
  { iso: 'AT', name: 'Austria', dial: '+43' },
  { iso: 'AZ', name: 'Azerbaijan', dial: '+994' },
  { iso: 'BH', name: 'Bahrain', dial: '+973' },
  { iso: 'BD', name: 'Bangladesh', dial: '+880' },
  { iso: 'BY', name: 'Belarus', dial: '+375' },
  { iso: 'BE', name: 'Belgium', dial: '+32' },
  { iso: 'BO', name: 'Bolivia', dial: '+591' },
  { iso: 'BA', name: 'Bosnia and Herzegovina', dial: '+387' },
  { iso: 'BW', name: 'Botswana', dial: '+267' },
  { iso: 'BR', name: 'Brazil', dial: '+55' },
  { iso: 'BG', name: 'Bulgaria', dial: '+359' },
  { iso: 'KH', name: 'Cambodia', dial: '+855' },
  { iso: 'CM', name: 'Cameroon', dial: '+237' },
  { iso: 'CA', name: 'Canada', dial: '+1' },
  { iso: 'CL', name: 'Chile', dial: '+56' },
  { iso: 'CN', name: 'China', dial: '+86' },
  { iso: 'CO', name: 'Colombia', dial: '+57' },
  { iso: 'CR', name: 'Costa Rica', dial: '+506' },
  { iso: 'HR', name: 'Croatia', dial: '+385' },
  { iso: 'CY', name: 'Cyprus', dial: '+357' },
  { iso: 'CZ', name: 'Czechia', dial: '+420' },
  { iso: 'DK', name: 'Denmark', dial: '+45' },
  { iso: 'DO', name: 'Dominican Republic', dial: '+1' },
  { iso: 'EC', name: 'Ecuador', dial: '+593' },
  { iso: 'EG', name: 'Egypt', dial: '+20' },
  { iso: 'SV', name: 'El Salvador', dial: '+503' },
  { iso: 'EE', name: 'Estonia', dial: '+372' },
  { iso: 'ET', name: 'Ethiopia', dial: '+251' },
  { iso: 'FI', name: 'Finland', dial: '+358' },
  { iso: 'FR', name: 'France', dial: '+33' },
  { iso: 'GE', name: 'Georgia', dial: '+995' },
  { iso: 'DE', name: 'Germany', dial: '+49' },
  { iso: 'GH', name: 'Ghana', dial: '+233' },
  { iso: 'GR', name: 'Greece', dial: '+30' },
  { iso: 'GT', name: 'Guatemala', dial: '+502' },
  { iso: 'HN', name: 'Honduras', dial: '+504' },
  { iso: 'HK', name: 'Hong Kong', dial: '+852' },
  { iso: 'HU', name: 'Hungary', dial: '+36' },
  { iso: 'IS', name: 'Iceland', dial: '+354' },
  { iso: 'IN', name: 'India', dial: '+91' },
  { iso: 'ID', name: 'Indonesia', dial: '+62' },
  { iso: 'IQ', name: 'Iraq', dial: '+964' },
  { iso: 'IE', name: 'Ireland', dial: '+353' },
  { iso: 'IL', name: 'Israel', dial: '+972' },
  { iso: 'IT', name: 'Italy', dial: '+39' },
  { iso: 'JM', name: 'Jamaica', dial: '+1' },
  { iso: 'JP', name: 'Japan', dial: '+81' },
  { iso: 'JO', name: 'Jordan', dial: '+962' },
  { iso: 'KZ', name: 'Kazakhstan', dial: '+7' },
  { iso: 'KE', name: 'Kenya', dial: '+254' },
  { iso: 'KW', name: 'Kuwait', dial: '+965' },
  { iso: 'LV', name: 'Latvia', dial: '+371' },
  { iso: 'LB', name: 'Lebanon', dial: '+961' },
  { iso: 'LT', name: 'Lithuania', dial: '+370' },
  { iso: 'LU', name: 'Luxembourg', dial: '+352' },
  { iso: 'MY', name: 'Malaysia', dial: '+60' },
  { iso: 'MT', name: 'Malta', dial: '+356' },
  { iso: 'MU', name: 'Mauritius', dial: '+230' },
  { iso: 'MX', name: 'Mexico', dial: '+52' },
  { iso: 'MD', name: 'Moldova', dial: '+373' },
  { iso: 'MA', name: 'Morocco', dial: '+212' },
  { iso: 'MM', name: 'Myanmar', dial: '+95' },
  { iso: 'NP', name: 'Nepal', dial: '+977' },
  { iso: 'NL', name: 'Netherlands', dial: '+31' },
  { iso: 'NZ', name: 'New Zealand', dial: '+64' },
  { iso: 'NG', name: 'Nigeria', dial: '+234' },
  { iso: 'NO', name: 'Norway', dial: '+47' },
  { iso: 'OM', name: 'Oman', dial: '+968' },
  { iso: 'PK', name: 'Pakistan', dial: '+92' },
  { iso: 'PA', name: 'Panama', dial: '+507' },
  { iso: 'PY', name: 'Paraguay', dial: '+595' },
  { iso: 'PE', name: 'Peru', dial: '+51' },
  { iso: 'PH', name: 'Philippines', dial: '+63' },
  { iso: 'PL', name: 'Poland', dial: '+48' },
  { iso: 'PT', name: 'Portugal', dial: '+351' },
  { iso: 'PR', name: 'Puerto Rico', dial: '+1' },
  { iso: 'QA', name: 'Qatar', dial: '+974' },
  { iso: 'RO', name: 'Romania', dial: '+40' },
  { iso: 'RU', name: 'Russia', dial: '+7' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '+966' },
  { iso: 'RS', name: 'Serbia', dial: '+381' },
  { iso: 'SG', name: 'Singapore', dial: '+65' },
  { iso: 'SK', name: 'Slovakia', dial: '+421' },
  { iso: 'SI', name: 'Slovenia', dial: '+386' },
  { iso: 'ZA', name: 'South Africa', dial: '+27' },
  { iso: 'KR', name: 'South Korea', dial: '+82' },
  { iso: 'ES', name: 'Spain', dial: '+34' },
  { iso: 'LK', name: 'Sri Lanka', dial: '+94' },
  { iso: 'SE', name: 'Sweden', dial: '+46' },
  { iso: 'CH', name: 'Switzerland', dial: '+41' },
  { iso: 'TW', name: 'Taiwan', dial: '+886' },
  { iso: 'TZ', name: 'Tanzania', dial: '+255' },
  { iso: 'TH', name: 'Thailand', dial: '+66' },
  { iso: 'TN', name: 'Tunisia', dial: '+216' },
  { iso: 'TR', name: 'Türkiye', dial: '+90' },
  { iso: 'UG', name: 'Uganda', dial: '+256' },
  { iso: 'UA', name: 'Ukraine', dial: '+380' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '+971' },
  { iso: 'GB', name: 'United Kingdom', dial: '+44' },
  { iso: 'US', name: 'United States', dial: '+1' },
  { iso: 'UY', name: 'Uruguay', dial: '+598' },
  { iso: 'UZ', name: 'Uzbekistan', dial: '+998' },
  { iso: 'VE', name: 'Venezuela', dial: '+58' },
  { iso: 'VN', name: 'Vietnam', dial: '+84' },
  { iso: 'ZM', name: 'Zambia', dial: '+260' },
  { iso: 'ZW', name: 'Zimbabwe', dial: '+263' },
];

// Zones whose country can't be read off the zone name. Most IANA identifiers
// are Region/City, and the city gives it away — but only to a human, so the
// common ones are listed here rather than guessed at.
const CM_ZONE_COUNTRY = {
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN',
  'Asia/Dubai': 'AE', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD',
  'Asia/Colombo': 'LK', 'Asia/Kathmandu': 'NP', 'Asia/Singapore': 'SG',
  'Asia/Hong_Kong': 'HK', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN', 'Asia/Taipei': 'TW', 'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Asia/Kuala_Lumpur': 'MY',
  'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW',
  'Asia/Jerusalem': 'IL', 'Asia/Tehran': 'IR',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Lisbon': 'PT',
  'Europe/Athens': 'GR', 'Europe/Bucharest': 'RO', 'Europe/Moscow': 'RU',
  'Europe/Istanbul': 'TR', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Bogota': 'CO',
  'America/Lima': 'PE', 'America/Santiago': 'CL',
  'America/Argentina/Buenos_Aires': 'AR',
  'Africa/Johannesburg': 'ZA', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'Africa/Cairo': 'EG', 'Africa/Accra': 'GH', 'Africa/Casablanca': 'MA',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU',
  'Pacific/Auckland': 'NZ',
};

/**
 * Best guess at the user's country, most reliable signal first.
 *
 * The account's timezone comes first because it was captured from this
 * person's own browser at sign-up and describes where the business actually
 * operates. Browser locale is the fallback: it's a language preference, and
 * plenty of people run an en-US machine from Bengaluru.
 */
window.CM_guessCountry = function (accountTimezone) {
  const zone = accountTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone && CM_ZONE_COUNTRY[zone]) return CM_ZONE_COUNTRY[zone];

  try {
    const locale = new Intl.Locale(navigator.language);
    const region = (locale.maximize && locale.maximize().region) || locale.region;
    if (region && CM_DIAL_CODES.some((c) => c.iso === region)) return region;
  } catch { /* older browsers: fall through */ }

  return 'US';
};

window.CM_DIAL_CODES = CM_DIAL_CODES;
