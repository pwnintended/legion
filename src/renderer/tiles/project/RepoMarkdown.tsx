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
import { absolutizeRepoLinks, repoTarget } from './links';

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
          const resolved = typeof src === 'string' ? repoTarget(src, path) : null;
          const alt = typeof props.alt === 'string' ? props.alt : '';
          return resolved ? <RepoImage projectId={projectId} path={resolved} alt={alt} /> : null;
        },
        a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
          const href = typeof props.href === 'string' ? props.href : undefined;
          const children: ReactNode = props.children;
          const target = href ? repoTarget(href, path) : null;
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
  const source = useMemo(() => absolutizeRepoLinks(text, path), [text, path]);
  return <Markdown text={source} streaming={false} caret={false} components={components} />;
}
