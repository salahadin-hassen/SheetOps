import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * A side panel on the native <dialog>: showModal() traps focus, makes the page
 * behind it inert and closes on Escape. Focus returns to whatever opened it.
 * Where showModal is unavailable (older engines, jsdom) it falls back to the
 * `open` attribute.
 */
export function Drawer({ open, onClose, title, eyebrow, side = 'right', children, labelledBy }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  side?: 'left' | 'right';
  children: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const generated = useId();
  const titleId = labelledBy ?? generated;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      if (typeof dialog.showModal === 'function') {
        try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
      } else {
        dialog.setAttribute('open', '');
      }
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const el = opener.current as HTMLElement | null;
    if (el && typeof el.focus === 'function' && el.isConnected) el.focus();
    opener.current = null;
  }, [open]);

  return (
    <dialog ref={ref} className={`drawer${side === 'left' ? ' left' : ''}`} aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      {open ? (
        <>
          <div className="drawer-head">
            <div>
              {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
              <h2 id={titleId}>{title}</h2>
            </div>
            <button type="button" className="button icon-button" onClick={onClose} aria-label="Close" data-autofocus>
              <Icon name="cross" />
            </button>
          </div>
          <div className="drawer-body">{children}</div>
        </>
      ) : null}
    </dialog>
  );
}
