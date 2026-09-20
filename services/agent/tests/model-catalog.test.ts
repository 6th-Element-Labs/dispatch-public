import { describe, expect, it } from 'vitest'
import { readConfigDefaults, readModelCatalog } from '../src/model-catalog.js'

const catalog = {
  data: [
    { id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }] },
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }] },
    { id: 'gpt-5.3-codex-spark', model: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'codex-auto-review', model: 'codex-auto-review', displayName: 'Codex Auto Review', hidden: true, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ],
}

const limits = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 1788754468 }, rateLimitReachedType: 'rate_limit_reached' },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: 1788754468 }, rateLimitReachedType: 'rate_limit_reached' },
    codex_bengalfox: { limitId: 'codex_bengalfox', primary: { usedPercent: 40, resetsAt: 1788675977 }, rateLimitReachedType: null },
    base_model_inference: { limitId: 'base_model_inference', limitName: 'gpt-reserve', primary: { usedPercent: 0, resetsAt: 1789252467 }, rateLimitReachedType: null },
  },
  rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'RateLimitResetCredit_x' }] },
}

describe('readModelCatalog', () => {
  it('joins the catalog with rate-limit buckets and labels the reserve model', () => {
    const result = readModelCatalog(catalog, limits, { config: { model: 'gpt-5.6-sol', model_reasoning_effort: 'medium' } })
    expect(result.defaults).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
    expect(result.rateLimitsError).toBeNull()
    expect(result.models).toEqual([
      { id: 'gpt-reserve', label: 'Luna Reserve', efforts: ['low', 'max'], exhausted: false, resetsAt: 1789252467 },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['medium', 'ultra'], exhausted: true, resetsAt: 1788754468 },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', efforts: ['low'], exhausted: false, resetsAt: 1788675977 },
    ])
  })

  it('never surfaces reset credits', () => {
    expect(JSON.stringify(readModelCatalog(catalog, limits, { config: { model: 'gpt-5.6-sol' } }))).not.toContain('RateLimitResetCredit')
  })

  it('marks a bucket exhausted at 100 percent even without a reached marker', () => {
    const result = readModelCatalog(catalog, { rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 100, resetsAt: null }, rateLimitReachedType: null } } }, { config: { model: 'gpt-5.6-sol' } })
    expect(result.models.find((model) => model.id === 'gpt-5.6-sol')).toMatchObject({ exhausted: true, resetsAt: null })
    expect(result.models.find((model) => model.id === 'gpt-reserve')).toMatchObject({ exhausted: null })
  })

  it('keeps the catalog visible when the rate-limit read failed', () => {
    const result = readModelCatalog(catalog, new Error('account/rateLimits/read timed out'), { config: { model: 'gpt-5.6-sol' } })
    expect(result.rateLimitsError).toBe('account/rateLimits/read timed out')
    expect(result.models.map((model) => model.exhausted)).toEqual([null, null, null])
  })

  it('rejects a catalog without models', () => {
    expect(() => readModelCatalog({ data: [] }, limits, { config: { model: 'gpt-5.6-sol' } })).toThrow('Codex App Server returned no models')
  })

  it('uses the effective Codex config as the picker default', () => {
    const result = readModelCatalog(catalog, limits, { config: { model: 'gpt-6-astra', model_reasoning_effort: 'xhigh' } })
    expect(result.defaults).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' })
  })

  it('keeps a hidden config-default model in the picker list', () => {
    const hiddenDefault = {
      data: [
        ...catalog.data,
        { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', hidden: true, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      ],
    }
    const result = readModelCatalog(hiddenDefault, limits, { config: { model: 'gpt-6-astra', model_reasoning_effort: 'medium' } })
    expect(result.models.find((model) => model.id === 'gpt-6-astra')).toMatchObject({ id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['medium'] })
  })

  it('falls back to the catalog isDefault model when config has no model', () => {
    const result = readModelCatalog(catalog, limits, { config: {} })
    expect(result.defaults).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
  })

  it('rejects a catalog that has no config model and no isDefault model', () => {
    const noDefault = { data: catalog.data.map((entry) => ({ ...entry, isDefault: false })) }
    expect(() => readModelCatalog(noDefault, limits, { config: {} })).toThrow('Codex App Server returned no default model')
  })
})

describe('readConfigDefaults', () => {
  it('reads model and effort from a config/read response', () => {
    expect(readConfigDefaults({
      config: { model: 'gpt-6-astra', model_reasoning_effort: 'medium' },
      origins: {},
    })).toEqual({ model: 'gpt-6-astra', effort: 'medium' })
  })

  it('returns undefined when config has no model', () => {
    expect(readConfigDefaults({ config: {}, origins: {} })).toBeUndefined()
  })
})
