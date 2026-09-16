/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sharp: {
          50: '#eef7ff',
          100: '#d9ecff',
          500: '#1f6feb',
          600: '#1a5bc4',
          700: '#15499c',
          900: '#0b2a5c',
        },
      },
    },
  },
  plugins: [],
};
