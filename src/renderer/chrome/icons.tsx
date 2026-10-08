/** Inline stroke icons (24×24 grid, currentColor). */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const PATHS = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  strip: (
    <>
      <rect x="2" y="5" width="6" height="14" rx="1.5" />
      <rect x="10" y="5" width="6" height="14" rx="1.5" />
      <path d="M18 5h4M18 19h4M18 5v14" />
    </>
  ),
  focus: (
    <>
      <rect x="3" y="4" width="11" height="16" rx="1.5" />
      <rect x="16" y="4" width="5" height="7" rx="1" />
      <rect x="16" y="13" width="5" height="7" rx="1" />
    </>
  ),
  overview: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </>
  ),
  pipeline: (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M7 12c6 0 6-6 10-6M7 12c6 0 6 6 10 6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  terminal: (
    <>
      <path d="M4 17l6-5-6-5" />
      <path d="M12 19h8" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  alert: (
    <>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8" />
      <path d="M18 10c0 4-6 3-10 6" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4" />
    </>
  ),
  merge: (
    <>
      <circle cx="6" cy="18" r="2" />
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 8v8M8 6c5 0 8 2 8 4" />
    </>
  ),
  diff: (
    <>
      <path d="M12 3v8M8 7h8" />
      <path d="M8 17h8" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </>
  ),
  dag: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="3" width="6" height="6" rx="1.5" />
      <rect x="9" y="15" width="6" height="6" rx="1.5" />
      <path d="M6 9v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9M12 13v2" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
  session: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </>
  ),
  maximize: (
    <>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </>
  ),
  minimize: (
    <>
      <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
    </>
  ),
  collapse: (
    <>
      <path d="M9 4v16M15 4v16" />
      <path d="M4 12h2M18 12h2" />
    </>
  ),
  close: <path d="M18 6L6 18M6 6l12 12" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </>
  ),
  play: <path d="M6 4l14 8-14 8z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  layers: (
    <>
      <path d="M12 2l10 5-10 5L2 7z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.2" />
      <path d="M5 9v9a2 2 0 002 2h10a2 2 0 002-2V9M10 13h4" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" />,
  refresh: <path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" />,
  folder: <path d="M3.5 7.5A2 2 0 015.5 5.5h3.6l2 2.2h7.4a2 2 0 012 2v7.8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />,
  folderPlus: (
    <>
      <path d="M3.5 7.5A2 2 0 015.5 5.5h3.6l2 2.2h7.4a2 2 0 012 2v7.8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ),
  repo: (
    <>
      <path d="M5 19.5V5a2 2 0 012-2h12v14H7a2 2 0 00-2 2.5z" />
      <path d="M5 19.5A1.5 1.5 0 006.5 21H19v-4" />
      <path d="M9 7h6" />
    </>
  ),
  paperclip: (
    <path d="M20.6 11.3l-8.4 8.4a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.85 1.85 0 01-2.6-2.6l8-8" />
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M21 16l-5-5-9 9" />
    </>
  ),
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUpDown: <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />,
  fileCode: (
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5M10 12.5l-2 2 2 2M14 12.5l2 2-2 2" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  folderOpen: (
    <path d="M3.5 18.3V7.5a2 2 0 012-2h3.6l2 2.2h6.4a2 2 0 012 2v1.3M3.5 18.3l2.3-6.1a1.5 1.5 0 011.4-1h13.1a1 1 0 01.9 1.3l-2 6a1.5 1.5 0 01-1.4 1H5a1.5 1.5 0 01-1.5-1.2z" />
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.2 1.2" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.2-1.2" />
    </>
  ),
  commit: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12h5.5M15.5 12H21" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5L12 4l8 6.5" />
      <path d="M6 9v10a1 1 0 001 1h3.5v-5h3v5H17a1 1 0 001-1V9" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A1.5 1.5 0 015.5 4H11v16H5.5A1.5 1.5 0 014 18.5z" />
      <path d="M20 5.5A1.5 1.5 0 0018.5 4H13v16h5.5a1.5 1.5 0 001.5-1.5z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  pin: <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6" />,
  editor: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12.5 15H17" />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 12.6V5a1.5 1.5 0 011.5-1.5h7.6l8 8a1.5 1.5 0 010 2.1l-7.5 7.5a1.5 1.5 0 01-2.1 0z" />
      <circle cx="8" cy="8" r="1.3" />
    </>
  ),
  quote: <path d="M5 8h14M5 12h14M5 16h9" />,
  chat: (
    <path d="M5 5.5h14a1.5 1.5 0 011.5 1.5v8.5a1.5 1.5 0 01-1.5 1.5h-7.5L7 20.5V17H5a1.5 1.5 0 01-1.5-1.5V7A1.5 1.5 0 015 5.5z" />
  ),
  agents: (
    <>
      <rect x="3.5" y="4" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="4" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="14" width="7" height="6" rx="1.6" />
      <rect x="13.5" y="14" width="7" height="6" rx="1.6" />
    </>
  ),
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, strokeWidth = 2, ...rest }: IconProps & { name: IconName }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Legion mark: three staggered columns (a strip of agents). */
export function LegionMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="6" width="5.5" height="14" rx="1.6" fill="var(--mauve)" opacity="0.55" />
      <rect x="9.25" y="3" width="5.5" height="18" rx="1.6" fill="var(--mauve)" />
      <rect x="16.5" y="6" width="5.5" height="14" rx="1.6" fill="var(--teal)" opacity="0.8" />
    </svg>
  );
}
