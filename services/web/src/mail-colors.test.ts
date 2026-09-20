import { describe, expect, it } from 'vitest'
import { DARK_SURFACE, contrast, darkTextColor, isLightBackground, parseColor, rewriteStyleForDark } from './mail-colors.js'

describe('parseColor', () => {
  it('reads hex, rgb, and common names', () => {
    expect(parseColor('#1F497D')).toEqual({ r: 31, g: 73, b: 125, a: 1 })
    expect(parseColor('#333')).toEqual({ r: 51, g: 51, b: 51, a: 1 })
    expect(parseColor('rgb(228, 0, 43)')).toEqual({ r: 228, g: 0, b: 43, a: 1 })
    expect(parseColor('rgba(0,0,0,0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
    expect(parseColor('navy')).toEqual({ r: 0, g: 0, b: 128, a: 1 })
    expect(parseColor('transparent')?.a).toBe(0)
  })
  it('ignores what it cannot read', () => {
    expect(parseColor('inherit')).toBeNull()
    expect(parseColor('var(--x)')).toBeNull()
    expect(parseColor('#12')).toBeNull()
  })
})

describe('darkTextColor', () => {
  it('drops near-black and dark grey so the theme colour shows through', () => {
    expect(darkTextColor('#000000')).toEqual({ action: 'drop' })
    expect(darkTextColor('#333333')).toEqual({ action: 'drop' })
    expect(darkTextColor('#666')).toEqual({ action: 'drop' })
    expect(darkTextColor('rgb(85,85,85)')).toEqual({ action: 'drop' })
  })
  it('keeps light greys used as muted text', () => {
    expect(darkTextColor('#aaaaaa')).toEqual({ action: 'keep' })
    expect(darkTextColor('#ffffff')).toEqual({ action: 'keep' })
  })
  it('keeps saturated colours that already read on the dark surface', () => {
    expect(darkTextColor('#e4002b')).toEqual({ action: 'keep' })
    expect(darkTextColor('#ffa500')).toEqual({ action: 'keep' })
  })
  it('lightens dark saturated colours until they read', () => {
    const navy = darkTextColor('#1F497D')
    expect(navy.action).toBe('replace')
    if (navy.action === 'replace') {
      const lifted = parseColor(navy.value)!
      expect(contrast(lifted, DARK_SURFACE)).toBeGreaterThanOrEqual(3.5)
      expect(lifted.b).toBeGreaterThan(lifted.r)
    }
  })
  it('leaves unparsable values alone', () => {
    expect(darkTextColor('inherit')).toEqual({ action: 'keep' })
  })
})

describe('isLightBackground', () => {
  it('treats white, near-white and transparent as paper', () => {
    expect(isLightBackground('#ffffff')).toBe(true)
    expect(isLightBackground('#f4f4f4')).toBe(true)
    expect(isLightBackground('transparent')).toBe(true)
  })
  it('treats coloured and dark backgrounds as layout', () => {
    expect(isLightBackground('#1F497D')).toBe(false)
    expect(isLightBackground('#e4002b')).toBe(false)
  })
})

describe('rewriteStyleForDark', () => {
  it('rewrites an Outlook reply style', () => {
    const result = rewriteStyleForDark('font-family: Calibri; color: #1F497D; font-size: 11pt')
    expect(result.layoutBackground).toBe(false)
    expect(result.style).toMatch(/^font-family: Calibri; color: #[0-9a-f]{6}; font-size: 11pt$/)
    expect(result.style).not.toContain('#1F497D')
  })
  it('drops grey text and white backgrounds', () => {
    const result = rewriteStyleForDark('color:#333; background-color:#ffffff; padding:4px')
    expect(result.style).toBe('padding:4px')
    expect(result.layoutBackground).toBe(false)
  })
  it('keeps a coloured background and reports it as layout', () => {
    const result = rewriteStyleForDark('background: #e4002b; color: #fff')
    expect(result.style).toBe('background: #e4002b; color: #fff')
    expect(result.layoutBackground).toBe(true)
  })
  it('keeps background images and reports them as layout', () => {
    const result = rewriteStyleForDark('background: url(https://x/y.png) no-repeat')
    expect(result.layoutBackground).toBe(true)
    expect(result.style).toContain('url(')
  })
  it('keeps !important text colours that already read', () => {
    expect(rewriteStyleForDark('color: #e4002b !important').style).toBe('color: #e4002b !important')
  })
})
