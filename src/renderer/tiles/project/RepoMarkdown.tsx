/**
 * Markdown from a repository (README, docs): relative images are loaded from the project (`files.read`, as
 * data URLs — remote images would be blocked by the CSP and are left out), relative links open the file in
 * the code viewer, web links open in the browser.
 */
import { type ReactNode, useMemo } from 'react';
import type { Components } from 'streamdown';
import { openFile } from '../../app/project-actions';
import { Markdown } from '../session/Markdown';
import '../session/session.css';
import { openUrl, useFile } from './kit';

/** Resolve `rel` against the directory of `fromPath` (repo-relative); null when it leaves the repo or is a URL. */
export function resolveRepoPath(fromPath: string, rel: string): string | null {
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//') || rel.startsWith('#')) return null;
  const clean = decodeURIComponent(rel.split('#')[0]?.split('?')[0] ?? '');
  if (!clean) return null;
  const segments = clean.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.length ? segments.join('/') : null;
}

function RepoImage({ projectId, path, alt }: { projectId: string; path: string; alt: string }) {
  const file = useFile(projectId, path);
  const image = file.data?.image;
  if (!image) return file.loading ? <span className="md-img-pending" aria-hidden="true" /> : null;
  return <img src={`data:${image.mime};base64,${image.base64}`} alt={alt} className="md-repo-img" />;
}

export function RepoMarkdown({ projectId, path, text }: { projectId: string; path: string; text: string }) {
  const components = useMemo(
    () =>
      ({
        img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => {
          const src = props.src;
          const resolved = typeof src === 'string' ? resolveRepoPath(path, src) : null;
          const alt = typeof props.alt === 'string' ? props.alt : '';
          return resolved ? <RepoImage projectId={projectId} path={resolved} alt={alt} /> : null;
        },
        a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
          const href = typeof props.href === 'string' ? props.href : undefined;
          const children: ReactNode = props.children;
          const target = href ? resolveRepoPath(path, href) : null;
          return (
            <a
              href={href}
              title={target ?? href}
              onClick={(event) => {
                event.preventDefault();
                if (target) openFile(projectId, target, { anchorTileId: null });
                else if (href) openUrl(href);
              }}
            >
              {children}
            </a>
          );
        },
      }) as Partial<Components>,
    [projectId, path],
  );
  return <Markdown text={text} streaming={false} caret={false} components={components} />;
}
