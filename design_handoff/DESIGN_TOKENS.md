# Design Tokens — Apex Automata

All values below are canonical. They live in `source/styles2.css` and should be ported into `src/index.css` (CSS vars) and `tailwind.config.ts` (Tailwind theme extension).

## Color — Neutrals (Obsidian stack)

Dark only. Cool blue-black temperature.

| Token    | Hex       | Use                             | Tailwind alias          |
|----------|-----------|---------------------------------|-------------------------|
| `--bg-0` | `#06080c` | Page background (deepest)       | `bg-obsidian-0`         |
| `--bg-1` | `#0a0d14` | Panel background                | `bg-obsidian-1`         |
| `--bg-2` | `#0f131c` | Elevated surface / inputs       | `bg-obsidian-2`         |
| `--bg-3` | `#151a25` | Hover                           | `bg-obsidian-3`         |
| `--bg-4` | `#1d2431` | Pressed / focused border highlight | `bg-obsidian-4`       |
| `--line` | `#1a2030` | Dividers, panel borders         | `border-obsidian-line`  |
| `--line-2` | `#222a3b` | Stronger dividers / input borders | `border-obsidian-line-2` |

## Color — Foreground

| Token    | Hex       | Use                             |
|----------|-----------|---------------------------------|
| `--fg-0` | `#e8ecf2` | Primary text (headings, values) |
| `--fg-1` | `#aeb7c6` | Secondary text                  |
| `--fg-2` | `#6a7588` | Tertiary (labels, captions)     |
| `--fg-3` | `#454f61` | Quiet / disabled                |

## Color — Semantic

| Token         | Hex                      | Use                         |
|---------------|--------------------------|-----------------------------|
| `--up`        | `#39d98a`                | Gains, long, success        |
| `--up-glow`   | `rgba(57,217,138,0.28)`  | Glow shadow for up elements |
| `--down`      | `#ff5a6a`                | Losses, short, danger       |
| `--down-glow` | `rgba(255,90,106,0.28)`  | Glow shadow for down        |
| `--warn`      | `#ffb020`                | Warning / pending           |
| `--info`      | `#7aa4ff`                | Informational               |

## Color — Accent (electric blue default)

User can pick 4 variants via tweaks, but **default is electric**. Ship all four as themes:

```
[data-accent="electric"] → #3b82f6 / #60a5fa   (default)
[data-accent="emerald"]  → #10b981 / #34d399
[data-accent="amber"]    → #ff8a1f / #ffb24a
[data-accent="violet"]   → #8b5cf6 / #a78bfa
```

Per theme:
- `--accent`       primary accent
- `--accent-2`     hover / lighter variant (used for gradient top stops)
- `--accent-ink`   text color on accent background (e.g. `#eaf1ff` for electric)
- `--accent-glow`  `rgba(..., 0.35)` for shadows
- `--accent-soft`  `rgba(..., 0.12)` for tinted backgrounds

## Typography

Three families, loaded from Google Fonts:

```html
https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700
&family=Geist+Mono:wght@300;400;500;600;700
&family=Instrument+Serif:ital@0;1
```

| Token     | Stack                                             | Use                                           |
|-----------|---------------------------------------------------|-----------------------------------------------|
| `--f-sans`  | `Geist, ui-sans-serif, system-ui, sans-serif`     | Default body and UI                           |
| `--f-mono`  | `Geist Mono, ui-monospace, Menlo, monospace`      | **All numbers**, labels, code, status strings |
| `--f-serif` | `Instrument Serif, ui-serif, Georgia, serif`      | Editorial hero headlines (use italic)         |

Tabular figures enabled globally: `font-variant-numeric: tabular-nums; font-feature-settings: "tnum"`.

### Type scale (as used)

| Use                         | Size   | Weight | Family |
|-----------------------------|--------|--------|--------|
| Hero serif italic           | 38–60px | 500   | serif  |
| Display mono (big numbers)  | 28–60px | 500   | mono   |
| Page title (top bar)        | 13px   | 500    | sans   |
| Section heading             | 16px   | 600    | sans   |
| Body                        | 13px   | 400    | sans   |
| Body small                  | 12px   | 400    | sans   |
| Table cell                  | 12.5px | 400    | sans (numbers → mono) |
| Label (ALL CAPS)            | 10px   | 500    | mono, tracking 0.09em |
| Label-sm                    | 9px    | 500    | mono, tracking 0.12em |
| Ticker price                | 12px   | 500    | mono |
| Status string (e.g. `LIVE · 43ms`) | 11px | 500 | mono |
| kbd (keyboard hint)         | 10px   | 500    | mono |

