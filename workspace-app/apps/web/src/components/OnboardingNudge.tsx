/** Stuk E1: kleine link in de zijbalk zolang de onboarding niet af is ("Inrichten · 3/8"). Niets bij dev-login. */
import { Link, useLocation } from 'react-router';
import { ONBOARDING_STEPS } from '@hz/shared';
import { useOnboarding } from '../lib/e1';
import { Icon } from '../lib/icons';

export function OnboardingNudge() {
  const ob = useOnboarding().data;
  const loc = useLocation();
  if (!ob || ob.status === 'none' || ob.status === 'done' || loc.pathname === '/welkom') return null;
  const done = Object.keys(ob.steps).length;
  return (
    <Link to={`/welkom?stap=${ob.step}`} className="ob-nudge" title="Verder met inrichten (g w)">
      <Icon name="spark" />
      <span>Inrichten</span>
      <span className="count">
        {done}/{ONBOARDING_STEPS.length}
      </span>
    </Link>
  );
}
