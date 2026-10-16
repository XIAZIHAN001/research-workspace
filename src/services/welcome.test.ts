import { describe, expect, it } from 'vitest';
import {
  composeWelcome,
  mockWelcomeProvider,
  salutation,
  shortenName,
  splitWelcome,
  WELCOME_NAME_LIMIT,
  type WelcomeContext,
} from './welcome';

const empty: WelcomeContext = { hour: 9, projectCount: 0, current: null };

describe('salutation', () => {
  it.each([
    { hour: 0, expected: '夜深了' },
    { hour: 4, expected: '夜深了' },
    { hour: 5, expected: '早上好' },
    { hour: 10, expected: '早上好' },
    { hour: 11, expected: '中午好' },
    { hour: 13, expected: '中午好' },
    { hour: 14, expected: '下午好' },
    { hour: 17, expected: '下午好' },
    { hour: 18, expected: '晚上好' },
    { hour: 23, expected: '晚上好' },
  ])('greets hour $hour with "$expected"', ({ hour, expected }) => {
    expect(salutation(hour)).toBe(expected);
  });
});

describe('composeWelcome', () => {
  it('invites a first project when there are none', () => {
    expect(composeWelcome(empty)).toBe('早上好。新建第一个项目，从一篇想读懂的论文开始。');
  });

  it('asks to pick a project when none is current', () => {
    expect(composeWelcome({ ...empty, projectCount: 3 })).toBe('早上好。选一个项目，接着往下读。');
  });

  it('says so when the current project was touched today', () => {
    const current = { name: 'ResNet', idleDays: 0, relatedCount: 1 };
    expect(composeWelcome({ ...empty, projectCount: 2, current })).toBe(
      '早上好。《ResNet》今天刚动过，趁热再往前推进一点。',
    );
  });

  it('states how many days the current project has been idle', () => {
    const current = { name: 'ResNet', idleDays: 5, relatedCount: 0 };
    expect(composeWelcome({ hour: 20, projectCount: 2, current })).toBe(
      '晚上好。《ResNet》已有 5 天没有改动，今天推进一点？',
    );
  });

  it('only states facts present in the context', () => {
    const current = { name: 'BERT', idleDays: 2, relatedCount: 4 };
    const text = composeWelcome({ hour: 15, projectCount: 1, current });
    expect(text).toContain('《BERT》');
    expect(text).toContain('2 天');
  });

  it('shortens a long paper title so the closing question still fits on screen', () => {
    const current = {
      name: 'Mastering the game of Go with deep neural networks and tree search',
      idleDays: 0,
      relatedCount: 0,
    };
    const text = composeWelcome({ hour: 9, projectCount: 1, current });
    expect(text).toContain('《Mastering the game of Go…》');
    expect(text).toContain('今天刚动过');
  });

  it('leaves a name that is exactly the limit alone', () => {
    const current = { name: 'a'.repeat(WELCOME_NAME_LIMIT), idleDays: 3, relatedCount: 0 };
    expect(composeWelcome({ hour: 9, projectCount: 1, current })).toContain(`《${current.name}》`);
  });
});

describe('shortenName', () => {
  it('keeps a name at the limit unchanged', () => {
    const name = 'a'.repeat(WELCOME_NAME_LIMIT);
    expect(shortenName(name)).toBe(name);
  });

  it('truncates a longer name and marks the cut', () => {
    expect(shortenName('a'.repeat(WELCOME_NAME_LIMIT + 5))).toBe(
      `${'a'.repeat(WELCOME_NAME_LIMIT)}…`,
    );
  });

  it('cuts at a word boundary when one is close to the limit', () => {
    expect(shortenName('Deep Residual Learning for Image Recognition')).toBe(
      'Deep Residual Learning for…',
    );
  });

  it('keeps the full width when the next character is already a space', () => {
    expect(shortenName(`${'x'.repeat(WELCOME_NAME_LIMIT)} tail`)).toBe(
      `${'x'.repeat(WELCOME_NAME_LIMIT)}…`,
    );
  });

  it('never splits a character pair', () => {
    const name = '😀'.repeat(WELCOME_NAME_LIMIT + 4);
    expect(Array.from(shortenName(name)).length).toBe(WELCOME_NAME_LIMIT + 1);
  });
});

describe('splitWelcome', () => {
  it('splits a short greeting from the sentence after it', () => {
    expect(splitWelcome('早上好。新建第一个项目，从一篇想读懂的论文开始。')).toStrictEqual({
      lead: '早上好',
      stop: '。',
      body: '新建第一个项目，从一篇想读懂的论文开始。',
    });
  });

  it('keeps the whole line readable when the two parts are put back together', () => {
    const text = '晚上好。《ResNet》已有 5 天没有改动，今天推进一点？';
    const { lead, stop, body } = splitWelcome(text);
    expect(`${lead}${stop}${body}`).toBe(text);
    expect(lead).toBe('晚上好');
    expect(body).toContain('《ResNet》');
  });

  it('leaves text alone when there is nothing after the opening', () => {
    expect(splitWelcome('你好，今天读哪一篇？')).toStrictEqual({
      lead: '你好，今天读哪一篇？',
      stop: '',
      body: '',
    });
  });

  it('leaves a long opening in one block instead of shrinking a whole sentence', () => {
    const text = `${'一'.repeat(14)}。剩下的话。`;
    expect(splitWelcome(text)).toStrictEqual({ lead: text, stop: '', body: '' });
  });

  it('handles an empty string', () => {
    expect(splitWelcome('')).toStrictEqual({ lead: '', stop: '', body: '' });
  });
});

describe('mockWelcomeProvider', () => {
  it('resolves to the template text for the same context', async () => {
    const context: WelcomeContext = {
      hour: 15,
      projectCount: 1,
      current: { name: 'BERT', idleDays: 2, relatedCount: 4 },
    };
    await expect(mockWelcomeProvider.greet(context)).resolves.toBe(composeWelcome(context));
  });
});
