/**
 * Maps the theme tokens to utilities (`bg-bg-default`, `text-content-muted`,
 * `gap-tight`, `animate-modal-fly-in`, …). The vendored Inflect components are
 * written against these names; inflect-compliance keeps the same mapping in its
 * own tailwind.config.js, which the package does not ship. This copy holds only
 * what hello-world and the vendored code use — no Inflect brand ramp, process
 * canvas or navigation animations.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  theme: {
    screens: {
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
      '3xl': '1792px',
    },
    extend: {
      colors: {
        brand: {
          default: 'var(--brand-default)',
          emphasis: 'var(--brand-emphasis)',
          muted: 'var(--brand-muted)',
          subtle: 'var(--brand-subtle)',
        },
        bg: {
          default: 'var(--bg-default)',
          muted: 'var(--bg-muted)',
          subtle: 'var(--bg-subtle)',
          elevated: 'var(--bg-elevated)',
          page: 'var(--bg-page)',
          inverted: 'var(--bg-inverted)',
          overlay: 'var(--bg-overlay)',
          success: 'var(--bg-success)',
          'success-emphasis': 'var(--bg-success-emphasis)',
          warning: 'var(--bg-warning)',
          'warning-emphasis': 'var(--bg-warning-emphasis)',
          error: 'var(--bg-error)',
          'error-emphasis': 'var(--bg-error-emphasis)',
          info: 'var(--bg-info)',
          'info-emphasis': 'var(--bg-info-emphasis)',
          attention: 'var(--bg-attention)',
        },
        content: {
          emphasis: 'var(--content-emphasis)',
          default: 'var(--content-default)',
          muted: 'var(--content-muted)',
          subtle: 'var(--content-subtle)',
          inverted: 'var(--content-inverted)',
          brand: 'var(--content-brand)',
          success: 'var(--content-success)',
          warning: 'var(--content-warning)',
          error: 'var(--content-error)',
          info: 'var(--content-info)',
          attention: 'var(--content-attention)',
        },
        border: {
          default: 'var(--border-default)',
          subtle: 'var(--border-subtle)',
          emphasis: 'var(--border-emphasis)',
          strong: 'var(--border-strong)',
          success: 'var(--border-success)',
          warning: 'var(--border-warning)',
          error: 'var(--border-error)',
          info: 'var(--border-info)',
        },
        inverted: 'var(--bg-inverted)',
        primary: 'var(--primary)',
        ring: 'var(--ring)',
        background: 'var(--ring-offset-background)',
      },
      ringOffsetColor: {
        background: 'var(--ring-offset-background)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      // Inflect's semantic spacing scale: tight 8, compact 12, default 16,
      // section 24, page 40 px.
      spacing: {
        tight: '0.5rem',
        compact: '0.75rem',
        default: '1rem',
        section: '1.5rem',
        page: '2.5rem',
      },
      maxWidth: {
        'trunc-tight': '14ch',
        'trunc-default': '28ch',
        'trunc-loose': '40ch',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'slide-up-fade': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down-fade': {
          '0%': { opacity: '0', transform: 'translateY(-6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'modal-fly-in': {
          '0%': { opacity: '0', transform: 'scale(0.88)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'modal-fly-out': {
          '0%': { opacity: '1', transform: 'scale(1)' },
          '100%': { opacity: '0', transform: 'scale(0.96)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-out': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        'shimmer-pulse': {
          '0%, 100%': { opacity: '0.25' },
          '50%': { opacity: '1' },
        },
        'shimmer-sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'slide-up-fade': 'slide-up-fade 0.2s ease-out',
        'slide-down-fade': 'slide-down-fade 0.2s ease-out',
        'scale-in': 'scale-in 0.15s ease-out',
        'modal-fly-in': 'modal-fly-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'modal-fly-out': 'modal-fly-out 0.15s ease-in',
        'fade-in': 'fade-in 0.15s ease-out',
        'fade-out': 'fade-out 0.15s ease-out',
        'shimmer-pulse': 'shimmer-pulse 1.6s ease-in-out infinite',
        'shimmer-sweep': 'shimmer-sweep 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [
    function scrollbarHide({ addUtilities }) {
      addUtilities({
        '.scrollbar-hide': {
          '-ms-overflow-style': 'none',
          'scrollbar-width': 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        },
      });
    },
  ],
};
