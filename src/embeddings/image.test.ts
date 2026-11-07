import { describe, expect, it } from "vitest";
import { inspectImage, isPublicHttpsUrl, statusOutcome } from "./image.js";

// SOI, an APP0 segment of 16 bytes, then a baseline start-of-frame with the height and width
function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, ...new Array<number>(8).fill(0)]);
}

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe("inspectImage", () => {
  it("reads the type and size of a JPEG and a PNG from their headers", () => {
    expect(inspectImage(jpeg(1000, 700))).toEqual({ mimeType: "image/jpeg", width: 1000, height: 700 });
    expect(inspectImage(png(700, 700))).toEqual({ mimeType: "image/png", width: 700, height: 700 });
  });

  it("says why an image cannot be sent", () => {
    expect(inspectImage(Buffer.from("<html>not found</html>"))).toMatch(/^not a JPEG or PNG/);
    expect(inspectImage(Buffer.from("RIFF0000WEBPVP8 "))).toMatch(/^not a JPEG or PNG/);
    expect(inspectImage(Buffer.alloc(0))).toMatch(/^not a JPEG or PNG/);
    expect(inspectImage(jpeg(5000, 4000))).toMatch(/over 16000000 pixels/);
    expect(inspectImage(jpeg(0, 10))).toBe("image size not readable");
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image size not readable");
  });
});

describe("isPublicHttpsUrl", () => {
  it("takes https links to a named host only", () => {
    expect(isPublicHttpsUrl("https://files.axpol.com/foto_add_view/HE203-16_ATM52.jpg")).toBe(true);
    expect(isPublicHttpsUrl("http://cdn1.midocean.com/image/700X700/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isPublicHttpsUrl("https://[::1]/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://localhost./a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://cdn.example:8443/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("https://user:pass@cdn.example/a.jpg")).toBe(false);
    expect(isPublicHttpsUrl("not a url")).toBe(false);
  });
});

describe("statusOutcome", () => {
  it("fails a photo that is gone or moved, defers a block, a peak or a server error", () => {
    expect([301, 302, 400, 404, 410].map(statusOutcome)).toEqual(["failed", "failed", "failed", "failed", "failed"]);
    expect([204, 401, 403, 408, 429, 500, 503].map(statusOutcome))
      .toEqual(["deferred", "deferred", "deferred", "deferred", "deferred", "deferred", "deferred"]);
  });
});
