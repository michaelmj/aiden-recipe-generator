import { describe, expect, test } from 'bun:test';
import { ResourceIdSchema } from '@/schemas';

describe('ResourceIdSchema', () => {
  test('accepts real id shapes', () => {
    for (const id of ['550e8400-e29b-41d4-a716-446655440000', 'AIDEN_0123', 'dev:42', 'ai.den-1.2']) {
      expect(ResourceIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test('rejects ids that would reshape the request path', () => {
    for (const id of ['.', '..', '../../admin', 'a/b', 'x?admin=true', 'x#frag', 'x y', '%2e%2e', '']) {
      expect(ResourceIdSchema.safeParse(id).success).toBe(false);
    }
  });

  test('rejects an absurdly long id', () => {
    expect(ResourceIdSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});
