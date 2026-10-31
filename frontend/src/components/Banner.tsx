import { useId, type ReactNode } from 'react';
import type { Tone } from '../domain/runs';
import { Icon, type IconName } from './Icon';

const ICON: Record<Tone, IconName> = {
  blue: 'clock', green: 'check', violet: 'question', red: 'alert', amber: 'pause', neutral: 'info',
};

/** A status callout: a labelled section, so it is reachable by landmark. */
export function Banner({ tone, title, icon, children }: { tone: Tone; title: string; icon?: IconName; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`banner tone-${tone}`} aria-labelledby={id}>
      <span className="banner-icon"><Icon name={icon ?? ICON[tone]} size={18} /></span>
      <div className="banner-body">
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

/** Secondary explanatory text: quiet, with an icon, never a card. */
export function Note({ children, icon = 'info' }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="note">
      <Icon name={icon} size={14} />
      <div>{children}</div>
    </div>
  );
}
