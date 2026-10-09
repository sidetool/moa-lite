import { useCallback, useEffect, useState, type RefObject } from "react";

type DocumentPip = { requestWindow(options?: { width?: number; height?: number }): Promise<Window>; window: Window | null };
const documentPip = () => (window as Window & { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

export const documentPipSupported = () => typeof window !== "undefined" && Boolean(documentPip());

/**
 * Video-element PiP only shows decoded frames, so overlays, libass canvases and the player UI stay behind.
 * Document PiP moves the whole player slot instead; the React portal keeps its event listeners on the slot.
 */
export function useDocumentPip(slot: HTMLElement, host: RefObject<HTMLElement | null>) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const open = useCallback(async (width: number, height: number) => {
    const pip = await documentPip()!.requestWindow({ width, height });
    const doc = pip.document;
    for (const node of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')) {
      const copy = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
      if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href;
      doc.head.append(copy);
    }
    for (const { name, value } of Array.from(document.documentElement.attributes)) doc.documentElement.setAttribute(name, value);
    doc.title = document.title;
    doc.body.className = "watch-pip";
    doc.body.append(slot);
    pip.addEventListener("pagehide", () => { host.current?.append(slot); setPipWindow(null); }, { once: true });
    setPipWindow(pip);
  }, [slot, host]);
  // Leaving the watch page ends PiP; the slot has nowhere to return to.
  useEffect(() => () => { if (documentPip()?.window && slot.ownerDocument !== document) documentPip()!.window!.close(); }, [slot]);
  return { pipWindow, open };
}
