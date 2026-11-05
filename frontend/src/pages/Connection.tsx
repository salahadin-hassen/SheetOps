import { Banner } from '../components/Banner';
import { LedgerTable } from '../components/LedgerTable';
import { DefinitionList, Panel } from '../components/Panel';
import { PageHead } from '../components/PageHead';
import { Pill } from '../components/StatusPill';
import { formatDateTime } from '../domain/format';
import type { ConsoleModel } from '../domain/model';

interface Capability { name: string; now: string; needs: string }

// What this build can do, stated plainly. Nothing here can be switched on from
// the browser: each "needs" entry depends on a server that does not exist yet.
const CAPABILITIES: Capability[] = [
  { name: 'Read the five sheet tabs', now: 'Generated demo data only', needs: 'A server that holds the Google credential and returns the tabs' },
  { name: 'See files waiting in Drive', now: 'Not available. Incoming files shows recorded files only', needs: 'The same server, with a Drive listing' },
  { name: 'Record a review decision', now: 'Not available here. Decisions are typed in the Google Sheet', needs: 'A server write path, with its own design and tests' },
  { name: 'Start or retry a run', now: 'Not available here. Runs start in n8n', needs: 'A server that can trigger the workflow safely' },
  { name: 'See n8n execution status', now: 'Not available. The console reads the sheet, not n8n', needs: 'A server with read access to n8n' },
];

export function Connection({ model, mode, origin, scenario }: { model: ConsoleModel; mode: 'demo'; origin: string; scenario: string }) {
  return (
    <>
      <PageHead title="Connection" lead="Where the data on these screens comes from, and what this build cannot do yet." />

      <Banner tone="amber" status="DEMO" title="Demo data. This console is not connected to Google.">
        <p>Everything shown is synthetic data generated offline. No screen here reflects a live spreadsheet or Drive folder.</p>
      </Banner>

      <div className="grid-2">
        <Panel title="Data source">
          <DefinitionList items={[
            ['Data mode', mode === 'demo' ? 'Demo, offline' : mode],
            ['Using fixture data', 'Yes'],
            ['Scenario', scenario],
            ['Spreadsheet title', model.snapshot.spreadsheetTitle],
            ['Snapshot read at', formatDateTime(model.snapshot.checkedAt)],
            ['Origin', origin],
          ]} />
        </Panel>
        <Panel title="Live integration">
          <DefinitionList items={[
            ['Google connection', <Pill tone="neutral">Not connected</Pill>],
            ['Live verification', <Pill tone="amber">Not verified</Pill>],
            ['What that means', 'This console has never read a live sheet. Its tests and screens prove behaviour on demo data, and nothing about live Google.'],
            ['Credentials', 'None in this build. The Google service-account key must stay on a server the operator controls and must never reach the browser.'],
            ['Network requests', 'None. The page makes no requests for data.'],
          ]} />
        </Panel>
      </div>

      <Panel title="Capabilities" flush sub="Read-only. Nothing on this screen can be switched on from the browser.">
        <LedgerTable<Capability>
          stack
          caption="What this build can do, and what each missing capability depends on"
          rows={CAPABILITIES}
          rowKey={(c) => c.name}
          columns={[
            { header: 'Capability', rowHeader: true, phone: 'full', cell: (c) => c.name },
            { header: 'In this build', cell: (c) => c.now },
            { header: 'Depends on', cell: (c) => <span className="muted">{c.needs}</span> },
          ]}
        />
      </Panel>
    </>
  );
}
