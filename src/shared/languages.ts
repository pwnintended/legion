/**
 * File name → language, for the project home's language bar and the file tree's icons. Only languages people
 * care to see in a breakdown are listed; lockfiles, images and data files map to null.
 */

const BY_EXT: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  m: 'Objective-C',
  mm: 'Objective-C',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  fs: 'F#',
  php: 'PHP',
  scala: 'Scala',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hs: 'Haskell',
  ml: 'OCaml',
  clj: 'Clojure',
  dart: 'Dart',
  lua: 'Lua',
  zig: 'Zig',
  nim: 'Nim',
  r: 'R',
  jl: 'Julia',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  html: 'HTML',
  htm: 'HTML',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'SCSS',
  less: 'Less',
  md: 'Markdown',
  mdx: 'Markdown',
  tf: 'HCL',
  hcl: 'HCL',
  proto: 'Protocol Buffers',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  sol: 'Solidity',
  vim: 'Vim Script',
  el: 'Emacs Lisp',
  nix: 'Nix',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  justfile: 'Makefile',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
};

/** The language of a path, or null (data, config, lockfiles, binaries, unknown). */
export function languageOfPath(path: string): string | null {
  const name = (path.split('/').at(-1) ?? path).toLowerCase();
  const byName = BY_NAME[name] ?? (name.startsWith('dockerfile') ? 'Dockerfile' : undefined);
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXT[name.slice(dot + 1)] ?? null;
}

/** Image types the file viewer previews (extension → MIME type). */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

export function imageMimeOf(path: string): string | null {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}