All numbers everywhere are `mono` with tabular-nums.

## Spacing scale

Built around an 8px rhythm but with 2/4/6/10 half-steps.

| Name      | Value  |
|-----------|--------|
| `--gap-sm`  | 10px (compact: 6)  |
| `--gap`     | 16px (compact: 10) |
| `--gap-lg`  | 24px (compact: 14) |
| Common paddings | panel header `12px 16px`, panel body `16px 20px` on pages, cards `14px` |

Density modes:
- `comfortable` (default): `--gap: 16px`, `--row-h: 36px`
- `compact`: `--gap: 10px`, `--row-h: 28px`

## Radius

| Token          | Value | Use                             |
|----------------|-------|---------------------------------|
| `--radius`     | 6px   | Buttons, inputs, small cards    |
| `--radius-lg`  | 10px  | Panels, modals                  |

## Shadows / effects

- `--shadow-panel`: `0 1px 0 rgba(255,255,255,0.02) inset, 0 20px 40px -20px rgba(0,0,0,0.6)` (subtle; only on raised panels)
- Accent button glow: `0 0 0 1px var(--accent), 0 8px 20px -6px var(--accent-glow)`
- Live dot halo: `box-shadow: 0 0 0 3px rgba(57,217,138,0.2)` + pulsing animation (1.6s)
- Number flash on change: color `var(--up)` or `var(--down)` for 500ms

## Tailwind config additions

Add to `tailwind.config.ts`:

```ts
theme: {
  extend: {
    colors: {
      obsidian: {
        0: '#06080c',
        1: '#0a0d14',
        2: '#0f131c',
        3: '#151a25',
        4: '#1d2431',
        line: '#1a2030',
        'line-2': '#222a3b',
      },
      fg: {
        0: '#e8ecf2',
        1: '#aeb7c6',
        2: '#6a7588',
        3: '#454f61',
      },
      up: { DEFAULT: '#39d98a' },
      down: { DEFAULT: '#ff5a6a' },
      warn: { DEFAULT: '#ffb020' },
      info: { DEFAULT: '#7aa4ff' },
      accent: {
        DEFAULT: 'hsl(var(--accent))',
        2: 'hsl(var(--accent-2))',
        ink: 'hsl(var(--accent-ink))',
      },
    },
    fontFamily: {
      sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      mono: ['"Geist Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      serif: ['"Instrument Serif"', 'ui-serif', 'Georgia', 'serif'],
    },
    fontSize: {
      '2xs': ['10px', { lineHeight: '1.2' }],
      '3xs': ['9px', { lineHeight: '1.2' }],
    },
    boxShadow: {
      panel: '0 1px 0 rgba(255,255,255,0.02) inset, 0 20px 40px -20px rgba(0,0,0,0.6)',
      'accent-glow': '0 0 0 1px hsl(var(--accent)), 0 8px 20px -6px hsl(var(--accent-glow))',
    },
    animation: {
      'live-pulse': 'live-pulse 1.6s ease-in-out infinite',
      'flash-up': 'flash-color 500ms ease',
      'flash-down': 'flash-color 500ms ease',
      'ticker': 'ticker 60s linear infinite',
    },
    keyframes: {
      'live-pulse': {
        '0%, 100%': { boxShadow: '0 0 0 3px rgba(57,217,138,0.2)' },
        '50%':      { boxShadow: '0 0 0 5px rgba(57,217,138,0.28)' },
      },
      ticker: {
        '0%':   { transform: 'translateX(0)' },
        '100%': { transform: 'translateX(-50%)' },
      },
    },
  },
},
```

## Global CSS additions

Keep the base in `index.css`:

```css
body {
  background: #06080c;
  color: #e8ecf2;
  font-family: 'Geist', ui-sans-serif, system-ui;
  font-feature-settings: "cv11", "ss01", "ss03";
  font-variant-numeric: tabular-nums;
}
.mono { font-family: 'Geist Mono', ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.serif-ital { font-family: 'Instrument Serif', ui-serif, Georgia, serif; font-style: italic; }

/* Scrollbar */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #151a25; border: 2px solid #06080c; border-radius: 10px; }
::-webkit-scrollbar-thumb:hover { background: #1d2431; }
```

See `source/styles2.css` for the full CSS (includes `.panel`, `.btn`, `.pill`, `.nav-item`, `.ticker-track`, `.gridbg`, `.scanlines` helpers). Port whichever helpers help; prefer Tailwind class composition where possible.
