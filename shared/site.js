// The public site's shared chrome, as plain data. worker/pages.js layout() renders it for the
// Worker pages and src/components/Nav.jsx + Footer.jsx render it for the React app, so the two
// can't drift apart; worker/shared-site.test.js checks both sides read from here.

export const NAV = [
  { key: 'odds', label: 'Odds', href: '/odds' },
  { key: 'tools', label: 'Tools', href: '/tools' },
  { key: 'record', label: 'Record', href: '/record' },
];

export const CTA_LABEL = 'Get edges free';

export const FOOTER = {
  disclaimer:
    'PickSharp compares sportsbook prices with a no-vig fair price, for informational purposes only. Prices move, and a bet priced above fair can still lose; we do not guarantee outcomes. Betting involves risk — never wager more than you can afford to lose.',
  helpline: { label: '1-800-GAMBLER', tel: '1-800-522-4700' },
  eligibility: 'Must be 21+ and located in a jurisdiction where sports betting is legal.',
  links: [
    { label: 'Terms of Service', href: '/terms' },
    { label: 'Privacy Policy', href: '/privacy' },
  ],
};

export const COLORS = {
  sharp: {
    50: '#fdf8e9',
    100: '#f5e7b8',
    200: '#ead489',
    400: '#e0bb4a',
    500: '#d4a72e',
    600: '#c6971f',
    700: '#9c7818',
    900: '#544009',
  },
  // The gold button: top to bottom.
  gradient: ['#f3dd8f', '#c6971f', '#8a6a17'],
  gradientHover: ['#f7e6a8', '#d4a72e', '#9c7818'],
};
