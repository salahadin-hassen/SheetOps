import { useEffect, useMemo, useState } from 'react';
import { AppShell, type NavCounts } from './components/AppShell';
import { Banner } from './components/Banner';
import { EmptyState } from './components/Panel';
import { PageHead } from './components/PageHead';
import { DEFAULT_VIEW, DemoSource, type SheetSource, type SnapshotView } from './data/source';
import { formatDateTime } from './domain/format';
import { buildModel, type ConsoleModel } from './domain/model';
import { Catalog } from './pages/Catalog';
import { Changes } from './pages/Changes';
import { Exceptions } from './pages/Exceptions';
import { Overview } from './pages/Overview';
import { Review } from './pages/Review';
import { RunDetails, RunsList } from './pages/Runs';
import { hrefFor, LinkContext, NavigatedContext, useLocation, type Route } from './router';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; model: ConsoleModel };

const demoSource = new DemoSource();

export function App({ source = demoSource }: { source?: SheetSource }) {
  const { route, view, navigations } = useLocation();
  // An empty or missing ?view= means the default scenario, not an error.
  const viewId = view?.trim() ? view : DEFAULT_VIEW;
  const [views, setViews] = useState<SnapshotView[]>([]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    source.listViews().then(setViews, () => setViews([]));
  }, [source]);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    source.read(viewId).then(
      (snapshot) => { if (live) setLoad({ state: 'ready', model: buildModel(snapshot) }); },
      (err: unknown) => { if (live) setLoad({ state: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [source, viewId]);

  const link = useMemo(() => (path: string) => hrefFor(path, viewId), [viewId]);
  const model = load.state === 'ready' ? load.model : null;
  const counts: NavCounts = {
    awaiting: model ? model.review.filter((i) => i.decision === 'PENDING').length : null,
    exceptions: model && model.exceptionBatches[0]?.run
      ? { count: model.exceptionBatches[0].rows.length, runId: model.exceptionBatches[0].run.id } : null,
  };

  const onViewChange = (id: string) => {
    const path = window.location.hash.replace(/^#/, '').split('?')[0] || '/';
    window.location.hash = hrefFor(path, id).slice(1);
  };

  return (
    <LinkContext.Provider value={link}>
      <NavigatedContext.Provider value={navigations > 0}>
        <AppShell route={route} views={views} viewId={viewId} onViewChange={onViewChange} origin={source.origin}
          spreadsheetTitle={model?.snapshot.spreadsheetTitle ?? null}
          checkedAt={model ? formatDateTime(model.snapshot.checkedAt) : null} counts={counts}>
          {load.state === 'loading' ? (
            <div role="status" aria-live="polite">
              <span className="visually-hidden">Reading the sheet snapshot…</span>
              <div className="skeleton" aria-hidden="true"><span style={{ width: '30%', height: 24 }} /><span style={{ width: '60%' }} /><span /><span /><span style={{ width: '80%' }} /></div>
            </div>
          ) : null}
          {load.state === 'error' ? (
            <>
              <PageHead title="The data could not be read" />
              <Banner tone="red" title="Nothing is shown, rather than something stale">
                <p>{load.message}</p>
                <p>No values are displayed until a read succeeds. Choose another scenario, or reload the page.</p>
              </Banner>
            </>
          ) : null}
          {model ? <Screen route={route} model={model} /> : null}
        </AppShell>
      </NavigatedContext.Provider>
    </LinkContext.Provider>
  );
}

function Screen({ route, model }: { route: Route; model: ConsoleModel }) {
  switch (route.page) {
    case 'overview': return <Overview model={model} />;
    case 'runs': return <RunsList model={model} />;
    case 'run': return <RunDetails model={model} runId={route.runId} />;
    case 'review': return <Review model={model} sku={route.sku} />;
    case 'exceptions': return <Exceptions model={model} />;
    case 'catalog': return <Catalog model={model} />;
    case 'changes': return <Changes model={model} />;
    default:
      return (
        <>
          <PageHead title="Page not found" />
          <EmptyState title={`There is no screen at “${route.path}”`}>
            Use the navigation to choose a screen.
          </EmptyState>
        </>
      );
  }
}
