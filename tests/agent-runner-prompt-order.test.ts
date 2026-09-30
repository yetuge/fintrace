import { describe, expect, test } from 'vitest';
import { buildMiniclawPromptPlan } from '../container/agent-runner/src/prompt-plan.js';

describe('agent-runner system prompt composition order', () => {
  test('Agent identity leads platform workspace/context material', () => {
    const plan = buildMiniclawPromptPlan({
      platformIdentity: 'Miniclaw',
      platformBootstrap: 'first wake',
      agentIdentity: 'identity',
      interaction: 'interaction',
      security: 'security',
      output: 'output',
    });
    expect(plan.blocks.map((block) => block.id)).toEqual([
      'identity.fintrace',
      'bootstrap.fintrace',
      'agent-profile',
      'interaction',
      'security-rules',
      'output',
    ]);
  });
});
