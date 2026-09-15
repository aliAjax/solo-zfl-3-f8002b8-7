/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
    },
    extend: {
      colors: {
        'warm-beige': '#F5F0E8',
        'warm-cream': '#FBF7F0',
        'deep-brown': '#3D352E',
        'moss-green': '#6B8E5A',
        'moss-light': '#8AA87A',
        'ochre': '#C17F59',
        'ochre-light': '#D49B7A',
        'paper': '#FAF6EF',
        'ink': '#2D2620',
        'ink-light': '#6B5D52',
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', 'Georgia', 'serif'],
        sans: ['"Noto Sans SC"', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      boxShadow: {
        'paper': '0 1px 3px rgba(61, 53, 46, 0.08), 0 1px 2px rgba(61, 53, 46, 0.06)',
        'paper-hover': '0 4px 12px rgba(61, 53, 46, 0.12), 0 2px 4px rgba(61, 53, 46, 0.08)',
        'card': '0 2px 8px rgba(61, 53, 46, 0.08)',
      },
      borderRadius: {
        'lg': '0.75rem',
        'xl': '1rem',
        '2xl': '1.5rem',
      },
    },
  },
  plugins: [],
};
