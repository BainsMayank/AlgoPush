---
name: AlgoPush
description: A departure board for your solving — ruled, dense, already updated before you looked.
colors:
  ink: "#15120E"
  ink-raised: "#1C1813"
  ink-hover: "#241F18"
  rule: "#352E25"
  rule-hi: "#4B4236"
  board: "#F4F1EA"
  board-2: "#B0A695"
  board-3: "#8C8274"
  signal: "#FF5436"
  signal-deep: "#D8321E"
  on-signal: "#FFFFFF"
  state-idle: "#8C8274"
  state-working: "#E8A33A"
  state-live: "#5FB87C"
  state-fault: "#FF5436"
  line-lc: "#FFA116"
  line-cf: "#4A9EFF"
  line-ac: "#8FA3B8"
  line-cc: "#C4885A"
typography:
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "38px"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 78"
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.005em"
    fontVariation: "'wdth' 82"
  numeral-xl:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "62px"
    fontWeight: 600
    lineHeight: 0.8
    letterSpacing: "-0.03em"
    fontVariation: "'wdth' 112"
    fontFeature: "tabular-nums"
  numeral-lg:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "27px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0.14em"
    fontVariation: "'wdth' 112"
    fontFeature: "tabular-nums"
  numeral-sm:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
    fontVariation: "'wdth' 108"
    fontFeature: "tabular-nums"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.5
    fontVariation: "'wdth' 100"
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "'wdth' 100"
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.14em"
    fontVariation: "'wdth' 78"
  control:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.1em"
    fontVariation: "'wdth' 84"
rounded:
  none: "0"
spacing:
  hair: "2px"
  xs: "6px"
  sm: "8px"
  md: "11px"
  lg: "14px"
  xl: "18px"
  xxl: "26px"
  rail-x: "21px"
  gutter-l: "40px"
  gutter-r: "22px"
components:
  button-primary:
    backgroundColor: "{colors.board}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "0 15px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.signal-deep}"
    textColor: "#FFFFFF"
  button-primary-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.board-3}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.board-2}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "0 15px"
    height: "34px"
  button-ghost-hover:
    textColor: "{colors.board}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.board-3}"
    rounded: "{rounded.none}"
    size: "26px"
  input-text:
    backgroundColor: "{colors.ink-raised}"
    textColor: "{colors.board}"
    rounded: "{rounded.none}"
    padding: "0 10px"
    height: "34px"
  chip-line:
    backgroundColor: "{colors.line-lc}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    width: "30px"
    height: "21px"
  chip-line-sm:
    width: "25px"
    height: "17px"
  row-table:
    backgroundColor: "transparent"
    textColor: "{colors.board}"
    rounded: "{rounded.none}"
    padding: "11px 2px 11px 0"
  row-table-hover:
    backgroundColor: "{colors.ink-hover}"
  pad-cell:
    backgroundColor: "transparent"
    textColor: "{colors.board-3}"
    rounded: "{rounded.none}"
    padding: "0 3px 1px 0"
    height: "20px"
  pad-cell-on:
    backgroundColor: "{colors.board}"
    textColor: "{colors.ink}"
  alert-band:
    backgroundColor: "transparent"
    textColor: "{colors.state-fault}"
    rounded: "{rounded.none}"
    padding: "9px 7px 9px 11px"
---

# Design System: AlgoPush

## Overview

**Creative North Star: "The Service Board"**

AlgoPush is posted, not displayed. The register is Japanese public-information design — the
station departure panel, the contest information board: warm ink ground, hairline rules, dense
condensed caps, and large tabular numerals that were already correct before anyone walked up to
read them. The product's promise is that nothing is asked of the user, so the interface behaves
like infrastructure that has been running all along rather than an app awaiting input.

Everything separates by line. There are no cards, no panels with backgrounds, no padding boxes,
no shadows, no gradients as surface, and no corner radius anywhere (radius is explicitly `0` on
every control). A row sits directly on the rule above it; a section is announced by a condensed
caps title and a hairline, not by a container. A single fixed hairline rail runs the full height
of the popup at 21px from the left edge, and every screen registers its content against it.

