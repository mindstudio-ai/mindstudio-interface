/**
 * Phone number utilities for auth flows.
 *
 * Provides country data, E.164 conversion, formatting, and validation.
 * No external dependencies — designed for login/signup UIs that need
 * a country code picker and phone number formatting.
 */

// ---------------------------------------------------------------------------
// Country data
// ---------------------------------------------------------------------------

/** A country with its dial code and flag emoji. */
export interface Country {
  /** ISO 3166-1 alpha-2 code (e.g. "US"). */
  code: string;
  /** International dial code with + prefix (e.g. "+1"). */
  dialCode: string;
  /** Country name in English. */
  name: string;
  /** Flag emoji. */
  flag: string;
}

/** All countries with dial codes, sorted alphabetically by name. */
export const countries: readonly Country[] = [
  { code: 'AF', dialCode: '+93', name: 'Afghanistan', flag: '🇦🇫' },
  { code: 'AL', dialCode: '+355', name: 'Albania', flag: '🇦🇱' },
  { code: 'DZ', dialCode: '+213', name: 'Algeria', flag: '🇩🇿' },
  { code: 'AD', dialCode: '+376', name: 'Andorra', flag: '🇦🇩' },
  { code: 'AO', dialCode: '+244', name: 'Angola', flag: '🇦🇴' },
  { code: 'AG', dialCode: '+1', name: 'Antigua and Barbuda', flag: '🇦🇬' },
  { code: 'AR', dialCode: '+54', name: 'Argentina', flag: '🇦🇷' },
  { code: 'AM', dialCode: '+374', name: 'Armenia', flag: '🇦🇲' },
  { code: 'AU', dialCode: '+61', name: 'Australia', flag: '🇦🇺' },
  { code: 'AT', dialCode: '+43', name: 'Austria', flag: '🇦🇹' },
  { code: 'AZ', dialCode: '+994', name: 'Azerbaijan', flag: '🇦🇿' },
  { code: 'BS', dialCode: '+1', name: 'Bahamas', flag: '🇧🇸' },
  { code: 'BH', dialCode: '+973', name: 'Bahrain', flag: '🇧🇭' },
  { code: 'BD', dialCode: '+880', name: 'Bangladesh', flag: '🇧🇩' },
  { code: 'BB', dialCode: '+1', name: 'Barbados', flag: '🇧🇧' },
  { code: 'BY', dialCode: '+375', name: 'Belarus', flag: '🇧🇾' },
  { code: 'BE', dialCode: '+32', name: 'Belgium', flag: '🇧🇪' },
  { code: 'BZ', dialCode: '+501', name: 'Belize', flag: '🇧🇿' },
  { code: 'BJ', dialCode: '+229', name: 'Benin', flag: '🇧🇯' },
  { code: 'BT', dialCode: '+975', name: 'Bhutan', flag: '🇧🇹' },
  { code: 'BO', dialCode: '+591', name: 'Bolivia', flag: '🇧🇴' },
  { code: 'BA', dialCode: '+387', name: 'Bosnia and Herzegovina', flag: '🇧🇦' },
  { code: 'BW', dialCode: '+267', name: 'Botswana', flag: '🇧🇼' },
  { code: 'BR', dialCode: '+55', name: 'Brazil', flag: '🇧🇷' },
  { code: 'BN', dialCode: '+673', name: 'Brunei', flag: '🇧🇳' },
  { code: 'BG', dialCode: '+359', name: 'Bulgaria', flag: '🇧🇬' },
  { code: 'BF', dialCode: '+226', name: 'Burkina Faso', flag: '🇧🇫' },
  { code: 'BI', dialCode: '+257', name: 'Burundi', flag: '🇧🇮' },
  { code: 'CV', dialCode: '+238', name: 'Cabo Verde', flag: '🇨🇻' },
  { code: 'KH', dialCode: '+855', name: 'Cambodia', flag: '🇰🇭' },
  { code: 'CM', dialCode: '+237', name: 'Cameroon', flag: '🇨🇲' },
  { code: 'CA', dialCode: '+1', name: 'Canada', flag: '🇨🇦' },
  {
    code: 'CF',
    dialCode: '+236',
    name: 'Central African Republic',
    flag: '🇨🇫',
  },
  { code: 'TD', dialCode: '+235', name: 'Chad', flag: '🇹🇩' },
  { code: 'CL', dialCode: '+56', name: 'Chile', flag: '🇨🇱' },
  { code: 'CN', dialCode: '+86', name: 'China', flag: '🇨🇳' },
  { code: 'CO', dialCode: '+57', name: 'Colombia', flag: '🇨🇴' },
  { code: 'KM', dialCode: '+269', name: 'Comoros', flag: '🇰🇲' },
  { code: 'CG', dialCode: '+242', name: 'Congo', flag: '🇨🇬' },
  { code: 'CD', dialCode: '+243', name: 'Congo (DRC)', flag: '🇨🇩' },
  { code: 'CR', dialCode: '+506', name: 'Costa Rica', flag: '🇨🇷' },
  { code: 'HR', dialCode: '+385', name: 'Croatia', flag: '🇭🇷' },
  { code: 'CU', dialCode: '+53', name: 'Cuba', flag: '🇨🇺' },
  { code: 'CY', dialCode: '+357', name: 'Cyprus', flag: '🇨🇾' },
  { code: 'CZ', dialCode: '+420', name: 'Czechia', flag: '🇨🇿' },
  { code: 'CI', dialCode: '+225', name: "Cote d'Ivoire", flag: '🇨🇮' },
  { code: 'DK', dialCode: '+45', name: 'Denmark', flag: '🇩🇰' },
  { code: 'DJ', dialCode: '+253', name: 'Djibouti', flag: '🇩🇯' },
  { code: 'DM', dialCode: '+1', name: 'Dominica', flag: '🇩🇲' },
  { code: 'DO', dialCode: '+1', name: 'Dominican Republic', flag: '🇩🇴' },
  { code: 'EC', dialCode: '+593', name: 'Ecuador', flag: '🇪🇨' },
  { code: 'EG', dialCode: '+20', name: 'Egypt', flag: '🇪🇬' },
  { code: 'SV', dialCode: '+503', name: 'El Salvador', flag: '🇸🇻' },
  { code: 'GQ', dialCode: '+240', name: 'Equatorial Guinea', flag: '🇬🇶' },
  { code: 'ER', dialCode: '+291', name: 'Eritrea', flag: '🇪🇷' },
  { code: 'EE', dialCode: '+372', name: 'Estonia', flag: '🇪🇪' },
  { code: 'SZ', dialCode: '+268', name: 'Eswatini', flag: '🇸🇿' },
  { code: 'ET', dialCode: '+251', name: 'Ethiopia', flag: '🇪🇹' },
  { code: 'FJ', dialCode: '+679', name: 'Fiji', flag: '🇫🇯' },
  { code: 'FI', dialCode: '+358', name: 'Finland', flag: '🇫🇮' },
  { code: 'FR', dialCode: '+33', name: 'France', flag: '🇫🇷' },
  { code: 'GA', dialCode: '+241', name: 'Gabon', flag: '🇬🇦' },
  { code: 'GM', dialCode: '+220', name: 'Gambia', flag: '🇬🇲' },
  { code: 'GE', dialCode: '+995', name: 'Georgia', flag: '🇬🇪' },
  { code: 'DE', dialCode: '+49', name: 'Germany', flag: '🇩🇪' },
  { code: 'GH', dialCode: '+233', name: 'Ghana', flag: '🇬🇭' },
  { code: 'GR', dialCode: '+30', name: 'Greece', flag: '🇬🇷' },
  { code: 'GD', dialCode: '+1', name: 'Grenada', flag: '🇬🇩' },
  { code: 'GT', dialCode: '+502', name: 'Guatemala', flag: '🇬🇹' },
  { code: 'GN', dialCode: '+224', name: 'Guinea', flag: '🇬🇳' },
  { code: 'GW', dialCode: '+245', name: 'Guinea-Bissau', flag: '🇬🇼' },
  { code: 'GY', dialCode: '+592', name: 'Guyana', flag: '🇬🇾' },
  { code: 'HT', dialCode: '+509', name: 'Haiti', flag: '🇭🇹' },
  { code: 'HN', dialCode: '+504', name: 'Honduras', flag: '🇭🇳' },
  { code: 'HK', dialCode: '+852', name: 'Hong Kong', flag: '🇭🇰' },
  { code: 'HU', dialCode: '+36', name: 'Hungary', flag: '🇭🇺' },
  { code: 'IS', dialCode: '+354', name: 'Iceland', flag: '🇮🇸' },
  { code: 'IN', dialCode: '+91', name: 'India', flag: '🇮🇳' },
  { code: 'ID', dialCode: '+62', name: 'Indonesia', flag: '🇮🇩' },
  { code: 'IR', dialCode: '+98', name: 'Iran', flag: '🇮🇷' },
  { code: 'IQ', dialCode: '+964', name: 'Iraq', flag: '🇮🇶' },
  { code: 'IE', dialCode: '+353', name: 'Ireland', flag: '🇮🇪' },
  { code: 'IL', dialCode: '+972', name: 'Israel', flag: '🇮🇱' },
  { code: 'IT', dialCode: '+39', name: 'Italy', flag: '🇮🇹' },
  { code: 'JM', dialCode: '+1', name: 'Jamaica', flag: '🇯🇲' },
  { code: 'JP', dialCode: '+81', name: 'Japan', flag: '🇯🇵' },
  { code: 'JO', dialCode: '+962', name: 'Jordan', flag: '🇯🇴' },
  { code: 'KZ', dialCode: '+7', name: 'Kazakhstan', flag: '🇰🇿' },
  { code: 'KE', dialCode: '+254', name: 'Kenya', flag: '🇰🇪' },
  { code: 'KI', dialCode: '+686', name: 'Kiribati', flag: '🇰🇮' },
  { code: 'KW', dialCode: '+965', name: 'Kuwait', flag: '🇰🇼' },
  { code: 'KG', dialCode: '+996', name: 'Kyrgyzstan', flag: '🇰🇬' },
  { code: 'LA', dialCode: '+856', name: 'Laos', flag: '🇱🇦' },
  { code: 'LV', dialCode: '+371', name: 'Latvia', flag: '🇱🇻' },
  { code: 'LB', dialCode: '+961', name: 'Lebanon', flag: '🇱🇧' },
  { code: 'LS', dialCode: '+266', name: 'Lesotho', flag: '🇱🇸' },
  { code: 'LR', dialCode: '+231', name: 'Liberia', flag: '🇱🇷' },
  { code: 'LY', dialCode: '+218', name: 'Libya', flag: '🇱🇾' },
  { code: 'LI', dialCode: '+423', name: 'Liechtenstein', flag: '🇱🇮' },
  { code: 'LT', dialCode: '+370', name: 'Lithuania', flag: '🇱🇹' },
  { code: 'LU', dialCode: '+352', name: 'Luxembourg', flag: '🇱🇺' },
  { code: 'MO', dialCode: '+853', name: 'Macao', flag: '🇲🇴' },
  { code: 'MG', dialCode: '+261', name: 'Madagascar', flag: '🇲🇬' },
  { code: 'MW', dialCode: '+265', name: 'Malawi', flag: '🇲🇼' },
  { code: 'MY', dialCode: '+60', name: 'Malaysia', flag: '🇲🇾' },
  { code: 'MV', dialCode: '+960', name: 'Maldives', flag: '🇲🇻' },
  { code: 'ML', dialCode: '+223', name: 'Mali', flag: '🇲🇱' },
  { code: 'MT', dialCode: '+356', name: 'Malta', flag: '🇲🇹' },
  { code: 'MH', dialCode: '+692', name: 'Marshall Islands', flag: '🇲🇭' },
  { code: 'MR', dialCode: '+222', name: 'Mauritania', flag: '🇲🇷' },
  { code: 'MU', dialCode: '+230', name: 'Mauritius', flag: '🇲🇺' },
  { code: 'MX', dialCode: '+52', name: 'Mexico', flag: '🇲🇽' },
  { code: 'FM', dialCode: '+691', name: 'Micronesia', flag: '🇫🇲' },
  { code: 'MD', dialCode: '+373', name: 'Moldova', flag: '🇲🇩' },
  { code: 'MC', dialCode: '+377', name: 'Monaco', flag: '🇲🇨' },
  { code: 'MN', dialCode: '+976', name: 'Mongolia', flag: '🇲🇳' },
  { code: 'ME', dialCode: '+382', name: 'Montenegro', flag: '🇲🇪' },
  { code: 'MA', dialCode: '+212', name: 'Morocco', flag: '🇲🇦' },
  { code: 'MZ', dialCode: '+258', name: 'Mozambique', flag: '🇲🇿' },
  { code: 'MM', dialCode: '+95', name: 'Myanmar', flag: '🇲🇲' },
  { code: 'NA', dialCode: '+264', name: 'Namibia', flag: '🇳🇦' },
  { code: 'NR', dialCode: '+674', name: 'Nauru', flag: '🇳🇷' },
  { code: 'NP', dialCode: '+977', name: 'Nepal', flag: '🇳🇵' },
  { code: 'NL', dialCode: '+31', name: 'Netherlands', flag: '🇳🇱' },
  { code: 'NZ', dialCode: '+64', name: 'New Zealand', flag: '🇳🇿' },
  { code: 'NI', dialCode: '+505', name: 'Nicaragua', flag: '🇳🇮' },
  { code: 'NE', dialCode: '+227', name: 'Niger', flag: '🇳🇪' },
  { code: 'NG', dialCode: '+234', name: 'Nigeria', flag: '🇳🇬' },
  { code: 'KP', dialCode: '+850', name: 'North Korea', flag: '🇰🇵' },
  { code: 'MK', dialCode: '+389', name: 'North Macedonia', flag: '🇲🇰' },
  { code: 'NO', dialCode: '+47', name: 'Norway', flag: '🇳🇴' },
  { code: 'OM', dialCode: '+968', name: 'Oman', flag: '🇴🇲' },
  { code: 'PK', dialCode: '+92', name: 'Pakistan', flag: '🇵🇰' },
  { code: 'PW', dialCode: '+680', name: 'Palau', flag: '🇵🇼' },
  { code: 'PS', dialCode: '+970', name: 'Palestine', flag: '🇵🇸' },
  { code: 'PA', dialCode: '+507', name: 'Panama', flag: '🇵🇦' },
  { code: 'PG', dialCode: '+675', name: 'Papua New Guinea', flag: '🇵🇬' },
  { code: 'PY', dialCode: '+595', name: 'Paraguay', flag: '🇵🇾' },
  { code: 'PE', dialCode: '+51', name: 'Peru', flag: '🇵🇪' },
  { code: 'PH', dialCode: '+63', name: 'Philippines', flag: '🇵🇭' },
  { code: 'PL', dialCode: '+48', name: 'Poland', flag: '🇵🇱' },
  { code: 'PT', dialCode: '+351', name: 'Portugal', flag: '🇵🇹' },
  { code: 'PR', dialCode: '+1', name: 'Puerto Rico', flag: '🇵🇷' },
  { code: 'QA', dialCode: '+974', name: 'Qatar', flag: '🇶🇦' },
  { code: 'RO', dialCode: '+40', name: 'Romania', flag: '🇷🇴' },
  { code: 'RU', dialCode: '+7', name: 'Russia', flag: '🇷🇺' },
  { code: 'RW', dialCode: '+250', name: 'Rwanda', flag: '🇷🇼' },
  { code: 'KN', dialCode: '+1', name: 'Saint Kitts and Nevis', flag: '🇰🇳' },
  { code: 'LC', dialCode: '+1', name: 'Saint Lucia', flag: '🇱🇨' },
  {
    code: 'VC',
    dialCode: '+1',
    name: 'Saint Vincent and the Grenadines',
    flag: '🇻🇨',
  },
  { code: 'WS', dialCode: '+685', name: 'Samoa', flag: '🇼🇸' },
  { code: 'SM', dialCode: '+378', name: 'San Marino', flag: '🇸🇲' },
  { code: 'ST', dialCode: '+239', name: 'Sao Tome and Principe', flag: '🇸🇹' },
  { code: 'SA', dialCode: '+966', name: 'Saudi Arabia', flag: '🇸🇦' },
  { code: 'SN', dialCode: '+221', name: 'Senegal', flag: '🇸🇳' },
  { code: 'RS', dialCode: '+381', name: 'Serbia', flag: '🇷🇸' },
  { code: 'SC', dialCode: '+248', name: 'Seychelles', flag: '🇸🇨' },
  { code: 'SL', dialCode: '+232', name: 'Sierra Leone', flag: '🇸🇱' },
  { code: 'SG', dialCode: '+65', name: 'Singapore', flag: '🇸🇬' },
  { code: 'SK', dialCode: '+421', name: 'Slovakia', flag: '🇸🇰' },
  { code: 'SI', dialCode: '+386', name: 'Slovenia', flag: '🇸🇮' },
  { code: 'SB', dialCode: '+677', name: 'Solomon Islands', flag: '🇸🇧' },
  { code: 'SO', dialCode: '+252', name: 'Somalia', flag: '🇸🇴' },
  { code: 'ZA', dialCode: '+27', name: 'South Africa', flag: '🇿🇦' },
  { code: 'KR', dialCode: '+82', name: 'South Korea', flag: '🇰🇷' },
  { code: 'SS', dialCode: '+211', name: 'South Sudan', flag: '🇸🇸' },
  { code: 'ES', dialCode: '+34', name: 'Spain', flag: '🇪🇸' },
  { code: 'LK', dialCode: '+94', name: 'Sri Lanka', flag: '🇱🇰' },
  { code: 'SD', dialCode: '+249', name: 'Sudan', flag: '🇸🇩' },
  { code: 'SR', dialCode: '+597', name: 'Suriname', flag: '🇸🇷' },
  { code: 'SE', dialCode: '+46', name: 'Sweden', flag: '🇸🇪' },
  { code: 'CH', dialCode: '+41', name: 'Switzerland', flag: '🇨🇭' },
  { code: 'SY', dialCode: '+963', name: 'Syria', flag: '🇸🇾' },
  { code: 'TW', dialCode: '+886', name: 'Taiwan', flag: '🇹🇼' },
  { code: 'TJ', dialCode: '+992', name: 'Tajikistan', flag: '🇹🇯' },
  { code: 'TZ', dialCode: '+255', name: 'Tanzania', flag: '🇹🇿' },
  { code: 'TH', dialCode: '+66', name: 'Thailand', flag: '🇹🇭' },
  { code: 'TL', dialCode: '+670', name: 'Timor-Leste', flag: '🇹🇱' },
  { code: 'TG', dialCode: '+228', name: 'Togo', flag: '🇹🇬' },
  { code: 'TO', dialCode: '+676', name: 'Tonga', flag: '🇹🇴' },
  { code: 'TT', dialCode: '+1', name: 'Trinidad and Tobago', flag: '🇹🇹' },
  { code: 'TN', dialCode: '+216', name: 'Tunisia', flag: '🇹🇳' },
  { code: 'TR', dialCode: '+90', name: 'Turkey', flag: '🇹🇷' },
  { code: 'TM', dialCode: '+993', name: 'Turkmenistan', flag: '🇹🇲' },
  { code: 'TV', dialCode: '+688', name: 'Tuvalu', flag: '🇹🇻' },
  { code: 'UG', dialCode: '+256', name: 'Uganda', flag: '🇺🇬' },
  { code: 'UA', dialCode: '+380', name: 'Ukraine', flag: '🇺🇦' },
  { code: 'AE', dialCode: '+971', name: 'United Arab Emirates', flag: '🇦🇪' },
  { code: 'GB', dialCode: '+44', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'US', dialCode: '+1', name: 'United States', flag: '🇺🇸' },
  { code: 'UY', dialCode: '+598', name: 'Uruguay', flag: '🇺🇾' },
  { code: 'UZ', dialCode: '+998', name: 'Uzbekistan', flag: '🇺🇿' },
  { code: 'VU', dialCode: '+678', name: 'Vanuatu', flag: '🇻🇺' },
  { code: 'VA', dialCode: '+39', name: 'Vatican City', flag: '🇻🇦' },
  { code: 'VE', dialCode: '+58', name: 'Venezuela', flag: '🇻🇪' },
  { code: 'VN', dialCode: '+84', name: 'Vietnam', flag: '🇻🇳' },
  { code: 'YE', dialCode: '+967', name: 'Yemen', flag: '🇾🇪' },
  { code: 'ZM', dialCode: '+260', name: 'Zambia', flag: '🇿🇲' },
  { code: 'ZW', dialCode: '+263', name: 'Zimbabwe', flag: '🇿🇼' },
];

