/**
 * Colour rules for rendering provider HTML in dark mode.
 *
 * Mail almost never declares a background but often declares text colour
 * (Outlook navy, signature greys, brand reds). Rather than bail out to a white
 * card whenever any colour appears, rewrite the inline colours the way Apple
 * Mail does: near-black and grey text inherits the theme colour, saturated
 * colours stay but are lightened until they read on the dark surface, light
 * backgrounds are dropped. Real layouts (coloured backgrounds, image-heavy
 * mail) are classified separately and keep a light surface.
 */

export interface Rgb { r: number; g: number; b: number; a: number }

/** The dark reader surface every rewritten colour is checked against. */
export const DARK_SURFACE: Rgb = { r: 28, g: 28, b: 31, a: 1 }
const MIN_CONTRAST = 3.5

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  dimgray: '#696969', dimgrey: '#696969', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5',
  red: '#ff0000', maroon: '#800000', darkred: '#8b0000', crimson: '#dc143c', firebrick: '#b22222',
  blue: '#0000ff', navy: '#000080', darkblue: '#00008b', royalblue: '#4169e1', steelblue: '#4682b4', dodgerblue: '#1e90ff',
  green: '#008000', darkgreen: '#006400', forestgreen: '#228b22', seagreen: '#2e8b57', teal: '#008080',
  orange: '#ffa500', darkorange: '#ff8c00', gold: '#ffd700', yellow: '#ffff00', purple: '#800080', indigo: '#4b0082',
  brown: '#a52a2a', chocolate: '#d2691e', sienna: '#a0522d', olive: '#808000', magenta: '#ff00ff', fuchsia: '#ff00ff',
}

export function parseColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase()
  if (!text || text === 'inherit' || text === 'initial' || text === 'currentcolor' || text === 'unset') return null
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const named = NAMED[text]
  if (named) return parseColor(named)
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)
  if (hex) {
    const h = hex[1]!
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map((c) => parseInt(c + c, 16))
      return { r: r!, g: g!, b: b!, a: h.length === 4 ? a! / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
    }
    return null
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/.exec(text)
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
    return { r: clamp(parseFloat(rgb[1]!)), g: clamp(parseFloat(rgb[2]!)), b: clamp(parseFloat(rgb[3]!)), a: alpha }
  }
  return null
}

function clamp(n: number): number { return Math.max(0, Math.min(255, Math.round(n))) }

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a); const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export function toHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255; const g = c.g / 255; const b = c.b / 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

export function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) { const v = clamp(l * 255); return { r: v, g: v, b: v, a: 1 } }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: clamp(hue(h + 1 / 3) * 255), g: clamp(hue(h) * 255), b: clamp(hue(h - 1 / 3) * 255), a: 1 }
}

export function toCss(c: Rgb): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
}

export type ColorDecision = { action: 'keep' } | { action: 'drop' } | { action: 'replace'; value: string }

/** Text colour on the dark surface: greys inherit, dark saturated colours lighten, readable colours stay. */
export function darkTextColor(value: string): ColorDecision {
  const c = parseColor(value)
  if (!c) return { action: 'keep' }
  if (c.a === 0) return { action: 'keep' }
  const { h, s, l } = toHsl(c)
  if (s < 0.12) return l < 0.62 ? { action: 'drop' } : { action: 'keep' }
  if (contrast(c, DARK_SURFACE) >= MIN_CONTRAST) return { action: 'keep' }
  let light = l
  let candidate = c
  while (light < 0.86 && contrast(candidate, DARK_SURFACE) < MIN_CONTRAST) {
    light += 0.04
    candidate = fromHsl(h, s, light)
  }
  return { action: 'replace', value: toCss(candidate) }
}

/** A background is light when it would read as paper: white, near-white, or transparent. */
export function isLightBackground(value: string): boolean {
  const c = parseColor(value)
  if (!c) return false
  if (c.a === 0) return true
  return toHsl(c).l > 0.82
}

/** Rewrite one inline style for the dark surface. Returns the new style and whether it carries a real (non-light) background. */
export function rewriteStyleForDark(style: string): { style: string; layoutBackground: boolean } {
  let layoutBackground = false
  const out: string[] = []
  for (const declaration of splitDeclarations(style)) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const raw = declaration.slice(colon + 1).trim()
    const value = raw.replace(/\s*!important$/i, '')
    if (property === 'color') {
      const decision = darkTextColor(value)
      if (decision.action === 'drop') continue
      if (decision.action === 'replace') { out.push(`color: ${decision.value}`); continue }
      out.push(declaration.trim()); continue
    }
    if (property === 'background-color' || property === 'background') {
      if (/url\(|gradient\(/i.test(value)) { layoutBackground = true; out.push(declaration.trim()); continue }
      const colorPart = property === 'background' ? value.split(/\s+/).find((part) => parseColor(part)) ?? value : value
      if (isLightBackground(colorPart)) continue
      if (parseColor(colorPart)) layoutBackground = true
      out.push(declaration.trim()); continue
    }
    out.push(declaration.trim())
  }
  return { style: out.join('; '), layoutBackground }
}

function splitDeclarations(style: string): string[] {
  const parts: string[] = []
  let depth = 0; let current = ''
  for (const ch of style) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts
}
