/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        sharp: {
          50: '#fbf6e7',
          100: '#f3e3bc',
          200: '#e8ce8c',
          500: '#c9a227',
          600: '#b8901e',
          700: '#8f6e15',
          900: '#4a3908',
        },
      },
    },
  },
  plugins: [],
};