// ---------------------------------------------------------------------------
// Country lookup helpers
// ---------------------------------------------------------------------------

const byCode = new Map(countries.map((c) => [c.code, c]));

/** Common IANA timezone → country code mapping. */
const timezoneToCountry: Record<string, string> = {
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Phoenix': 'US',
  'America/Indiana/Indianapolis': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/St_Johns': 'CA',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Bucharest': 'RO',
  'Europe/Budapest': 'HU',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Moscow': 'RU',
  'Europe/Kiev': 'UA',
  'Europe/Lisbon': 'PT',
  'Europe/Belgrade': 'RS',
  'Europe/Zagreb': 'HR',
  'Europe/Bratislava': 'SK',
  'Europe/Ljubljana': 'SI',
  'Europe/Tallinn': 'EE',
  'Europe/Riga': 'LV',
  'Europe/Vilnius': 'LT',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Taipei': 'TW',
  'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN',
  'Asia/Karachi': 'PK',
  'Asia/Dhaka': 'BD',
  'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID',
  'Asia/Manila': 'PH',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Riyadh': 'SA',
  'Asia/Dubai': 'AE',
  'Asia/Tehran': 'IR',
  'Asia/Baghdad': 'IQ',
  'Asia/Beirut': 'LB',
  'Asia/Jerusalem': 'IL',
  'Asia/Amman': 'JO',
  'Asia/Almaty': 'KZ',
  'Asia/Tashkent': 'UZ',
  'Asia/Colombo': 'LK',
  'Asia/Kathmandu': 'NP',
  'Asia/Yangon': 'MM',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Adelaide': 'AU',
  'Pacific/Auckland': 'NZ',
  'Pacific/Fiji': 'FJ',
  'Africa/Cairo': 'EG',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA',
  'Africa/Casablanca': 'MA',
  'Africa/Accra': 'GH',
  'Africa/Addis_Ababa': 'ET',
  'Africa/Dar_es_Salaam': 'TZ',
  'Africa/Kampala': 'UG',
  'America/Mexico_City': 'MX',
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'America/Santiago': 'CL',
  'America/Buenos_Aires': 'AR',
  'America/Sao_Paulo': 'BR',
  'America/Caracas': 'VE',
  'America/Guatemala': 'GT',
  'America/Havana': 'CU',
  'America/Panama': 'PA',
  'America/Jamaica': 'JM',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the user's country from their timezone.
 * Falls back to `'US'` if the timezone can't be mapped.
 */
export function detectCountry(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezoneToCountry[tz] ?? 'US';
  } catch {
    return 'US';
  }
}

