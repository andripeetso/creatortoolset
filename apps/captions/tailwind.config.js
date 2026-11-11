const colors = require("tailwindcss/colors")
const plugin = require("tailwindcss/plugin")

/*
 * Light and dark from one set of classes. The app was drawn dark first (zinc greys, pale accent text, deep tinted
 * chips), so in light these swap through CSS variables: the zinc scale mirrors (950 <-> 50), accent text 50-400
 * turns 950-600, accent backgrounds and borders 800-950 turn 200-50. Dark keeps Tailwind's own values. Accents
 * 500-700 and solid accent fills 50-400 are the same in both. zinc-925 sits between 900 and 950 (old #101014 panels).
 */
const themed = (() => {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ")
  const mirror = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 500: 500, 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 }
  const hues = ["violet", "purple", "fuchsia", "pink", "rose", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo"]
  const light = {}, dark = {}
  const vary = (name, darkHex, lightHex) => {
    dark[`--${name}`] = rgb(darkHex)
    light[`--${name}`] = rgb(lightHex)
    return `rgb(var(--${name}) / <alpha-value>)`
  }
  const zinc = { ...colors.zinc, 950: "#0b0b10" } // the app's page colour
  const out = { zinc: {}, text: {}, surface: {} }
  for (const n of Object.keys(mirror)) out.zinc[n] = vary(`zinc-${n}`, zinc[n], colors.zinc[mirror[n]])
  out.zinc[925] = vary("zinc-925", "#111116", "#f7f7f8")
  for (const h of hues) {
    out.text[h] = {}
    out.surface[h] = {}
    for (const n of [50, 100, 200, 300, 400]) out.text[h][n] = vary(`t-${h}-${n}`, colors[h][n], colors[h][mirror[n]])
    for (const n of [800, 900, 950]) out.surface[h][n] = vary(`s-${h}-${n}`, colors[h][n], colors[h][mirror[n]])
  }
  // The current project's colour: violet is the accent everywhere, so every
  // violet shade is a variable, and <html data-tint="sky"> (useRootTint, lib/workspace.ts) points them at that hue.
  out.violet = {}
  const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  for (const n of shades) out.violet[n] = vary(`violet-${n}`, colors.violet[n], colors.violet[n])
  const base = { ":root": light, ".dark": dark }
  const tints = ["sky", "emerald", "amber", "rose", "orange", "teal", "pink"]
  for (const [sel, isDark] of [[":root", false], [".dark", true]])
    for (const h of tints) {
      const v = {}
      const pick = (n, m) => rgb(colors[h][isDark ? n : m])
      for (const n of shades) v[`--violet-${n}`] = pick(n, n)
      for (const n of [50, 100, 200, 300, 400]) v[`--t-violet-${n}`] = pick(n, mirror[n])
      for (const n of [800, 900, 950]) v[`--s-violet-${n}`] = pick(n, mirror[n])
      base[`${sel}[data-tint="${h}"]`] = v
    }
  return { ...out, base }
})()

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  // plug-ins (plugins/<id>) bring their own pages: their classes have to be generated too
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}', './plugins/**/*.{js,ts,jsx,tsx}', '!./plugins/**/node_modules/**'],
  theme: {
    extend: {
      colors: {
        zinc: themed.zinc,
        violet: themed.violet,
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
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
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
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      textColor: themed.text,
      backgroundColor: themed.surface,
      borderColor: themed.surface,
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
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
        "caret-blink": {
          "0%,70%,100%": { opacity: "1" },
          "20%,50%": { opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "caret-blink": "caret-blink 1.25s ease-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), plugin(({ addBase, addVariant }) => {
    addBase(themed.base);
    // where a scrollbar takes room (a mouse or trackpad; a phone draws it over the content): see index.css
    addVariant("bars", "@media (hover: hover) and (pointer: fine)");
    // Home's room (pages/ToolsetHome.tsx): the page's width after a docked chat, where the window's would overflow
    addVariant("hub", "@container hub (min-width: 900px)");
    addVariant("hub-2xl", "@container hub (min-width: 1536px)");
    addVariant("hub-narrow", "@container hub (max-width: 899.98px)");
  })],
}