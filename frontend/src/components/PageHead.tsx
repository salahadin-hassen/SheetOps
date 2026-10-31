import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { NavigatedContext } from '../router';

/**
 * The page title. After a screen change focus moves to it, so a screen
 * reader announces the new screen and keyboard users continue from the top.
 * On first load focus stays at the start of the page (skip link first).
 */
export function PageHead({ title, lead, eyebrow, children }: { title: string; lead?: ReactNode; eyebrow?: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const navigated = useContext(NavigatedContext);
  const navigatedRef = useRef(navigated);
  navigatedRef.current = navigated;
  // Runs when a screen mounts or its title changes, never when only the
  // navigation flag flips: following a link within one screen (a Review item)
  // keeps focus on that link.
  useEffect(() => {
    document.title = `${title} · SheetOps console (demo)`;
    // Leave focus on the scenario picker when the change came from it.
    if (!navigatedRef.current || document.activeElement?.id.startsWith('scenario')) return;
    ref.current?.focus();
  }, [title]);
  return (
    <div className="page-head">
      <div className="page-head-text">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 ref={ref} tabIndex={-1}>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}
