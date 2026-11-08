import { describe, expect, it } from 'vitest';
import { mayCheckOrApply, resolveActor } from '../src/transfer/identity';

describe('resolveActor', () => {
  it('treats a palette or menu click with a clean environment as workbench', () => {
    expect(resolveActor({ env: {}, args: [] })).toBe('workbench');
    expect(resolveActor({ env: { PATH: '/bin' } })).toBe('workbench');
  });
  it('treats any invoke with arguments as an agent', () => {
    expect(resolveActor({ env: {}, args: [{ actor: 'workbench' }] })).toBe('agent');
  });
  it('ignores a caller-set class', () => {
    expect(resolveActor({ env: {}, args: ['local'] })).toBe('agent');
  });
  it('treats an agent marker as an agent, even when empty', () => {
    expect(resolveActor({ env: { CURSOR_AGENT: '' } })).toBe('agent');
    expect(resolveActor({ env: { CLAUDECODE: '1' } })).toBe('agent');
  });
  it('treats a cloud marker as cloud, even when empty', () => {
    expect(resolveActor({ env: { CLAUDE_CODE_REMOTE: '' } })).toBe('cloud');
  });
  it('fails closed when the input cannot be read', () => {
    expect(resolveActor({ env: null as never })).toBe('unidentified');
    expect(resolveActor({ env: {}, args: 'x' as never })).toBe('unidentified');
    const bad = new Proxy({}, { has() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); } });
    expect(resolveActor({ env: bad as never })).toBe('unidentified');
  });
  it('lets only the workbench through', () => {
    expect(mayCheckOrApply('workbench')).toBe(true);
    for (const a of ['agent', 'cloud', 'unidentified'] as const) expect(mayCheckOrApply(a)).toBe(false);
  });
});
