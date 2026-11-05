import { useEffect, useState, type ReactNode } from 'react';
import type { SnapshotView } from '../data/source';
import { useHref, type Route } from '../router';
import { Drawer } from './Drawer';
import { Icon } from './Icon';
import { SidebarIcon, type SidebarIconName } from './SidebarIcons';

export interface NavCounts {
  awaiting: number | null;
  exceptions: { count: number; runId: string } | null;
}

interface Props {
  route: Route;
  views: SnapshotView[];
  viewId: string;
  onViewChange: (id: string) => void;
  spreadsheetTitle: string | null;
  checkedAt: string | null;
  counts: NavCounts;
  children: ReactNode;
}

type Section = 'overview' | 'review' | 'exceptions' | 'incoming' | 'catalog' | 'changes' | 'runs' | 'connection';

const SECTION: Record<Route['page'], Section | null> = {
  overview: 'overview', runs: 'runs', run: 'runs', review: 'review', exceptions: 'exceptions',
  catalog: 'catalog', changes: 'changes', incoming: 'incoming', connection: 'connection', 'not-found': null,
};

const SECTION_LABEL: Record<Section, string> = {
  overview: 'Overview', review: 'Review', exceptions: 'Exceptions', incoming: 'Incoming files', catalog: 'Catalog', changes: 'Change history', runs: 'Runs', connection: 'Connection',
};

interface Item { section: Section; path: string; icon: SidebarIconName; badge?: { text: string; attention: boolean; aria: string } }

export function AppShell({ route, views, viewId, onViewChange, spreadsheetTitle, checkedAt, counts, children }: Props) {
  const href = useHref();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = SECTION[route.page];
  // Any navigation closes the mobile menu.
  useEffect(() => { setMenuOpen(false); }, [route]);

  const sidebar = (variant: 'rail' | 'drawer') => (
    <Sidebar variant={variant} current={current} counts={counts} views={views} viewId={viewId}
      onViewChange={onViewChange} onNavigate={() => setMenuOpen(false)} />
  );

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      <div className="shell">
        <aside className="sidebar"><div className="sidebar-inner">{sidebar('rail')}</div></aside>
        <div className="workspace">
          <header className="topbar">
            <div className="topbar-left">
              <button type="button" className="button icon-button menu-button" aria-label="Open navigation"
                aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
                <Icon name="menu" />
              </button>
              <span className="topbar-title">
                <span className="topbar-sheet">{spreadsheetTitle ?? 'SheetOps'} <span aria-hidden="true">/</span> </span>
                {current ? <strong>{SECTION_LABEL[current]}</strong> : null}
              </span>
            </div>
            <div className="topbar-right">
              {checkedAt ? <span className="read-at">Read {checkedAt}</span> : null}
              <a className="demo-chip" href={href('/connection')}><span className="dot amber" aria-hidden="true" />Demo data · offline</a>
            </div>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} side="left" title="Navigation">
        <div className="nav-drawer"><div className="sidebar-inner">{menuOpen ? sidebar('drawer') : null}</div></div>
      </Drawer>
    </>
  );
}

function Sidebar({ variant, current, counts, views, viewId, onViewChange, onNavigate }: {
  variant: 'rail' | 'drawer';
  current: Section | null;
  counts: NavCounts;
  views: SnapshotView[];
  viewId: string;
  onViewChange: (id: string) => void;
  onNavigate: () => void;
}) {
  const href = useHref();
  const scenarioId = variant === 'rail' ? 'scenario' : 'scenario-menu';
  const selected = views.find((v) => v.id === viewId);
  const groups: Array<{ label: string; items: Item[] }> = [
    { label: 'Operate', items: [
      { section: 'overview', path: '/', icon: 'home' },
      { section: 'review', path: '/review', icon: 'inbox', badge: counts.awaiting === null ? undefined
        : { text: String(counts.awaiting), attention: counts.awaiting > 0, aria: `Review, ${counts.awaiting} awaiting a decision` } },
      { section: 'exceptions', path: '/exceptions', icon: 'alert', badge: counts.exceptions === null ? undefined
        : { text: String(counts.exceptions.count), attention: false, aria: `Exceptions, ${counts.exceptions.count} in run ${counts.exceptions.runId}` } },
      { section: 'incoming', path: '/incoming', icon: 'file' },
    ] },
    { label: 'Records', items: [
      { section: 'catalog', path: '/catalog', icon: 'box' },
      { section: 'changes', path: '/changes', icon: 'history' },
      { section: 'runs', path: '/runs', icon: 'play' },
    ] },
    { label: 'System', items: [
      { section: 'connection', path: '/connection', icon: 'plug' },
    ] },
  ];

  return (
    <>
      {variant === 'rail' ? (
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><SidebarIcon name="sheet" size={17} /></span>
          <span>
            <span className="brand-name">SheetOps</span>
            <span className="brand-sub">Operator console · read-only</span>
          </span>
        </div>
      ) : null}
      <nav aria-label="Main">
        {groups.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-group-label" id={`nav-${variant}-${g.label}`}>{g.label}</div>
            <ul className="nav-list" aria-labelledby={`nav-${variant}-${g.label}`}>
              {g.items.map((item) => (
                <li key={item.section}>
                  <a className="nav-link" href={href(item.path)} onClick={onNavigate}
                    aria-current={current === item.section ? 'page' : undefined} aria-label={item.badge?.aria}>
                    <SidebarIcon name={item.icon} />
                    <span className="nav-label">{SECTION_LABEL[item.section]}</span>
                    {item.badge ? <span className={`nav-count${item.badge.attention ? ' attention' : ''}`} aria-hidden="true">{item.badge.text}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <section className="env" aria-label="Demo data">
        <div className="env-title"><span className="dot" aria-hidden="true" />Demo · offline synthetic data. Not connected to Google.</div>
        <label htmlFor={scenarioId} className="xsmall muted">Scenario</label>
        <select id={scenarioId} className="input" value={viewId} onChange={(e) => onViewChange(e.target.value)} aria-describedby={`${scenarioId}-desc`}>
          {views.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
        </select>
        <details className="env-about">
          <summary>About this scenario</summary>
          <p id={`${scenarioId}-desc`}>{selected?.description}</p>
        </details>
      </section>
    </>
  );
}
