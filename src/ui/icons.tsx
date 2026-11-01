import type { JSX } from 'react';

const paths: Record<string, JSX.Element> = {
  select: <path d="M5 3l12 7-5 1.5L9.5 17z" />,
  line: (
    <>
      <path d="M4 16L16 4" />
      <circle cx="4" cy="16" r="1.6" />
      <circle cx="16" cy="4" r="1.6" />
    </>
  ),
  polyline: <path d="M3 16l5-7 4 4 5-9" />,
  arc: <path d="M3 16c1.5-7 6.5-11 14-11M3 16v.1M17 5v.1" />,
  curved: <path d="M3 17c2-8 7-12 14-13M6 15.5V9.5M10.5 12.5V6.5M15 11V4.5" />,
  mitre: <path d="M3 17V3h14M7 17V7h10M3 3l4 4" />,
  fit: <path d="M14 3v14M3 8h9v4H3" />,
  stiffener: <path d="M4 3h12M4 17h12M10 3v14M11.5 6h3.5v8h-3.5" />,
  plate: <path d="M3 14l4-10 9 3-2 9z" />,
  bent: <path d="M3 6h7a5 5 0 015 5v6" />,
  grid: <path d="M3 3h14v14H3zM8 3v14M13 3v14M3 8h14M3 13h14" />,
  move: <path d="M10 2v16M2 10h16M10 2l-2.5 2.5M10 2l2.5 2.5M10 18l-2.5-2.5M10 18l2.5-2.5M2 10l2.5-2.5M2 10l2.5 2.5M18 10l-2.5-2.5M18 10l-2.5 2.5" />,
  copy: <path d="M7 7h10v10H7zM3 13V3h10" />,
  array: <path d="M3 5h4v4H3zM9 5h4v4H9zM15 5h2v4h-2zM3 12h4v4H3zM9 12h4v4H9z" />,
  split: <path d="M3 10h5M12 10h5M10 3v14" />,
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />,
  profile: <path d="M4 4h12v3H11.5v6H16v3H4v-3h4.5V7H4z" />,
  auto: <path d="M10 2l2 5 5 .5-4 3.5 1.5 5L10 13l-4.5 3L7 11 3 7.5 8 7z" />,
  bolt: (
    <>
      <path d="M6 3h8l2 3-2 3H6L4 6z" />
      <path d="M8 9v9M12 9v9" />
    </>
  ),
  bracket: <path d="M4 3v14h3V8h9V5H7V3z" />,
  table: <path d="M3 4h14v12H3zM3 8h14M3 12h14M8 4v12" />,
  nest: <path d="M2 6h16M2 10h16M2 14h16M7 4v4M12 8v4M5 12v4M15 12v4" />,
  drawing: <path d="M3 3h14v14H3zM3 13h14M11 13v4M6 6h6v4H6z" />,
  export: <path d="M10 3v10M6 7l4-4 4 4M4 13v4h12v-4" />,
  import: <path d="M10 13V3M6 9l4 4 4-4M4 13v4h12v-4" />,
  undo: <path d="M7 5L3 9l4 4M3 9h9a5 5 0 010 10h-2" />,
  redo: <path d="M13 5l4 4-4 4M17 9H8a5 5 0 000 10h2" />,
  eye: (
    <>
      <path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z" />
      <circle cx="10" cy="10" r="2.5" />
    </>
  ),
  measure: <path d="M2 14l12-12 4 4L6 18zM6 10l2 2M9 7l2 2M12 4l2 2" />,
  // Modify group
  join: <path d="M2 10h6M12 10h6M8 7l3 3-3 3M12 7l-3 3 3 3" />,
  extend: <path d="M3 10h9M12 7l3 3-3 3M17 4v12" />,
  trim: <path d="M10 3v14M3 10h7M13 7l4 6M17 7l-4 6" />,
  break: <path d="M2 10h6M12 10h6M8 6v8M12 6v8" />,
  stretch: <path d="M3 16L12 7M12 7h-4M12 7v4M15 4l2 2" />,
  rotate: <path d="M15.5 6.5A6.5 6.5 0 104 13M15.5 3v3.5H12M10 10v.1" />,
  mirror: <path d="M10 2v16M3 5l4 2v6l-4 2zM17 5l-4 2v6l4 2z" />,
  offset: <path d="M3 14L14 3M7 17L17 7M14 3l3 0M17 7V4" />,
  reverse: <path d="M3 7h12l-3-3M17 13H5l3 3" />,
  match: <path d="M4 3h8v4H4zM8 7v3h6v7M12 17h4" />,
  section: <path d="M6 4h8v3h-2.5v6H14v3H6v-3h2.5V7H6zM16.5 8a7 7 0 01-1 7" />,
  plane: <path d="M2 14l6-8h10l-6 8z" />,
  zoom: <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />,
  file: <path d="M5 2h7l4 4v12H5zM12 2v4h4" />,
  check: <path d="M4 10l4 4 8-8" />,
  warn: <path d="M10 3l8 14H2zM10 8v4M10 14.5v.5" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  plus: <path d="M10 4v12M4 10h12" />,
  chevron: <path d="M6 8l4 4 4-4" />,
  layers: <path d="M10 3l8 4-8 4-8-4zM2 11l8 4 8-4" />,
  calibrate: <path d="M3 15h14M3 12v6M17 12v6M6 15v-2M10 15v-3M14 15v-2" />,
  help: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.8 7.8a2.3 2.3 0 114 1.6c-.9.7-1.8 1.2-1.8 2.4M10 14.5v.3" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.file}
    </svg>
  );
}
