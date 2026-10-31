import type { FeedbackRect } from "./feedback-types";
export async function captureStill(hide: (hidden: boolean) => void, signal: AbortSignal): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture is unavailable in this browser. You can still send comments.");
  // Offer the application tab while retaining the browser-owned chooser and permission.
  const options: DisplayMediaStreamOptions & { preferCurrentTab: boolean; selfBrowserSurface: string } = {
    video: true, audio: false, preferCurrentTab: true, selfBrowserSurface: "include",
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const video = document.createElement("video");
  const stop = () => { stream.getTracks().forEach(t => t.stop()); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted(); hide(true);
    // Let the hidden overlay reach the compositor before consuming the live stream.
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    signal.throwIfAborted();
    video.muted = true; video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      let frame: number | undefined, fallback: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timeout); clearTimeout(fallback); signal.removeEventListener("abort", abort);
        if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      };
      const fail = (error: unknown) => { cleanup(); reject(error); };
      const abort = () => fail(signal.reason);
      const ready = () => { cleanup(); resolve(); };
      const timeout = setTimeout(() => fail(new Error("The capture source did not produce a frame.")), 5000);
      signal.addEventListener("abort", abort, { once: true });
      // Register before play: static tab capture may deliver only one frame until pixels change.
      if ("requestVideoFrameCallback" in video) frame = video.requestVideoFrameCallback(ready);
      video.srcObject = stream;
      void video.play().then(() => {
        if (!("requestVideoFrameCallback" in video)) fallback = setTimeout(ready, 150);
      }, fail);
    });
    signal.throwIfAborted();
    if (!video.videoWidth || !video.videoHeight) throw new Error("The selected capture surface has no image.");
    const scale = Math.min(1, 2560 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas);
  } finally { stop(); signal.removeEventListener("abort", stop); video.srcObject = null; hide(false); }
}
export async function cropStill(blob: Blob, crop: FeedbackRect | null): Promise<Blob> {
  if (!crop) return blob;
  const image = await createImageBitmap(blob);
  try {
    const x = Math.max(0, Math.min(image.width - 1, Math.floor(crop.x * image.width))), y = Math.max(0, Math.min(image.height - 1, Math.floor(crop.y * image.height)));
    const width = Math.max(1, Math.min(image.width - x, Math.round(crop.width * image.width)));
    const height = Math.max(1, Math.min(image.height - y, Math.round(crop.height * image.height)));
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    canvas.getContext("2d")!.drawImage(image, x, y, width, height, 0, 0, width, height);
    return await canvasBlob(canvas);
  } finally { image.close(); }
}
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode the screenshot.")), "image/png"));
}
