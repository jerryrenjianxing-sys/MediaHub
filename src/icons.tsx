import type { CSSProperties } from 'react';

export type IconName = 'hub' | 'connect' | 'grid' | 'folder' | 'image' | 'activity' | 'settings' | 'copy' | 'download' | 'arrow' | 'refresh' | 'sun' | 'moon' | 'monitor' | 'plus' | 'close' | 'check' | 'alert' | 'chevron' | 'play' | 'pause' | 'trash' | 'external' | 'video' | 'search' | 'terminal' | 'file' | 'stop' | 'shield';
const paths: Record<IconName, React.ReactNode> = {
  hub: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7m-3.5-3.5h7"/></>,
  connect: <><path d="m10 13 4-4m-7 7-2 2a4.24 4.24 0 0 1-6-6l4-4a4.24 4.24 0 0 1 6 0" transform="translate(3 0)"/><path d="m14 11 2-2a4.24 4.24 0 0 0-6-6L6 7" transform="translate(3 0)"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/></>,
  activity: <><path d="M3 7h10m-10 5h7m-7 5h5"/><path d="m13 17 3-6 2 3 3-8"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1-2 3 2 2-2 2 2 3 3 1 1 3h6l1-3 3-1 2-3-2-2 2-2-2-3-3-1-1-3Z"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M4 16v4h16v-4"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5m-4 6a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>,
  monitor: <><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></>,
  plus: <path d="M12 4v16M4 12h16"/>, close: <path d="m6 6 12 12M6 18 18 6"/>, check: <path d="m4 12 5 5L20 6"/>,
  alert: <><path d="m12 3 10 18H2Z"/><path d="M12 9v4m0 3v1"/></>, chevron: <path d="m9 5 7 7-7 7"/>,
  play: <path d="m8 4 12 8-12 8Z"/>, pause: <path d="M8 5v14M16 5v14"/>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  external: <><path d="M14 3h7v7m0-7L10 14M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/></>,
  video: <><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>,
  search: <><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
  file: <><path d="M14 3H5v18h14V8ZM14 3v5h5"/><path d="M8 12h8m-8 4h8"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5"/>,
  shield: <><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
};
export default function Icon({ name, className = '', style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={`icon ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
