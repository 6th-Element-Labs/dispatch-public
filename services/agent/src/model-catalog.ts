/**
 * Joins the Codex App Server model catalog with the account's usage buckets so
 * the thin client can offer only models the account can still run.
 *
 * The catalog does not say which metered bucket a model draws from, so the
 * mapping is fixed here from observed `account/rateLimits/read` payloads.
 * Reset credits are deliberately not read or surfaced.
 */

export interface DispatchDefaults {
  readonly model: string
  readonly effort: string
}

export interface DispatchModel {
  readonly id: string
  readonly label: string
  readonly efforts: readonly string[]
  /** null when the bucket state is unknown (rate-limit read failed or no bucket reported). */
  readonly exhausted: boolean | null
  /** Epoch seconds when the bucket's primary window resets, when known. */
  readonly resetsAt: number | null
}

export interface DispatchModelCatalog {
  readonly models: readonly DispatchModel[]
  readonly defaults: DispatchDefaults
  readonly rateLimitsError: string | null
}

const RESERVE_MODEL = 'gpt-reserve'
const NEVER_LISTED = new Set(['codex-auto-review'])
const LABELS: Record<string, string> = { [RESERVE_MODEL]: 'Luna Reserve' }
const BUCKETS: Record<string, string> = { [RESERVE_MODEL]: 'base_model_inference', 'gpt-5.3-codex-spark': 'codex_bengalfox' }
const DEFAULT_BUCKET = 'codex'

interface CatalogModel {
  id?: unknown
  displayName?: unknown
  hidden?: unknown
  isDefault?: unknown
  defaultReasoningEffort?: unknown
  supportedReasoningEfforts?: unknown
}

interface Bucket {
  primary?: { usedPercent?: unknown; resetsAt?: unknown } | null
  rateLimitReachedType?: unknown
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : []
}

function label(model: CatalogModel, id: string): string {
  if (LABELS[id]) return LABELS[id]
  const display = typeof model.displayName === 'string' && model.displayName ? model.displayName : id
  // "GPT-5.6-Sol" reads as "GPT-5.6 Sol": keep the version hyphen, space the variant words.
  const version = /^(GPT-[\d.]+)(?:-(.*))?$/.exec(display)
  if (!version) return display.replace(/-/g, ' ')
  return version[2] ? `${version[1]} ${version[2].replace(/-/g, ' ')}` : version[1]!
}

function efforts(model: CatalogModel): string[] {
  return records(model.supportedReasoningEfforts)
    .map((entry) => entry.reasoningEffort ?? entry.effort)
    .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
}

function buckets(limits: unknown): Record<string, Bucket> {
  const container = limits as { rateLimitsByLimitId?: unknown } | null
  const byId = container?.rateLimitsByLimitId
  if (!byId || typeof byId !== 'object') return {}
  return byId as Record<string, Bucket>
}

function bucketState(bucket: Bucket | undefined): Pick<DispatchModel, 'exhausted' | 'resetsAt'> {
  if (!bucket) return { exhausted: null, resetsAt: null }
  const used = typeof bucket.primary?.usedPercent === 'number' ? bucket.primary.usedPercent : null
  const resetsAt = typeof bucket.primary?.resetsAt === 'number' ? bucket.primary.resetsAt : null
  const exhausted = bucket.rateLimitReachedType === 'rate_limit_reached' || (used !== null && used >= 100)
  return { exhausted, resetsAt }
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** Reads model and effort from App Server `config/read`. */
export function readConfigDefaults(value: unknown): DispatchDefaults | undefined {
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const config = root?.config && typeof root.config === 'object' && !Array.isArray(root.config)
    ? root.config as Record<string, unknown>
    : root
  const model = text(config?.model)
  if (!model) return undefined
  return { model, effort: text(config?.model_reasoning_effort) || 'medium' }
}

function catalogDefaults(entries: readonly CatalogModel[]): DispatchDefaults | undefined {
  const entry = entries.find((item) => item.isDefault === true && text(item.id) && !NEVER_LISTED.has(text(item.id)))
  const model = text(entry?.id)
  if (!model) return undefined
  const effort = text(entry?.defaultReasoningEffort) || efforts(entry ?? {})[0] || 'medium'
  return { model, effort }
}

export function readModelCatalog(catalog: unknown, limits: unknown, config: unknown): DispatchModelCatalog {
  const container = catalog as { data?: unknown } | null
  const entries = records(container?.data) as CatalogModel[]
  const defaults = readConfigDefaults(config) ?? catalogDefaults(entries)
  if (!defaults) throw new Error('Codex App Server returned no default model')
  const rateLimitsError = limits instanceof Error ? limits.message : null
  const byBucket = rateLimitsError ? {} : buckets(limits)
  const models: DispatchModel[] = []
  for (const entry of entries) {
    const id = text(entry.id)
    if (!id || NEVER_LISTED.has(id)) continue
    if (entry.hidden === true && id !== RESERVE_MODEL && id !== defaults.model) continue
    const state = rateLimitsError ? { exhausted: null, resetsAt: null } : bucketState(byBucket[BUCKETS[id] ?? DEFAULT_BUCKET])
    models.push({ id, label: label(entry, id), efforts: efforts(entry), ...state })
  }
  if (models.length === 0) throw new Error('Codex App Server returned no models')
  return { models, defaults, rateLimitsError }
}
