/**
 * TypeScript's DOM `ImageData` is a structural interface (data/width/
 * height/colorSpace), not a nominal class check — so a plain object
 * literal satisfies it without ever touching the real `ImageData`
 * constructor. That matters here because convertFormat's BMP/TGA codecs and
 * printLayout's canvas buffer both need to *produce* ImageData-shaped values
 * in contexts (Node tests, a web worker without a Window) where the
 * `ImageData` constructor may not exist. Every jSquash codec accepts
 * these by duck typing, as confirmed against the real package during
 * evaluation (see README).
 */
export function makeImageData(width: number, height: number, fill?: [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    const [r, g, b, a] = fill;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height, colorSpace: 'srgb' };
}