One typeface carries the whole system: Archivo, self-hosted as a variable font (latin subset,
`wdth` 62–125, `wght` 100–900). The width axis does the work a second family would otherwise do —
condensed for caps labels, normal for body, expanded for the big numerals. Confirmed rejections:
the extension-popup default of stacked white cards with a blue primary button, and the CP-tool
default of neon-on-black terminal cosplay. There is no dashboard chrome and no sparkline.

**Key Characteristics:**
- Warm ink ground (`#15120E`) under every OS theme; no light mode, on purpose.
- Hairline rules separate; boxes, cards, and shadows never do.
- Zero radius everywhere, stated explicitly rather than inherited.
- One variable typeface, three width stations (78 / 100 / 112).
- Judge colours are line identities on chips only, never buttons or fills.
- Red is reserved: setup marker, today's cell, focus ring, alert.
- State carries a shape and a word, never colour alone.
- Values snap; only the rail fill and the screen slide move continuously.

## Colors

A warm near-black ground with bone-white board ink, one signage red, a four-mark state set, and
four borrowed line identities — nothing is decorative.

### Primary
- **Signage Red** (`#FF5436`, deep `#D8321E`): The active setup marker on the rail, today's cell
  on the streak pad, every focus ring, the caret, the selection highlight, the fault mark and the
  alert band, and the primary button's hover ground. It appears nowhere else.

### Secondary
- **Service States** (idle `#8C8274`, working `#E8A33A`, live `#5FB87C`, fault `#FF5436`): The
  four-state connection vocabulary. Each colour is paired with a distinct mark shape and a word;
  the colour is the third signal, never the first.

### Tertiary
- **Line Identities** (LeetCode `#FFA116`, Codeforces `#4A9EFF`, AtCoder `#8FA3B8`, CodeChef
  `#C4885A`): Each judge's own colour, borrowed the way a transit map borrows a line colour. Each
  renders only as a filled chip carrying a two-letter code (LC / CF / AC / CC) in ink lettering.

### Neutral
- **Ink** (`#15120E`): The ground of the popup and of the browser scrollbar track. Also the
  lettering colour inside every line chip and on every filled cell.
- **Raised Ink** (`#1C1813`): Input and select fields — the only tonal step in the system, and it
  exists to mark an editable well, not to lift a surface.
- **Hover Ink** (`#241F18`): The wash under a hovered table row.
- **Rule** (`#352E25`): Every separator in the system, at exactly 1px.
- **Rule Highlight** (`#4B4236`): Drawn borders that are part of a control rather than a
  separator — the rail spine, field borders, the entry frame, the unchecked tick, scrollbar thumb.
- **Board** (`#F4F1EA`): Primary text, the primary button ground, a filled streak cell.
- **Board 2** (`#B0A695`): Secondary prose — notes, promises, status lines.
- **Board 3** (`#8C8274`): Labels, meta, timestamps, and dimmed out-of-service rows.

### Named Rules
**The Line Identity Rule.** A judge's colour may appear only as a filled chip with ink lettering.
It is never a button, a background, a text colour, a border, or a fill of any other kind. Adding a
fifth judge means adding a chip colour and nothing else.

**The Reserved Red Rule.** `signal` / `signal-deep` belongs to four things only: the setup
progress marker, today's cell on the streak pad, focus rings and caret, and fault/alert. A red
that means anything else is a bug.

**The No Light Mode Rule.** The popup is the ink board under every OS theme. There is no
`prefers-color-scheme: light` branch; `color-scheme: dark` is declared on `:root` so the browser's
own surfaces match. (See Do's and Don'ts for the disclosed product consequence.)

**The Browser-Surface Rule.** Selection, scrollbar track, scrollbar thumb, caret and focus ring
are themed from this palette. Surfaces the browser draws are part of the board.

## Typography

**Display Font:** Archivo Variable (self-hosted `fonts/archivo-var.woff2`, latin subset, `wdth`
62–125, `wght` 100–900; fallback `system-ui, sans-serif`)
**Body Font:** Archivo Variable — the same file at `wdth` 100
**Label/Numeral Font:** Archivo Variable — the same file at `wdth` 78 and `wdth` 108–112

**Character:** One grotesque, three width stations. Condensed caps read as posted signage,
normal width reads as plain service prose, and the expanded tabular numerals read as the panel's
count — the width axis, not a second family, creates the whole hierarchy.

### Hierarchy
- **Display** (700, 38px, 1.02, `wdth` 78, uppercase): The entry quote only; three hard-broken
  lines inside the hairline frame.
