// Small hand-drawn icon set (24x24, stroke based). Decorative: hidden from screen readers.
const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 8v5M12 16.5v.5M10.3 4.3L2.8 17.5A2 2 0 004.5 20.5h15a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z',
  info: 'M12 11v5M12 7.5v.5M12 21a9 9 0 100-18 9 9 0 000 18z',
  users: 'M16 20v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 18.5V20M10 11.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 4.7a3.5 3.5 0 010 6.6',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20a7.5 7.5 0 0115 0',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  logout: 'M9 20H5.5A1.5 1.5 0 014 18.5v-13A1.5 1.5 0 015.5 4H9M16 16l4-4-4-4M20 12H9',
  copy: 'M9 9h9.5a1.5 1.5 0 011.5 1.5V19a1.5 1.5 0 01-1.5 1.5H10A1.5 1.5 0 018.5 19V9.5M15 9V5.5A1.5 1.5 0 0013.5 4H5.5A1.5 1.5 0 004 5.5V14A1.5 1.5 0 005.5 15.5H9',
  refresh: 'M20 12a8 8 0 01-14 5.3M4 12a8 8 0 0114-5.3M18 3v4h-4M6 21v-4h4',
  crown: 'M4 18h16M5 8l3.5 4L12 6l3.5 6L19 8l-1 10H6L5 8z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  plus: 'M12 5v14M5 12h14',
  key: 'M14.5 9.5a4 4 0 11-3 3.9L4 20.5v-3h-3M15.5 8.5h.01',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7M10 11v5M14 11v5',
  chevron: 'M9 6l6 6-6 6',
  mail: 'M4 6.5h16v11H4zM4 7l8 6 8-6',
  door: 'M14 20V5l-8 2v13M14 20h5M10.5 12.5h.01',
};

export function Icon({ name, size = 18 }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
