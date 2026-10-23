import { describe, expect, it, vi } from 'vitest';
import { MAX_NAME_LENGTH, MAX_TITLE_LENGTH } from './normalize';
import { createProject } from './project';

describe('createProject', () => {
  function sequentialIds(): () => string {
    let next = 0;
    return () => {
      next += 1;
      return `id-${next}`;
    };
  }

  it('builds a project around a new paper named after the normalized title', () => {
    const created = createProject('  Attention   Is All You Need ', sequentialIds(), 1_700);
    expect(created).toStrictEqual({
      project: {
        id: expect.any(String),
        name: 'Attention Is All You Need',
        corePaperId: expect.any(String),
        relatedPaperIds: [],
        createdAt: 1_700,
        updatedAt: 1_700,
      },
      paper: {
        id: expect.any(String),
        title: 'Attention Is All You Need',
        authors: [],
        createdAt: 1_700,
        updatedAt: 1_700,
      },
    });
  });

  it('points the project at the paper it draws, with two distinct ids', () => {
    const makeId = vi.fn(sequentialIds());
    const created = createProject('Title', makeId, 0);
    expect(makeId).toHaveBeenCalledTimes(2);
    expect(created?.project.id).not.toBe(created?.paper.id);
    expect(created?.project.corePaperId).toBe(created?.paper.id);
  });

  it('returns null for a blank title without consuming any id', () => {
    const makeId = vi.fn(sequentialIds());
    expect(createProject('   \n', makeId, 0)).toBeNull();
    expect(makeId).not.toHaveBeenCalled();
  });

  it('truncates over-long titles to their own, longer limit', () => {
    const created = createProject('t'.repeat(MAX_NAME_LENGTH + 5), sequentialIds(), 0);
    // The project keeps a name; the paper keeps a title, and a title may be longer.
    expect(created?.project.name).toBe('t'.repeat(MAX_NAME_LENGTH));
    expect(created?.paper.title).toBe('t'.repeat(MAX_NAME_LENGTH + 5));
  });

  it('still caps the paper title, so storage cannot grow without a bound', () => {
    const created = createProject('t'.repeat(MAX_TITLE_LENGTH + 5), sequentialIds(), 0);
    expect(created?.project.name).toBe('t'.repeat(MAX_NAME_LENGTH));
    expect(created?.paper.title).toBe('t'.repeat(MAX_TITLE_LENGTH));
  });

  it('starts with no related papers', () => {
    expect(createProject('Title', sequentialIds(), 0)?.project.relatedPaperIds).toStrictEqual([]);
  });
});
