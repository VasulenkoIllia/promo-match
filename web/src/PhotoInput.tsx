import { type ChangeEvent, type DragEvent, type PointerEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { cropRect, fullRect, MIN_CROP_SIDE_PX, outputSize, type Point, type Rect } from "./image";
import { text } from "./text";
import "./photo.css";

// The photo as chosen, before the crop is applied (image.ts, encodeJpeg): its object URL is revoked when it is replaced
export interface Photo {
  url: string;
  image: HTMLImageElement;
  width: number;
  height: number;
  crop: Rect | null;
}

// A phone photo is a few MB; a larger file is more likely a mistake than a reference
const MAX_SOURCE_MB = 40;
const BYTES_IN_MB = 1024 * 1024;
// The file picker's accept applies to the picker only: a drop or a paste is checked here
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

class PhotoError extends Error {
  override name = "PhotoError";
}

// The browser decodes the file and the canvas re-encodes it as a JPEG (image.ts); a file of no type (some drops) is
// tried, and one the browser cannot show, or shows without a size (an SVG), is refused
async function loadPhoto(file: File): Promise<Photo> {
  if (file.type && !ACCEPTED_TYPES.includes(file.type)) throw new PhotoError(text.photo.notImage);
  if (file.size > MAX_SOURCE_MB * BYTES_IN_MB) throw new PhotoError(text.photo.tooLarge(MAX_SOURCE_MB));
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new PhotoError(text.photo.unreadable);
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new PhotoError(text.photo.unreadable);
  }
  return { url, image, width: image.naturalWidth, height: image.naturalHeight, crop: null };
}

// Whether a paste goes into a field: text copied from a sheet or a page often carries an image of itself too
function isTextPaste(event: ClipboardEvent): boolean {
  const target = event.target;
  const isField = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    || (target instanceof HTMLElement && target.isContentEditable);
  return isField && Boolean(event.clipboardData?.types.includes("text/plain"));
}

function percent(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

interface CropAreaProps {
  photo: Photo;
  onCrop: (crop: Rect | null) => void;
}

interface Drag {
  from: Point;
  to: Point;
  // The photo's pixels per MIN_CROP_SIDE_PX on screen, as it is shown
  minSidePx: number;
}

// A frame drawn by dragging over the photo; a click without a drag clears it
function CropArea({ photo, onCrop }: CropAreaProps) {
  const [drag, setDrag] = useState<Drag | null>(null);

  const pointOf = (event: PointerEvent<HTMLDivElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * photo.width,
      y: ((event.clientY - box.top) / box.height) * photo.height,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointOf(event);
    const minSidePx = (MIN_CROP_SIDE_PX * photo.width) / event.currentTarget.getBoundingClientRect().width;
    setDrag({ from: point, to: point, minSidePx });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ ...drag, to: pointOf(event) });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    onCrop(cropRect(drag.from, pointOf(event), photo, drag.minSidePx));
    setDrag(null);
  };

  const frame = drag ? cropRect(drag.from, drag.to, photo, drag.minSidePx) : photo.crop;
  return (
    <div className="crop">
      <img src={photo.url} alt={text.photo.cropLabel} draggable={false} />
      <div
        className="crop-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {frame && (
          <div
            className="crop-frame"
            style={{
              left: percent(frame.x, photo.width), top: percent(frame.y, photo.height),
              width: percent(frame.width, photo.width), height: percent(frame.height, photo.height),
            }}
          />
        )}
      </div>
    </div>
  );
}

interface PhotoInputProps {
  photo: Photo | null;
  onChange: (photo: Photo | null) => void;
}

export function PhotoInput({ photo, onChange }: PhotoInputProps) {
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A file chosen while another still loads wins, whichever finishes first
  const loadCount = useRef(0);

  const replace = (next: Photo | null) => {
    if (photo) URL.revokeObjectURL(photo.url);
    onChange(next);
  };

  const take = async (file: File) => {
    const load = ++loadCount.current;
    setError(null);
    try {
      const next = await loadPhoto(file);
      if (load !== loadCount.current) {
        URL.revokeObjectURL(next.url);
        return;
      }
      replace(next);
    } catch (caught) {
      if (load !== loadCount.current) return;
      if (!(caught instanceof PhotoError)) console.error(caught);
      setError(caught instanceof PhotoError ? caught.message : text.photo.unreadable);
    }
  };

  const remove = () => {
    // A photo still loading would come back after it
    loadCount.current += 1;
    setError(null);
    replace(null);
  };

  // A screenshot pasted anywhere on the page; pasted text goes where the cursor is, as usual
  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    if (isTextPaste(event)) return;
    const file = [...event.clipboardData?.files ?? []].find((each) => each.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    void take(file);
  });

  useEffect(() => {
    const listener = (event: ClipboardEvent) => onPaste(event);
    // A file dropped past the drop area would make the browser open it in place of the page
    const ignoreDrop = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("paste", listener);
    window.addEventListener("dragover", ignoreDrop);
    window.addEventListener("drop", ignoreDrop);
    return () => {
      window.removeEventListener("paste", listener);
      window.removeEventListener("dragover", ignoreDrop);
      window.removeEventListener("drop", ignoreDrop);
    };
  }, []);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same file chosen again fires change again
    event.target.value = "";
    if (file) void take(file);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) void take(file);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragOver(true);
  };

  const size = photo ? outputSize(photo.crop ?? fullRect(photo)) : null;
  return (
    <section
      className={isDragOver ? "panel-block drop-target is-over" : "panel-block drop-target"}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        // Leaving for a child of the area is not leaving it
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setIsDragOver(false);
      }}
      onDrop={onDrop}
    >
      <h2>{text.photo.heading}</h2>
      {photo ? (
        <>
          <CropArea key={photo.url} photo={photo} onCrop={(crop) => onChange({ ...photo, crop })} />
          <p className="hint">{text.photo.cropHint}</p>
          {size && <p className="hint">{text.photo.output(size.width, size.height)}</p>}
        </>
      ) : (
        <p className="hint">{text.photo.drop}</p>
      )}
      <div className="row">
        <button type="button" onClick={() => fileInput.current?.click()}>
          {photo ? text.photo.replace : text.photo.choose}
        </button>
        {photo?.crop && <button type="button" onClick={() => onChange({ ...photo, crop: null })}>{text.photo.wholePhoto}</button>}
        {photo && <button type="button" onClick={remove}>{text.photo.remove}</button>}
      </div>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={onFileChange} />
      {error && <p className="error-text" role="alert">{error}</p>}
    </section>
  );
}
