import type { DemoScenario, SheetSnapshot } from '../types';
import demoData from './demo-data.json';

// The console's only way to get data. The browser renders what a source
// returns and never talks to Google itself.
//
// This milestone has one implementation, the offline demo. A future live
// source must run behind a server the operator controls: that server holds the
// Google credential, reads the five tabs and returns a SheetSnapshot. The
// service-account key never reaches the browser, and no browser request uses
// the service-account identity.

export interface SnapshotView {
  id: string;
  title: string;
  description: string;
}

export interface SheetSource {
  /** 'demo' marks synthetic offline data; the UI labels it on every screen. */
  readonly mode: 'demo';
  /** Human-readable origin, shown in the demo notice. */
  readonly origin: string;
  listViews(): Promise<SnapshotView[]>;
  read(viewId: string): Promise<SheetSnapshot>;
}

interface DemoFile {
  generatedBy: string;
  source: string;
  scenarios: DemoScenario[];
}

export class DemoSource implements SheetSource {
  readonly mode = 'demo' as const;
  readonly origin: string;
  private readonly scenarios: DemoScenario[];

  constructor(file: DemoFile = demoData as unknown as DemoFile) {
    this.scenarios = file.scenarios;
    this.origin = file.source;
  }

  async listViews(): Promise<SnapshotView[]> {
    return this.scenarios.map(({ id, title, description }) => ({ id, title, description }));
  }

  async read(viewId: string): Promise<SheetSnapshot> {
    const found = this.scenarios.find((s) => s.id === viewId);
    if (!found) throw new Error(`No demo scenario called "${viewId}"`);
    const { spreadsheetTitle, checkedAt, tabs } = found;
    return structuredClone({ spreadsheetTitle, checkedAt, tabs });
  }
}

export const DEFAULT_VIEW = 'review-changed';