- **Headline** (700, 23px, 1.08, `wdth` 82, uppercase): Onboarding step titles.
- **Numeral XL** (600, 62px, 0.8, `wdth` 112, tabular): The board's running total. Sits on the
  baseline of its caps label.
- **Numeral LG** (600, 27px, `wdth` 112, tabular, tracked 0.14em): The GitHub device code — set
  wide so it can be read off the screen and typed elsewhere.
- **Numeral SM** (600, 15px, `wdth` 108, tabular, right-aligned in a 34px column): Per-judge counts.
- **Title** (600, 13.5px, `wdth` 100): Row names — a judge, a connection, an identity.
- **Body** (400, 12.5px, 1.5, `wdth` 100): The document default. Notes and promises set at
  12–12.5px with `text-wrap: pretty`.
- **Label** (600, 11px, `wdth` 78, uppercase, tracked 0.10–0.20em): Every caps label — section
  titles, field labels, state words, the vertical step count, the wordmark (tracked 0.2em), pad
  day letters.
- **Control** (700, 11px, `wdth` 84, uppercase, tracked 0.1em): Button and repo-link lettering.

### Named Rules
**The One Face Rule.** Archivo is the entire type system. A new role reaches for the `wdth` axis
(78 condensed / 100 normal / 108–112 expanded) before it reaches for another family, a mono, or a
system display face.

**The Eleven Pixel Floor Rule.** No functional text is set below 11px. 11px is the label size, not
a minimum to shave; anything smaller is out of the system.

**The Tabular Numeral Rule.** Every number that can change — total, per-judge count, device code,
streak date, arrival time — is `font-variant-numeric: tabular-nums`. Digits must not reflow when
they update.

## Layout

The popup is a fixed 400px-wide panel with a `min-height` of 320px and a `max-height` of 580px,
scrolling vertically only. Five screens (entry, three setup steps, the board) occupy the same
frame one at a time; only one is ever unhidden.

**The rail** is the spatial spine: a fixed 1px line at `left: 21px`, full height, always drawn.
Standard screens use asymmetric gutters — 40px left, 22px right, 18px top, 20px bottom — so
content clears the rail with a consistent channel. The entry screen alone insets to
`calc(21px + 13px)` on the left and 13px elsewhere, because its hairline frame is what registers
against the rail there.

**Vertical rhythm** is set by rules, not by a spacing scale: the repeating unit is a row with
7–12px vertical padding on a 1px bottom rule, grouped into blocks with 13px of top padding and a
9px gap under the condensed caps block title. Larger gaps (18px, 26px) appear only between a step
head and its body and inside the entry frame. The step actions bar is separated by 16px of padding
above a 1px rule.

**The streak pad** is the only grid: 7 equal columns, 2px gaps, 20px-tall cells — a dated cell
grid rather than a number.

There is no responsive behavior. The panel width is fixed by the browser-action surface; blocks
collapse to hidden rather than reflowing, and the arrivals list drops its own head rule when the
blocks above it are empty so two rules never stack.

## Elevation & Depth

**There is no elevation.** No `box-shadow` exists anywhere in the system — no ambient shadow, no
offset shadow, no glow, no blur, no gradient used as a surface, and no scrim. Depth is not
simulated at all: this is a printed board, and a board has one plane.

Hierarchy is produced by three devices instead. Rule weight (`rule` for separators, `rule-hi` for
drawn control borders) distinguishes a division from an object. Text colour steps
(`board` → `board-2` → `board-3`) push secondary content back without moving it. And inversion —
board-white ground with ink lettering — is how an element comes forward: the primary button, a
checked tick, a filled streak cell, and every line chip are all the same move.

### Named Rules
**The One Plane Rule.** Nothing floats. If an element needs emphasis, invert it or rule it; never
lift it. A shadow of any kind is outside this system.

## Shapes

Every corner is square. `border-radius: 0` is set explicitly on buttons and fields rather than
left to the user agent, and no other value appears in the stylesheet.

The recurring forms are all rectangles at hairline weight: the 1px rule, the 1px-bordered frame
(entry frame, device-code block, alert band), the 9px state mark at 1.5px stroke, the 17px tick
box, the 20px pad cell, and the 30×21 / 25×17 line chip. Icons are stroked, never filled: 13px
box, 1.5px `currentColor` stroke, round caps and joins, drawn from a four-symbol inline SVG sprite
(gear, external, back, close) — no icon font and no glyph characters.

