import demoData from '../data/demo-data.json';
import { buildModel } from '../domain/model';
import type { DemoScenario } from '../types';

export const scenarios = (demoData as unknown as { scenarios: DemoScenario[] }).scenarios;

export function scenario(id: string): DemoScenario {
  const found = scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
}

export const modelOf = (id: string) => buildModel(scenario(id));
