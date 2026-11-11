import type { SVGProps } from 'react';

const paths = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></>,
  policies: <><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  agent: <><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M9 13h.01M15 13h.01M9 17h6" /></>,
  transactions: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></>,
  audit: <><path d="M4 4v6h6M20 20v-6h-6" /><path d="M5.5 15a7 7 0 0 0 12 2L20 14M18.5 9a7 7 0 0 0-12-2L4 10" /></>,
  lab: <><path d="M9 3h6M10 3v6l-5.5 9.1A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.9L14 9V3" /><path d="M8 15h8" /></>,
  shield: <><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
} satisfies Record<string, React.ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