The one non-rectangular marks in the system are diagonal and deliberate: the select's caret is
two 5px linear-gradient triangles, the checked tick is a rotated 1.8px L, the working mark is a
half-fill clip, and the fault mark is a 45° ink strike across a filled square.

### Named Rules
**The Zero Radius Rule.** Nothing in this system is rounded. A radius anywhere is a defect, not a
variant.

**The Rule, Not The Box Rule.** Separation is a 1px `rule` line. A new grouping gets a caps title
and a hairline; it does not get a bordered container, a tinted panel, or padding standing in for
a boundary.

## Components

### Buttons
- **Shape:** Perfectly square (0 radius), 34px minimum height, 15px horizontal padding, 1px
  transparent border held in reserve so state changes never shift layout.
- **Primary:** Board-white ground with ink lettering, 11px condensed caps (`wdth` 84, 700, 0.1em).
  Hover inverts to signage red with white lettering. Disabled drops the fill entirely: transparent
  ground, `rule` border, `board-3` lettering.
- **Ghost:** Transparent with a `board-3` border and `board-2` lettering; hover lifts both one
  step toward board-white. Disabled drops the border to `rule`.
- **Transitions:** 110ms linear on colour properties only. No transform, no scale, no lift.
- **Icon button:** 26px square, transparent, `board-3` icon; hover brings the icon to board-white
  and reveals a `rule-hi` border. The alert variant is 20px and stays fault-red throughout.

### Chips
- **Style:** A filled rectangle 30×21 (25×17 in dense lists) carrying the judge's two-letter code
  in 11px semi-condensed caps at `wdth` 84, weight 700, tracked 0.06em, lettered in ink
  (`#15120E`). The fill comes from a per-instance `--chip` custom property set from the platform
  record; the fallback is `board-3`.
- **State:** An out-of-service row dims its chip to 45% opacity. Chips are never interactive and
  never gain a border, a radius, or a hover state.

### Inputs / Fields
- **Style:** Raised-ink well with a 1px `rule-hi` border, 0 radius, 34px tall, 10px horizontal
  padding, 12px body text; placeholder in `board-3`; caret in signage red. Labels sit above in
  11px condensed caps tracked 0.14em.
- **Select:** Same well with native appearance removed; the caret is two 5px gradient triangles
  drawn in `board-2` at the right edge.
- **Focus:** A 2px signage-red outline offset 2px — the global `:focus-visible` treatment, applied
  uniformly to every focusable element including the visually-hidden line checkboxes, which
  project the ring onto their tick box.
- **Hover:** Border steps from `rule-hi` to `board-3`. Nothing else moves.

### Cards / Containers
There are no cards. The three bordered blocks that exist — the entry frame, the device-code block,
and the alert band — are hairline frames: 1px border, no fill, no radius, no shadow. The entry
frame is `rule-hi`; the alert band is fault-red with fault-red body text.

### Navigation
Screen-to-screen movement is the navigation. A screen enters with an 180ms slide from 10px right
plus a fade, on `cubic-bezier(0.16, 1, 0.3, 1)`. The setup step number is set vertically along the
rail (`writing-mode: vertical-rl`, rotated) rather than stacked over the heading, with the active
step's word in signage red.

### The Rail
A fixed 1px `rule-hi` spine at x=21px, present on every screen, with a 3px signage-red fill that
scales from the top over 340ms on the exponential ease-out.

**The Setup Progress Rule.** The rail's fill is setup progress and nothing else: 0 at entry,
33 / 66 / 100 across the three setup steps, and **0 on the steady-state board**. The board's rail
is deliberately empty. Painting it by service state was built and removed in review — it breaks
the reserved-red law and reads as a dashboard.

### State Marks
A 9px square with a 1.5px `currentColor` border, carrying four states that differ by **shape**
first: idle is a hollow square, working is a half-fill clipped down the vertical centre, live is
a solid fill, and fault is a solid fill with a 45° ink strike through it. Each is paired with a
word ("Not connected", "Connecting", "Watching", "Needs attention") in 11px condensed caps.

**The Shape-And-Word Rule.** Connection and sync state must be legible with colour removed. A new
state needs a distinct mark shape and its own word before it gets a colour. This is an
accessibility requirement, not a stylistic preference.

