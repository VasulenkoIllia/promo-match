import { useState } from "react";
import { photoSrc } from "./format";

interface CatalogPhotoProps {
  // The supplier's link, through this server where it needs to be (photoSrc)
  url: string;
  // The reduced copy on this server (docs/integrations.md, «Сховище зменшених фото»); null: none made yet
  thumbUrl: string | null;
  alt: string;
}

// A catalogue photo: its reduced copy when there is one, the supplier's link when there is none or the copy does not
// load, so a missing file never leaves a card without its picture
export function CatalogPhoto({ url, thumbUrl, alt }: CatalogPhotoProps) {
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
  const isThumb = thumbUrl !== null && thumbUrl !== brokenThumb;
  return (
    <img
      src={isThumb ? thumbUrl : photoSrc(url)}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={isThumb ? () => setBrokenThumb(thumbUrl) : undefined}
    />
  );
}
