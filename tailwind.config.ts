import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
          2: "hsl(var(--accent-2))",
          ink: "hsl(var(--accent-ink))",
          soft: "hsl(var(--accent-soft))",
        },
        obsidian: {
          0: "#06080c",
          1: "#0a0d14",
          2: "#0f131c",
          3: "#151a25",
          4: "#1d2431",
          line: "#1a2030",
          "line-2": "#222a3b",
        },
        fg: {
          0: "#e8ecf2",
          1: "#aeb7c6",
          2: "#6a7588",
          3: "#454f61",
        },
        up: { DEFAULT: "#39d98a" },
        down: { DEFAULT: "#ff5a6a" },
        warn: { DEFAULT: "#ffb020" },
        info: { DEFAULT: "#7aa4ff" },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"Geist Mono"', "ui-monospace", "Menlo", "monospace"],
        serif: ['"Instrument Serif"', "ui-serif", "Georgia", "serif"],
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "1.2" }],
        "3xs": ["9px", { lineHeight: "1.2" }],
      },
      boxShadow: {
        panel:
          "0 1px 0 rgba(255,255,255,0.02) inset, 0 20px 40px -20px rgba(0,0,0,0.6)",
        "accent-glow":
          "0 0 0 1px hsl(var(--accent)), 0 8px 20px -6px hsl(var(--accent-glow))",
        "live-dot": "0 0 0 3px rgba(57,217,138,0.2)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 20px -5px hsl(var(--primary) / 0.2)" },
          "50%": { boxShadow: "0 0 30px 0px hsl(var(--primary) / 0.4)" },
        },
        "slide-up": {
          "0%": { transform: "translateY(10px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(100%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        "slide-in-left": {
          "0%": { transform: "translateX(-100%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "scale-in": {
          "0%": { transform: "scale(0.95)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "shimmer": {
          "0%": { backgroundPosition: "-1000px 0" },
          "100%": { backgroundPosition: "1000px 0" },
        },
        "bounce-subtle": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-5px)" },
        },
        "glow-pulse": {
          "0%, 100%": {
            boxShadow: "0 0 20px -5px hsl(var(--primary) / 0.3), inset 0 0 20px -10px hsl(var(--primary) / 0.2)"
          },
          "50%": {
            boxShadow: "0 0 40px 0px hsl(var(--primary) / 0.5), inset 0 0 30px -5px hsl(var(--primary) / 0.3)"
          },
        },
        "live-pulse": {
          "0%, 100%": { boxShadow: "0 0 0 3px rgba(57,217,138,0.2)" },
          "50%": { boxShadow: "0 0 0 5px rgba(57,217,138,0.28)" },
        },
        "ticker-scroll": {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "flash-up": {
          "0%": { backgroundColor: "rgba(57,217,138,0.28)" },
          "100%": { backgroundColor: "rgba(57,217,138,0)" },
        },
        "flash-down": {
          "0%": { backgroundColor: "rgba(255,90,106,0.28)" },
          "100%": { backgroundColor: "rgba(255,90,106,0)" },
        },
        "row-flash": {
          "0%": { backgroundColor: "hsl(var(--accent) / 0.18)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "glow-pulse": "glow-pulse 3s ease-in-out infinite",
        "slide-up": "slide-up 0.3s ease-out",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        "slide-in-left": "slide-in-left 0.3s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "scale-in": "scale-in 0.2s ease-out",
        "shimmer": "shimmer 2s linear infinite",
        "bounce-subtle": "bounce-subtle 2s ease-in-out infinite",
        "live-pulse": "live-pulse 1.6s ease-in-out infinite",
        "ticker-scroll": "ticker-scroll 90s linear infinite",
        "flash-up": "flash-up 600ms ease",
        "flash-down": "flash-down 600ms ease",
        "row-flash": "row-flash 900ms ease",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
