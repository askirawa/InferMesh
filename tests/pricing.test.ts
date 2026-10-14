/**
 * Tests for parsePriceField — the core pricing validation logic.
 * Run with: bun test tests/pricing.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { parsePriceField, getModelPricing } from '../src/lib/utils'
import type { OrbioModelPricing } from '../src/lib/api'

describe('parsePriceField', () => {
  // Absent / empty inputs
  it('returns unavailable for undefined', () => {
    expect(parsePriceField(undefined).status).toBe('unavailable')
  })
  it('returns unavailable for null', () => {
    expect(parsePriceField(null).status).toBe('unavailable')
  })
  it('returns unavailable for empty string', () => {
    expect(parsePriceField('').status).toBe('unavailable')
  })

  // Invalid inputs — Orbio sentinels and malformed values
  it('returns invalid for "-1" (Orbio dynamic-routing sentinel)', () => {
    const result = parsePriceField('-1')
    expect(result.status).toBe('invalid')
    expect(result.rawDebug).toBe('-1')
  })
  it('returns invalid for -1 (numeric negative)', () => {
    const result = parsePriceField(-1)
    expect(result.status).toBe('invalid')
    expect(result.rawDebug).toBe('-1')
  })
  it('returns invalid for a non-numeric string', () => {
    const result = parsePriceField('n/a')
    expect(result.status).toBe('invalid')
    expect(result.rawDebug).toBe('n/a')
  })
  it('returns invalid for Infinity', () => {
    const result = parsePriceField(Infinity)
    expect(result.status).toBe('invalid')
  })
  it('returns invalid for NaN (via numeric)', () => {
    const result = parsePriceField(NaN)
    expect(result.status).toBe('invalid')
  })
  it('returns invalid for any other negative value', () => {
    expect(parsePriceField('-0.5').status).toBe('invalid')
    expect(parsePriceField(-99).status).toBe('invalid')
  })
  it('never exposes an invalid value as a price label', () => {
    const result = parsePriceField('-1')
    expect(result.label).toBeUndefined()
    expect(result.perMillion).toBeUndefined()
  })

  // Free
  it('returns free for "0"', () => {
    const result = parsePriceField('0')
    expect(result.status).toBe('free')
  })
  it('returns free for numeric 0', () => {
    expect(parsePriceField(0).status).toBe('free')
  })
  it('returns free for "0.0"', () => {
    expect(parsePriceField('0.0').status).toBe('free')
  })
  it('returns free for "0.000000" (zero with trailing precision)', () => {
    expect(parsePriceField('0.000000').status).toBe('free')
  })

  // Paid
  it('returns paid for a valid positive price string', () => {
    const result = parsePriceField('0.000003')
    expect(result.status).toBe('paid')
    expect(result.perMillion).toBeCloseTo(3.0)
    expect(result.label).toContain('$3.00')
  })
  it('returns paid for a very small price', () => {
    const result = parsePriceField('0.000000005')
    expect(result.status).toBe('paid')
    expect(result.label).toContain('$0.005')
  })
  it('formats label with /1M tok unit', () => {
    const result = parsePriceField('0.000003')
    expect(result.label).toContain('/ 1M tok')
  })
  it('returns paid for numeric price', () => {
    expect(parsePriceField(0.000003).status).toBe('paid')
  })
})

describe('getModelPricing', () => {
  it('returns unavailable for both when pricing is undefined', () => {
    const p = getModelPricing(undefined)
    expect(p.input.status).toBe('unavailable')
    expect(p.output.status).toBe('unavailable')
    expect(p.isFree).toBe(false)
  })

  it('marks isFree only when BOTH prompt and completion are "0"', () => {
    const pricing: OrbioModelPricing = { prompt: '0', completion: '0' }
    const p = getModelPricing(pricing)
    expect(p.isFree).toBe(true)
    expect(p.input.status).toBe('free')
    expect(p.output.status).toBe('free')
  })

  it('does NOT mark isFree when only completion is "0"', () => {
    const pricing: OrbioModelPricing = { prompt: '0.000003', completion: '0' }
    const p = getModelPricing(pricing)
    expect(p.isFree).toBe(false)
    expect(p.input.status).toBe('paid')
    expect(p.output.status).toBe('free')
  })

  it('does NOT mark isFree when pricing fields are missing', () => {
    const pricing: OrbioModelPricing = {}
    const p = getModelPricing(pricing)
    expect(p.isFree).toBe(false)
    expect(p.input.status).toBe('unavailable')
    expect(p.output.status).toBe('unavailable')
  })

  it('does NOT mark isFree for "-1" router models', () => {
    const pricing: OrbioModelPricing = { prompt: '-1', completion: '-1' }
    const p = getModelPricing(pricing)
    expect(p.isFree).toBe(false)
    expect(p.input.status).toBe('invalid')
    expect(p.output.status).toBe('invalid')
  })

  it('detects overrides correctly', () => {
    const pricing: OrbioModelPricing = {
      prompt: '0.000003',
      completion: '0.000006',
      overrides: [{ min_prompt_tokens: 32000, prompt: '0.000006', completion: '0.000012' }],
    }
    const p = getModelPricing(pricing)
    expect(p.hasOverrides).toBe(true)
  })

  it('returns hasOverrides false when overrides is empty array', () => {
    const pricing: OrbioModelPricing = { prompt: '0.000003', completion: '0.000006', overrides: [] }
    const p = getModelPricing(pricing)
    expect(p.hasOverrides).toBe(false)
  })
})