/**
 * Format an E.164 phone number for display.
 *
 * US/CA numbers: `+1 (555) 123-4567`
 * Others: `+{dialCode} {rest}`
 */
export function format(e164: string): string {
  if (!e164.startsWith('+')) {
    return e164;
  }

  const digits = e164.slice(1);

  // US/CA: +1 followed by 10 digits
  if (digits.startsWith('1') && digits.length === 11) {
    const area = digits.slice(1, 4);
    const prefix = digits.slice(4, 7);
    const line = digits.slice(7);
    return `+1 (${area}) ${prefix}-${line}`;
  }

  // Find matching dial code (try longest match first)
  for (let len = 4; len >= 1; len--) {
    const candidate = '+' + digits.slice(0, len);
    const match = countries.find((c) => c.dialCode === candidate);
    if (match) {
      const rest = digits.slice(len);
      return `${match.dialCode} ${rest}`;
    }
  }

  return e164;
}

/**
 * Convert a national phone number to E.164 format.
 *
 * @param national - Phone number with or without formatting (e.g. "(555) 123-4567")
 * @param countryCode - ISO 3166-1 alpha-2 code (e.g. "US")
 * @returns E.164 formatted number (e.g. "+15551234567")
 */
export function toE164(national: string, countryCode: string): string {
  const digits = national.replace(/\D/g, '');
  const country = byCode.get(countryCode);
  if (!country) {
    return '+' + digits;
  }
  const dialDigits = country.dialCode.slice(1); // remove +
  // If the number already starts with the dial code, don't double-add
  if (digits.startsWith(dialDigits)) {
    return '+' + digits;
  }
  return country.dialCode + digits;
}

/**
 * Check if a string is a valid E.164 phone number.
 * Must start with + followed by 7-15 digits.
 */
export function isValid(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}
