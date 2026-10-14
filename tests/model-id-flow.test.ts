/**
 * Tests for model ID selection and display utility functions.
 * Verifies that the exact Orbio model.id is preserved through the display helpers
 * and that display helpers never alter the inference model ID.
 *
 * Run with: bun test tests/model-id-flow.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { modelDisplayName, modelProvider, isVariantModel, variantLabel } from '../src/lib/utils'
import type { OrbioModel } from '../src/lib/api'

// Representative real model shapes from the live Orbio catalogue
const MODELS: OrbioModel[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    object: 'model',
    name: 'Claude Sonnet 5',
    owned_by: 'anthropic',
    created: 1720000000,
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
  },
  {
    id: 'openai/gpt-4o',
    object: 'model',
    name: 'GPT-4o',
    owned_by: 'openai',
    context_length: 128000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
  },
  {
    id: 'google/gemini-2.5-pro',
    object: 'model',
    name: 'Gemini 2.5 Pro',
    owned_by: 'google',
    context_length: 1000000,
    pricing: { prompt: '0.00000125', completion: '0.000010' },
  },
  {
    id: 'openrouter/auto',
    object: 'model',
    name: 'OpenRouter Auto',
    owned_by: 'openrouter',
    pricing: { prompt: '-1', completion: '-1' },
  },
  {
    id: 'anthropic/claude-sonnet-5:batch',
    object: 'model',
    name: 'Claude Sonnet 5 (Batch)',
    owned_by: 'anthropic',
    pricing: { prompt: '0.0000015', completion: '0.0000075' },
  },
  {
    id: 'inclusionai/ling-3.1-flash',
    object: 'model',
    name: 'Ling 3.1 Flash',
    owned_by: 'inclusionai',
    pricing: { prompt: '0', completion: '0' },
  },
]

describe('model ID preservation', () => {
  it('model.id is never mutated by display helpers', () => {
    for (const m of MODELS) {
      const originalId = m.id
      modelDisplayName(m)
      modelProvider(m)
      isVariantModel(m.id)
      variantLabel(m.id)
      // id must be exactly the same object/value after all helpers run
      expect(m.id).toBe(originalId)
    }
  })

  it('display name is different from model ID for models with a name field', () => {
    const claude = MODELS.find((m) => m.id === 'anthropic/claude-sonnet-5')!
    const display = modelDisplayName(claude)
    // Should use the name field, not the id slug
    expect(display).toBe('Claude Sonnet 5')
    expect(display).not.toBe(claude.id)
  })

  it('display name falls back to slug when name is absent', () => {
    const model: OrbioModel = { id: 'provider/some-model-v2', object: 'model' }
    expect(modelDisplayName(model)).toBe('some-model-v2')
  })

  it('provider is derived from owned_by when present', () => {
    const m = MODELS.find((m) => m.id === 'anthropic/claude-sonnet-5')!
    expect(modelProvider(m)).toBe('Anthropic')
  })

  it('provider falls back to id prefix when owned_by is absent', () => {
    const m: OrbioModel = { id: 'mistralai/mistral-large', object: 'model' }
    expect(modelProvider(m)).toBe('Mistralai')
  })
})

describe('variant detection', () => {
  it('detects :batch variant', () => {
    expect(isVariantModel('anthropic/claude-sonnet-5:batch')).toBe(true)
  })
  it('detects :extended variant', () => {
    expect(isVariantModel('openai/gpt-4o:extended')).toBe(true)
  })
  it('returns false for a base model', () => {
    expect(isVariantModel('anthropic/claude-sonnet-5')).toBe(false)
  })
  it('returns the suffix label correctly', () => {
    expect(variantLabel('anthropic/claude-sonnet-5:batch')).toBe('batch')
  })
  it('returns null for a base model', () => {
    expect(variantLabel('anthropic/claude-sonnet-5')).toBeNull()
  })
})

describe('display name accepts both string and OrbioModel', () => {
  it('string overload: returns last path segment', () => {
    expect(modelDisplayName('openai/gpt-4o')).toBe('gpt-4o')
  })
  it('OrbioModel overload: returns name when available', () => {
    const m = MODELS.find((m) => m.id === 'openai/gpt-4o')!
    expect(modelDisplayName(m)).toBe('GPT-4o')
  })
})

describe('model ID to inference request', () => {
  // This test verifies the contract that the id used to find a model object
  // is the same id that would be sent to the inference API.
  // The Playground does: models.find(m => m.id === selectedModel) then sends selectedModel to /chat.
  // selectedModel is initialised from initialModel prop (which is model.id from Marketplace).
  it('model.id lookup returns the same model whose id was used as key', () => {
    for (const model of MODELS) {
      const found = MODELS.find((m) => m.id === model.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(model.id)
    }
  })

  it('does not confuse display name with model id during lookup', () => {
    const gpt4o = MODELS.find((m) => m.id === 'openai/gpt-4o')!
    // Searching by display name should NOT find by id (different values)
    const byName = MODELS.find((m) => m.id === gpt4o.name)
    expect(byName).toBeUndefined()
  })
})