### Streak Pad
Seven columns of 20px cells with 2px gaps, each cell a 1px `rule` outline with its date
bottom-right in 11px tabular figures. A solved day inverts to board-white with ink figures. Today
carries a 1.5px signage-red outline inset by 1.5px, so the marker never enlarges the cell. A cell
outside the range drops its border to transparent rather than disappearing, preserving the grid.

### Arrivals Row and the Row Strike
An arrivals row is a chip, an ellipsized title and a tabular time on a 1px bottom rule with 8px of
vertical padding. A row that landed since the user last looked runs the signature interaction:

**The Row Strike Rule.** A newly arrived sync flashes a red wash and clears it in exactly two hard
frames — `animation: strike 620ms steps(2, end)`. It is a turnover, never a fade. Any future
arrival, confirmation, or state landing uses `steps()`, not a tween.

### Motion
Values snap. Only two things move continuously — the rail fill (340ms) and the screen slide
(180ms) — both on `cubic-bezier(0.16, 1, 0.3, 1)`. Control state changes are 110ms linear colour
crossfades with no transform. Under `prefers-reduced-motion: reduce`, the slide, the strike, and
the rail transition are all removed and the values simply snap into place.

## Do's and Don'ts

### Do:
- **Do** separate with a 1px `rule` hairline and a condensed caps title. That is the grouping
  device for this system.
- **Do** set every new role from Archivo's `wdth` axis — 78 for caps labels, 100 for body,
  108–112 for tabular numerals.
- **Do** keep functional text at 11px or larger.
- **Do** give every state a mark shape and a word before you give it a colour.
- **Do** invert (board ground, ink lettering) when an element must come forward.
- **Do** make numbers tabular so they do not reflow on update.
- **Do** theme the browser's own surfaces — selection, scrollbar, caret, focus ring — from this
  palette.
- **Do** end every motion on a snap; reserve continuous movement for the rail fill and the screen
  slide, and honour `prefers-reduced-motion`.
- **Do** treat the rail's red fill as setup progress only, and leave it empty on the board.

### Don't:
- **Don't** add a border-radius. Zero is the value, everywhere.
- **Don't** add a shadow, glow, blur, scrim, or gradient used as a surface. There is one plane.
- **Don't** build a card. A bordered, padded, tinted container is not in this system; the three
  hairline frames that exist are frames, not cards.
- **Don't** let a judge colour become a button, a background, a text colour, or a row rule. Chips
  only.
- **Don't** spend signage red on anything but the setup marker, today's cell, focus/caret, and
  fault or alert.
- **Don't** introduce a second typeface, a mono face, or a system display face.
- **Don't** carry status by colour alone.
- **Don't** fade a value change. Snapping, or a hard `steps()` turnover, is the grammar.
- **Don't** add a light-mode palette. The popup is the ink board under every OS theme.
- **Don't** "fix" a judge row sitting flush against its table's head rule. A row sitting directly
  on the head rule is the committed grammar of this world, and the row supplies its own 11px
  inset. The `cramped-padding` reading of that `<fieldset>` was reviewed and ruled wrong here.

### Recorded decisions
1. **No light mode, on purpose.** A `prefers-color-scheme: light` palette was built and deleted in
   review: it inverted the committed ground with no product justification, and its hardcoded chip
   lettering failed WCAG AA on three of the four judge colours. The previous popup was
   light-by-default with a dark variant, so **this changes the default appearance for light-OS
   users** — a disclosed product decision the user may overrule, and one that belongs in the store
   update note.
2. **Known headroom, deliberately unreached in this run.** (a) Every separator is the same 1px
   `rule`, where this world's source material grades a heavier head rule against hairline row
   rules. (b) The judge line-colours never reach the row rules; they appear only as chips, where
   the direction contract allowed row rules too. Both are opportunities for a future pass, not
   defects.

### Recorded divergences from the direction contract
The build is the truth; where it differs from the contract, the built value is normative.
- Board white shipped as `#F4F1EA`, not the contract's `#F2EEE6`.
- The popup is 400px wide, not 380px.
- The entry quote is 38px, not ~30px, and its promise line is 12.5px body prose, not 11px caps.
- Line colours appear as chips only; the contract also allowed them as row rules.
