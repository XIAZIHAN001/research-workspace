import { describe, expect, it } from 'vitest';
import { createConcept, EMPTY_KNOWLEDGE, type KnowledgeState } from '../domain/knowledge';
import {
  createKnowledgeStore,
  KNOWLEDGE_BACKUP_KEY,
  KNOWLEDGE_STORAGE_KEY,
  loadKnowledge,
  saveKnowledge,
} from './knowledgeStore';

function store(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}

const NOW = 1;

function stateWithConcept(): KnowledgeState {
  const created = createConcept({ name: 'KZG commitment', projectIds: ['p1'] }, () => 'c1', NOW);
  if (created === null) throw new Error('concept not created');
  return { ...EMPTY_KNOWLEDGE, concepts: [created] };
}

describe('loadKnowledge', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadKnowledge(store())).toEqual({
      state: EMPTY_KNOWLEDGE,
      issue: null,
      dropped: 0,
      backupSaved: false,
      writeBlocked: false,
    });
  });

  it('round-trips what it saved', () => {
    const disk = store();
    expect(saveKnowledge(stateWithConcept(), disk)).toBe(true);
    const loaded = loadKnowledge(disk);
    expect(loaded.state.concepts).toHaveLength(1);
    expect(loaded.issue).toBeNull();
  });

  it('keeps a copy of a payload it cannot read, then continues empty', () => {
    const disk = store({ [KNOWLEDGE_STORAGE_KEY]: '{not json' });
    const loaded = loadKnowledge(disk);
    expect(loaded.issue).toBe('unreadable');
    expect(loaded.backupSaved).toBe(true);
    expect(disk.items.get(KNOWLEDGE_BACKUP_KEY)).toBe('{not json');
    expect(loaded.state.concepts).toEqual([]);
  });

  it('keeps the good entries and counts the rest', () => {
    const good = createConcept({ name: 'KZG', projectIds: ['p1'] }, () => 'c1', NOW);
    const payload = JSON.stringify({
      version: 1,
      concepts: [good, { id: 'broken' }, { id: 'c2', name: 'no project list' }],
      evidence: [{ id: 'e1' }],
      relations: [{ id: 'r1', from: 'c1', to: 'c2', kind: 'nonsense' }],
    });
    const disk = store({ [KNOWLEDGE_STORAGE_KEY]: payload });
    const loaded = loadKnowledge(disk);
    expect(loaded.state.concepts).toHaveLength(1);
    expect(loaded.dropped).toBe(4);
    expect(loaded.issue).toBe('wrong-shape');
    expect(loaded.backupSaved).toBe(true);
  });

  it('does not overwrite a different backup that is already there', () => {
    const disk = store({
      [KNOWLEDGE_STORAGE_KEY]: 'broken payload',
      [KNOWLEDGE_BACKUP_KEY]: 'an older, more valuable payload',
    });
    const loaded = loadKnowledge(disk);
    expect(loaded.backupSaved).toBe(false);
    expect(disk.items.get(KNOWLEDGE_BACKUP_KEY)).toBe('an older, more valuable payload');
  });

  it('migrates a version-1 payload to version 2 with an empty rejection list', () => {
    const created = createConcept({ name: 'KZG', projectIds: ['p1'] }, () => 'c1', NOW);
    const disk = store({
      [KNOWLEDGE_STORAGE_KEY]: JSON.stringify({
        version: 1,
        concepts: [created],
        evidence: [],
        relations: [],
      }),
    });
    const loaded = loadKnowledge(disk);
    expect(loaded.state.version).toBe(2);
    expect(loaded.state.concepts).toHaveLength(1);
    expect(loaded.state.rejections).toEqual([]);
    expect(loaded.issue).toBeNull();
  });

  it('refuses to write a payload from a newer schema instead of reducing it', () => {
    const future = JSON.stringify({
      version: 3,
      concepts: [],
      evidence: [],
      relations: [],
      rejections: [],
      graphLayout: { somethingNew: true },
    });
    const disk = store({ [KNOWLEDGE_STORAGE_KEY]: future });
    const loaded = loadKnowledge(disk);
    expect(loaded.issue).toBe('newer-version');
    expect(loaded.writeBlocked).toBe(true);
    expect(disk.items.get(KNOWLEDGE_BACKUP_KEY)).toBe(future);

    const knowledge = createKnowledgeStore(disk);
    expect(knowledge.getSnapshot().writesBlocked).toBe(true);
    knowledge.dispatch({
      type: 'concept/create',
      input: { name: 'New', projectIds: ['p1'] },
      id: 'c9',
      at: NOW,
    });
    expect(knowledge.getSnapshot().persisted).toBe(false);
    expect(disk.items.get(KNOWLEDGE_STORAGE_KEY)).toBe(future);
  });
});

describe('createKnowledgeStore', () => {
  it('persists a dispatch and notifies subscribers', () => {
    const disk = store();
    const knowledge = createKnowledgeStore(disk);
    let notified = 0;
    knowledge.subscribe(() => {
      notified += 1;
    });

    knowledge.dispatch({
      type: 'concept/create',
      input: { name: 'KZG commitment', projectIds: ['p1'] },
      id: 'c1',
      at: NOW,
    });

    expect(notified).toBe(1);
    expect(knowledge.getSnapshot().persisted).toBe(true);
    expect(loadKnowledge(disk).state.concepts).toHaveLength(1);
  });

  it('does not lose the graph when a write fails, and says so', () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const knowledge = createKnowledgeStore(failing);
    knowledge.dispatch({
      type: 'concept/create',
      input: { name: 'KZG', projectIds: ['p1'] },
      id: 'c1',
      at: NOW,
    });
    const snapshot = knowledge.getSnapshot();
    expect(snapshot.persisted).toBe(false);
    expect(snapshot.state.concepts).toHaveLength(1);
  });

  it('refuses to write over a payload whose only copy could not be saved', () => {
    // Both the live key and the backup hold different, unreadable payloads: writing now would
    // destroy the last copy of whatever the reader had.
    const disk = store({
      [KNOWLEDGE_STORAGE_KEY]: 'live but unreadable',
      [KNOWLEDGE_BACKUP_KEY]: 'older and different',
    });
    const knowledge = createKnowledgeStore(disk);
    const snapshot = knowledge.getSnapshot();
    expect(snapshot.writesBlocked).toBe(true);
    expect(snapshot.issue).toBe('unreadable');

    knowledge.dispatch({
      type: 'concept/create',
      input: { name: 'New', projectIds: ['p1'] },
      id: 'c9',
      at: NOW,
    });
    expect(knowledge.getSnapshot().persisted).toBe(false);
    expect(disk.items.get(KNOWLEDGE_STORAGE_KEY)).toBe('live but unreadable');
  });

  it('ignores an action that changes nothing', () => {
    const disk = store();
    const knowledge = createKnowledgeStore(disk);
    let notified = 0;
    knowledge.subscribe(() => {
      notified += 1;
    });
    // A concept with no name is refused by the domain, so the state is unchanged.
    knowledge.dispatch({
      type: 'concept/create',
      input: { name: '  ', projectIds: ['p1'] },
      id: 'c1',
      at: NOW,
    });
    expect(notified).toBe(0);
  });
});
