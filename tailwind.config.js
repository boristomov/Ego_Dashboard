/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#08090c",
        panel: "#0e1015",
        "panel-hover": "#151820",
        input: "#0b0c10",
        border: "#1c1f2a",
        text: {
          DEFAULT: "#e2e8f0",
          muted: "#7c8598",
          dim: "#505872",
        },
        accent: {
          DEFAULT: "#a855f7",
          hover: "#c084fc",
          cyan: "#06b6d4",
        },
        ok: "#22c55e",
        warn: "#eab308",
        err: "#ef4444",
        info: "#6366f1",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #a855f7 0%, #06b6d4 100%)",
        "panel-grad":
          "linear-gradient(180deg, rgba(168,85,247,0.04) 0%, rgba(6,182,212,0.02) 100%)",
      },
      boxShadow: {
        "glow-accent": "0 0 24px rgba(168, 85, 247, 0.25)",
        "glow-cyan": "0 0 24px rgba(6, 182, 212, 0.25)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
