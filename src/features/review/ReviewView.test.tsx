import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Concept, ConceptEvidence } from '../../domain/knowledge';
import type { Paper } from '../../domain/papers';
import { applyGrade, beginCard } from '../../domain/review';
import { ReviewView } from './ReviewView';

const concept = (id: string, name: string): Concept => ({
  id,
  name,
  aliases: [],
  summary: `${name} 的一句话解释`,
  origin: 'user',
  status: 'confirmed',
  projectIds: [],
  createdAt: 1,
  updatedAt: 1,
});

const evidenceOf = (conceptId: string): ConceptEvidence => ({
  id: `e-${conceptId}`,
  conceptId,
  paperId: 'pa',
  pdfSha256: 'a'.repeat(64),
  page: 4,
  quote: 'the quoted passage',
  prefix: '',
  suffix: '',
  rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.02 }],
  source: 'annotation',
  note: '',
  createdAt: 2,
});

const paper: Paper = { id: 'pa', title: 'Attention', authors: [], createdAt: 0, updatedAt: 0 };
const NOW = 1_000_000;

describe('ReviewView', () => {
  it('drills a concept: name first, then summary and evidence, then grades it', () => {
    const onGrade = vi.fn();
    render(
      <ReviewView
        concepts={[concept('c1', 'Self-attention')]}
        evidence={[evidenceOf('c1')]}
        papers={{ pa: paper }}
        cards={{}}
        now={NOW}
        onGrade={onGrade}
      />,
    );
    expect(screen.getByText('Self-attention')).toBeTruthy();
    // The answer is behind the reveal, not shown with the question.
    expect(screen.queryByText('Self-attention 的一句话解释')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    expect(screen.getByText('Self-attention 的一句话解释')).toBeTruthy();
    expect(screen.getByText(/Attention · 第 4 页/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    expect(onGrade).toHaveBeenCalledWith('c1', 'good');
  });

  it('shows overdue cards before new concepts, and only confirmed concepts at all', () => {
    const overdue = beginCard('c-old', 0);
    const scheduled = applyGrade(beginCard('c-later', 0), 'good', NOW - 5000);
    function Harness() {
      const [cards, setCards] = useState<Record<string, ReturnType<typeof beginCard>>>({
        'c-old': overdue,
        'c-later': scheduled,
      });
      return (
        <ReviewView
          concepts={[
            concept('c-old', '旧概念'),
            concept('c-later', '未来概念'),
            concept('c-new', '新概念'),
          ]}
          evidence={[]}
          papers={{}}
          cards={cards}
          now={NOW}
          onGrade={(conceptId, grade) => {
            // The store's own rule, mirrored so the queue really advances.
            setCards((current) => ({
              ...current,
              [conceptId]: applyGrade(current[conceptId] ?? beginCard(conceptId, NOW), grade, NOW),
            }));
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText(/到期 2 张/)).toBeTruthy();
    expect(screen.getByText('旧概念')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '轻松' }));
    // The graded card left the queue, so the fresh concept is next.
    expect(screen.getByText('新概念')).toBeTruthy();
  });

  it('ignores cards whose concept was deleted, and suggested concepts entirely', () => {
    render(
      <ReviewView
        concepts={[concept('c1', '唯一概念')]}
        evidence={[]}
        papers={{}}
        cards={{ ghost: beginCard('ghost', 0) }}
        now={NOW}
        onGrade={vi.fn()}
      />,
    );
    expect(screen.getByText(/到期 1 张/)).toBeTruthy();
    expect(screen.getByText('唯一概念')).toBeTruthy();
  });

  it('says when nothing is due and when the next batch arrives', () => {
    const scheduled = applyGrade(beginCard('c1', 0), 'good', NOW - 5000);
    const { rerender } = render(
      <ReviewView
        concepts={[concept('c1', 'KZG commitment')]}
        evidence={[]}
        papers={{}}
        cards={{ c1: scheduled }}
        now={NOW}
        onGrade={vi.fn()}
      />,
    );
    expect(screen.getByText(/没有到期的卡片/)).toBeTruthy();
    expect(screen.getByText(/下一批明天到期/)).toBeTruthy();
    rerender(
      <ReviewView concepts={[]} evidence={[]} papers={{}} cards={{}} now={NOW} onGrade={vi.fn()} />,
    );
    expect(screen.getByText(/还没有可复习的概念/)).toBeTruthy();
  });
});

describe('ReviewView session queue', () => {
  const five = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id, index) =>
    concept(id, `概念${String(index + 1)}`),
  );

  function Harness() {
    const [cards, setCards] = useState<Record<string, ReturnType<typeof beginCard>>>({});
    return (
      <ReviewView
        concepts={five}
        evidence={[]}
        papers={{}}
        cards={cards}
        now={NOW}
        onGrade={(conceptId, grade) => {
          setCards((current) => ({
            ...current,
            [conceptId]: applyGrade(current[conceptId] ?? beginCard(conceptId, NOW), grade, NOW),
          }));
        }}
      />
    );
  }

  it('a forgotten card comes back three cards later, not immediately', () => {
    render(<Harness />);
    // 概念1 is graded 忘了: the store keeps it due, but the session moves it three back.
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '忘了' }));
    expect(screen.getByText('概念2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    expect(screen.getByText('概念3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    expect(screen.getByText('概念4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    // Three other cards have passed; the forgotten one is back.
    expect(screen.getByText('概念1')).toBeTruthy();
  });

  it('a forgotten card with fewer than three left reappears after them, and again at the end', () => {
    const pair = [concept('a', '甲'), concept('b', '乙')];
    function Pair() {
      const [cards, setCards] = useState<Record<string, ReturnType<typeof beginCard>>>({});
      return (
        <ReviewView
          concepts={pair}
          evidence={[]}
          papers={{}}
          cards={cards}
          now={NOW}
          onGrade={(conceptId, grade) => {
            setCards((current) => ({
              ...current,
              [conceptId]: applyGrade(current[conceptId] ?? beginCard(conceptId, NOW), grade, NOW),
            }));
          }}
        />
      );
    }
    render(<Pair />);
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '忘了' }));
    expect(screen.getByText('乙')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    expect(screen.getByText('甲')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '显示答案' }));
    fireEvent.click(screen.getByRole('button', { name: '良好' }));
    expect(screen.getByText(/没有到期的卡片/)).toBeTruthy();
  });
});
