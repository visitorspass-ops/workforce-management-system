/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Locad WFM design system — settled colors only, no ad-hoc hex values.
      // See claude/8-view-architecture-blueprint-review.md for the reasoning
      // behind each of these (reuse-before-minting, one threshold scale per metric).
      colors: {
        bg: "#060a07",
        panel: "#0b0f0c",
        panel2: "#111812",
        border: "#1b281d",
        text: "#f0f5f0",
        muted: "#829482",
        go: "#00ff66",
        goDim: "#093816",
        amber: "#e5a938",
        amberDim: "#3a2a0d",
        red: "#e54d4d",
        redDim: "#3a1212",
        blue: "#60a5fa",
        blueDim: "#1e3a8a",
        purple: "#c084fc",
        purpleDim: "#3b0764",
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
        prose: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
