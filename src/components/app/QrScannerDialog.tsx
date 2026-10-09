import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Camera,
  Clipboard,
  Image as ImageIcon,
  RefreshCw,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { beginOp } from "@/lib/backup-log";
import { ensureCameraPermission } from "@/lib/camera-permission";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LayoutPart, LayoutParts } from "./LayoutSection";

// Scan failures are logged by stable code only: never the scanned text.
const logScanFailure = (summary: string, errorCode: string) => {
  try {
    beginOp("telegram-config", summary).finish("error", summary, { errorCode });
  } catch {
    /* observer */
  }
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (text: string) => void;
  title?: string;
  hint?: string;
};

/**
 * Camera / image / paste QR scanner pop-up.
 *
 * Registered in Layout & arrangement as `surface.qr-scanner`
 * (see SURFACE_REGISTRY in `src/lib/layout-parts.ts`). All three parts are
 * locked: they can be moved but not hidden, because hiding any of them would
 * remove a way to enter the details.
 */
export function QrScannerDialog({
  open,
  onOpenChange,
  onResult,
  title = "Scan QR code",
  hint = "Point the rear camera at a QR code.",
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onResultRef = useRef(onResult);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onResultRef.current = onResult;
    onOpenChangeRef.current = onOpenChange;
  }, [onResult, onOpenChange]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Every start of the camera takes a ticket. stop() (and the effect cleanup)
  // bumps it, so any start still awaiting the permission prompt or
  // getUserMedia sees a stale ticket, releases what it got, and exits. This
  // replaces the old "starting" flag, which could block a legitimate restart
  // (quick camera switch, Retry) while a previous start was still pending.
  const run = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [startingCamera, setStartingCamera] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [torch, setTorch] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState("");

  const stop = () => {
    run.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setTorchAvailable(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => {
    if (!open) return;
    const ticket = ++run.current;
    const current = () => ticket === run.current;
    setError(null);
    setManual(false);
    setStartingCamera(true);
    void (async () => {
      try {
        if (!window.isSecureContext) throw new Error("insecure");
        if (!(await ensureCameraPermission()))
          throw new DOMException("denied", "NotAllowedError");
        if (!current()) return;
        const jsQR = (await import("jsqr")).default;
        // Preferred constraints first; if the device rejects them (stale
        // deviceId, no rear camera) fall back to "any camera" instead of
        // dead-ending on OverconstrainedError.
        const candidates: MediaStreamConstraints[] = [
          {
            video: deviceId
              ? { deviceId: { exact: deviceId } }
              : { facingMode: { ideal: "environment" } },
            audio: false,
          },
          { video: true, audio: false },
        ];
        let stream: MediaStream | null = null;
        for (const [index, constraints] of candidates.entries()) {
          try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            break;
          } catch (e) {
            const retryable =
              e instanceof DOMException &&
              (e.name === "OverconstrainedError" || e.name === "NotFoundError");
            if (!retryable || index === candidates.length - 1) throw e;
          }
        }
        if (!stream) throw new DOMException("no stream", "NotFoundError");
        if (!current()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as
          (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        setTorchAvailable(Boolean(capabilities?.torch));
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === "videoinput",
        );
        if (!current()) return;
        setDevices(cams);
        const video = videoRef.current;
        if (!video) {
          stop();
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (!current()) return;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        let last = 0;
        const loop = (now: number) => {
          if (!current() || !ctx) return;
          if (now - last >= 150 && video.readyState >= 2 && video.videoWidth) {
            last = now;
            const scale = Math.min(1, 720 / video.videoWidth);
            canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const found = jsQR(image.data, image.width, image.height);
            if (found?.data) {
              stop();
              onResultRef.current(found.data);
              onOpenChangeRef.current(false);
              return;
            }
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      } catch (e) {
        if (!current()) return;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const name = e instanceof DOMException ? e.name : "";
        const code =
          name === "NotAllowedError"
            ? "camera-denied"
            : name === "NotFoundError"
              ? "camera-not-found"
              : name === "NotReadableError"
                ? "camera-busy"
                : name === "OverconstrainedError"
                  ? "camera-constraints"
                  : e instanceof Error && e.message === "insecure"
                    ? "camera-insecure"
                    : "unknown";
        logScanFailure("Camera scanner could not start", code);
        setError(
          name === "NotAllowedError"
            ? "Camera permission was denied. On Android, allow Camera for this app in Settings > Apps > Truff Snacks > Permissions. On Windows, allow Camera in Settings > Privacy & security > Camera."
            : name === "NotFoundError"
              ? "No camera was found. Choose an image or enter the details manually."
              : name === "NotReadableError"
                ? "The camera is busy in another app. Close that app and try again, or choose an image."
                : name === "OverconstrainedError"
                  ? "This camera can't start in the requested mode. Retry, or choose an image."
                  : e instanceof Error && e.message === "insecure"
                    ? "Camera access requires a secure app context. Choose an image or enter the details manually."
                    : "Camera could not start. Choose an image, paste the details, or enter them manually.",
        );
      } finally {
        if (current()) setStartingCamera(false);
      }
    })();
    return () => stop();
    // The camera is controlled only by open / device selection / explicit retry. Parent callback identity and torch changes must not restart it.
  }, [open, deviceId, attempt]);

  useEffect(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchAvailable) return;
    // `torch` is a real but non-standard constraint, so it is missing from lib.dom's MediaTrackConstraintSet.
    void track
      .applyConstraints({
        advanced: [{ torch }],
      } as unknown as MediaTrackConstraints)
      .catch(() => setTorch(false));
  }, [torch, torchAvailable]);

  const chooseDevice = () => {
    if (devices.length < 2) return;
    const activeId =
      deviceId ||
      streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ||
      "";
    const index = devices.findIndex((d) => d.deviceId === activeId);
    const nextIndex = index >= 0 ? (index + 1) % devices.length : 1;
    setDeviceId(devices[nextIndex]?.deviceId ?? devices[0]?.deviceId ?? "");
  };

  const scanImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    let img: ImageBitmap | null = null;
    try {
      const jsQR = (await import("jsqr")).default;
      img = await createImageBitmap(f);
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 1200 / img.width);
      canvas.width = Math.max(1, Math.floor(img.width * scale));
      canvas.height = Math.max(1, Math.floor(img.height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const r = jsQR(d.data, d.width, d.height);
      if (!r) throw new Error("no-qr");
      onResultRef.current(r.data);
      stop();
      onOpenChangeRef.current(false);
    } catch {
      logScanFailure("No QR code found in chosen image", "no-qr");
      toast.error("No QR code was found in that image.");
    } finally {
      img?.close();
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error();
      onResultRef.current(text);
      stop();
      onOpenChangeRef.current(false);
    } catch {
      logScanFailure(
        "Clipboard was empty or unavailable",
        "clipboard-unavailable",
      );
      toast.error("Clipboard is empty or unavailable.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) stop();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <LayoutParts surfaceId="surface.qr-scanner" className="space-y-3">
          <LayoutPart id="surface.qr-scanner.camera">
            {error ? (
              <div className="rounded-xl border p-3 text-sm text-muted-foreground">
                {error}
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-xl bg-black">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="aspect-square w-full object-cover"
                />
                <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-2 border-white/80" />
                {startingCamera && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-sm font-medium text-white">
                    Camera starting…
                  </div>
                )}
              </div>
            )}
          </LayoutPart>
          {manual && (
            <LayoutPart id="surface.qr-scanner.manual">
              <div className="space-y-2 rounded-xl border p-3">
                <label
                  className="text-sm font-medium"
                  htmlFor="qr-manual-value"
                >
                  Telegram details
                </label>
                <Input
                  id="qr-manual-value"
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  placeholder="Paste a bot token, chat ID, or pairing text"
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <Button
                  disabled={!manualText.trim()}
                  onClick={() => {
                    onResultRef.current(manualText.trim());
                    setManual(false);
                    setManualText("");
                    onOpenChangeRef.current(false);
                  }}
                >
                  Use entered details
                </Button>
              </div>
            </LayoutPart>
          )}
          <LayoutPart id="surface.qr-scanner.tools">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                <ImageIcon className="mr-1 h-4 w-4" />
                Choose image
              </Button>
              <Button variant="outline" onClick={paste}>
                <Clipboard className="mr-1 h-4 w-4" />
                Paste
              </Button>
              {devices.length > 1 && (
                <Button variant="outline" onClick={chooseDevice}>
                  <RefreshCw className="mr-1 h-4 w-4" />
                  Switch camera
                </Button>
              )}
              {torchAvailable && (
                <Button
                  variant={torch ? "default" : "outline"}
                  onClick={() => setTorch((v) => !v)}
                >
                  <Zap className="mr-1 h-4 w-4" />
                  Torch
                </Button>
              )}
              {error && (
                <Button
                  variant="outline"
                  onClick={() => {
                    stop();
                    setDeviceId("");
                    setError(null);
                    setAttempt((n) => n + 1);
                  }}
                >
                  Retry camera
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  stop();
                  setManual(true);
                }}
              >
                <Camera className="mr-1 h-4 w-4" />
                Enter manually
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={scanImage}
              />
            </div>
          </LayoutPart>
        </LayoutParts>
      </DialogContent>
    </Dialog>
  );
}
