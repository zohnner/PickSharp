/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
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
      },
    },
  },
  plugins: [],
};
