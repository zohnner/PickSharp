import { COLORS } from './shared/site.js';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sharp: COLORS.sharp,
      },
    },
  },
  plugins: [],
};
