import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const commands: { command: string; title: string; icon?: string }[] = pkg.contributes.commands;
const menus = pkg.contributes.menus;
const inline: { command: string; alt?: string; when: string; group: string }[] =
  menus['view/item/context'].filter((m: any) => /\(commit\|historyCommit\)|commit\.head/.test(m.when) && m.group.startsWith('inline@'));

describe('commit row hover actions', () => {
  it('has the five hover actions, in order', () => {
    const order = [...inline].sort((a, b) => Number(a.group.slice(7)) - Number(b.group.slice(7))).map(m => m.command.replace('gitKitchen.commit.', ''));
    expect(order).toEqual(['undo', 'openAllChanges', 'compareHead', 'copySha', 'openOnRemote']);
  });
  it('declares every action and Alt variant, with an icon on each button, hidden from the palette', () => {
    for (const m of inline) {
      const c = commands.find(x => x.command === m.command);
      expect(c, m.command).toBeDefined(); expect(c!.icon, `${m.command} icon`).toBeTruthy();
      if (m.alt) expect(commands.find(x => x.command === m.alt), m.alt).toBeDefined();
      for (const id of [m.command, m.alt].filter(Boolean)) {
        expect(menus.commandPalette.some((p: any) => p.command === id && p.when === 'false'), `${id} hidden in palette`).toBe(true);
      }
    }
  });
  it('uses unique inline slots', () => {
    const groups = inline.map(m => m.group);
    expect(new Set(groups).size).toBe(groups.length);
  });
  it('offers Undo Commit in the right-click menu and the Commits view menu, not only on hover', () => {
    const undo = menus['view/item/context'].filter((m: any) => m.command === 'gitKitchen.commit.undo').map((m: any) => m.group);
    expect(undo).toContain('inline@1'); expect(undo).toContain('1@7');
    expect(menus['view/title'].some((m: any) => m.command === 'gitKitchen.commit.undo' && m.when === 'view == gitKitchen.commits')).toBe(true);
  });
});
