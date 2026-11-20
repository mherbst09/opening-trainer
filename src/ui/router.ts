import { useEffect, useState } from 'react';

export interface Route {
  path: string[]; // e.g. ['learn', 'italian-game']
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p, q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(path: string, params?: Record<string, string>): string {
  const q = params ? `?${new URLSearchParams(params).toString()}` : '';
  return `#/${path}${q}`;
}

export function navigate(path: string, params?: Record<string, string>) {
  window.location.hash = href(path, params).slice(1);
}
