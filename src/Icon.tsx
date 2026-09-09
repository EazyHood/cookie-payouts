import type { SVGProps } from "react";

const paths = {
  wallet: <><path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6"/><path d="M20 12h-5v5h5"/><path d="M17 14.5h.01"/></>,
  send: <><path d="m21 3-7 18-4-7-7-4 18-7Z"/><path d="m10 14 11-11"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  compare: <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4 4-4-4 4-4"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
  receipt: <><path d="M5 3v18l3-2 4 2 4-2 3 2V3l-3 2-4-2-4 2-3-2Z"/><path d="M9 9h6m-6 4h6"/></>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  users: <><path d="M3 21v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3m3-7a4 4 0 0 1 3 4v3M17 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  file: <><path d="M14 2H4v20h16V8l-6-6Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/></>,
  shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/></>,
};

export function Icon({name,size=20,...props}: {name:keyof typeof paths;size?:number}&SVGProps<SVGSVGElement>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
