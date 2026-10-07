/// <reference lib="webworker" />
/** Syntax highlighting off the main thread: `HighlightRequest` in, `HighlightResponse` out. */
import { type HighlightRequest, highlight } from './highlighter';

self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  void highlight(event.data).then(
    (response) => self.postMessage(response),
    () => self.postMessage({ id: event.data.id, blocks: event.data.blocks.map(() => null) }),
  );
};
