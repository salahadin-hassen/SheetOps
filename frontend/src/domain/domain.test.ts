import { describe, expect, it } from 'vitest';
import { modelOf, scenario, scenarios } from '../test/fixtures';
import { decisionState, readReview } from './review';
import { readRuns, rowAccounting, stagesFor, UNRESOLVED_AFTER_MINUTES } from './runs';
import { explainRun } from './explain';

const words = (id: string, runId: string) => {
  const run = readRuns(scenario(id)).find((r) => r.id === runId)!;
  return stagesFor(run).map((s) => s.word);
};

describe('demo data', () => {
  it('holds the seven generated scenarios, each with the five tabs', () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      'before-first-run', 'week2-published', 'review-changed', 'review-during-run', 'publish-refused', 'run-started', 'outcome-unknown',
    ]);
    for (const s of scenarios) expect(Object.keys(s.tabs)).toEqual(['Catalog', 'Review', 'Changes', 'Exceptions', 'Run Log']);
  });

  it('agrees with what the generator expected from the workflow', () => {
    for (const s of scenarios as Array<(typeof scenarios)[number] & { expect: { lastRun?: string; status?: string } }>) {
      if (!s.expect.lastRun) continue;
      const latest = readRuns(s)[0];
      expect(latest.id).toBe(s.expect.lastRun);
      expect(latest.row.status).toBe(s.expect.status);
    }
  });
});

describe('run status and stage track', () => {
  it('a published run is Done at every stage', () => {
    expect(words('week2-published', '1001')).toEqual(['Done', 'Done', 'Done', 'Done', 'Done']);
  });

  it('REVIEW_CHANGED: stages 1-4 Done, Publish Not sent', () => {
    const run = readRuns(scenario('review-changed')).find((r) => r.id === '1002')!;
    expect(run.kind).toBe('failed');
    expect(run.committed).toBe(false);
    expect(run.row.error_code).toBe('REVIEW_CHANGED');
    expect(stagesFor(run).map((s) => [s.state, s.word])).toEqual([
      ['done', 'Done'], ['done', 'Done'], ['done', 'Done'], ['done', 'Done'], ['failed', 'Not sent'],
    ]);
  });

  it('a refused publish shows the HTTP status from the Run Log message', () => {
    expect(words('publish-refused', '1001')).toEqual(['Done', 'Done', 'Done', 'Done', 'Refused (403)']);
  });

  it(`a STARTED row is "no result yet" under ${UNRESOLVED_AFTER_MINUTES} minutes and "outcome unknown" after`, () => {
    const started = readRuns(scenario('run-started'))[0];
    const unknown = readRuns(scenario('outcome-unknown'))[0];
    expect([started.kind, started.ageMinutes]).toEqual(['started', 3]);
    expect([unknown.kind, unknown.ageMinutes]).toEqual(['unresolved', 21]);
    expect(words('run-started', '1001')).toEqual(['Done', 'No result yet', 'No result yet', 'No result yet', 'No result yet']);
    expect(words('outcome-unknown', '1001')).toEqual(['Done', 'Not in the sheet', 'Not in the sheet', 'Not in the sheet', 'Unknown']);
  });

  it('an unresolved STARTED row is never described as failed', () => {
    const m = modelOf('outcome-unknown');
    const why = explainRun(m.runs[0], m.runs);
    expect(why.meaning).toMatch(/not marked Failed/);
    expect(m.publishing.kind).toBe('unresolved');
  });

  it('blank counts on a FAILED row are "not recorded", not zero', () => {
    const run = readRuns(scenario('review-changed')).find((r) => r.id === '1002')!;
    const { rowsRead, parts } = rowAccounting(run.row);
    expect(rowsRead).toBeNull();
    expect(parts.every((p) => p.value === null)).toBe(true);
  });

  it('row accounting of the committed run adds up to rows read', () => {
    const { rowsRead, parts } = rowAccounting(readRuns(scenario('week2-published'))[0].row);
    expect(parts.reduce((n, p) => n + (p.value ?? 0), 0)).toBe(rowsRead);
    expect(rowsRead).toBe(19);
  });

  it('REVIEW_CHANGED on an already-committed list asks for a manual reprocess, never an automatic retry', () => {
    const m = modelOf('review-changed');
    const why = explainRun(m.runs.find((r) => r.id === '1002')!, m.runs);
    expect(why.operator).toMatch(/already committed by run 1001/);
    expect(why.operator).toMatch(/manual reprocess/);
  });
});

describe('review decisions', () => {
  it('restates the contract: trimmed, case-insensitive APPROVE; empty is pending', () => {
    expect(decisionState('')).toBe('PENDING');
    expect(decisionState(' approve ')).toBe('APPROVED');
    expect(decisionState('APPROVED')).toBe('INVALID_DECISION');
    expect(decisionState('yes')).toBe('INVALID_DECISION');
    expect(decisionState(5)).toBe('INVALID_DECISION');
  });

  it('after REVIEW_CHANGED the approval is kept in the sheet and not applied', () => {
    const s = scenario('review-changed');
    const tea = readReview(s).find((i) => i.row.sku === 'TEA-001')!;
    expect(tea.row.decision).toBe('APPROVE');
    expect(tea.decision).toBe('APPROVED');
    expect(tea.row.status).toBe('PENDING');
    expect(tea.decidedSinceLastPublish).toBe(true);
    expect(s.tabs.Catalog.find((c) => c.sku === 'TEA-001')!.unit).toBe('pack');
    expect(s.tabs.Changes.some((c) => c.sku === 'TEA-001' && c.disposition === 'APPLIED_AFTER_REVIEW')).toBe(false);
  });
});
