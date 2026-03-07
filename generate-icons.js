// generate-icons.js — Run once: node generate-icons.js
// Creates simple PNG icons for the extension

const fs = require('fs');
const path = require('path');

// Minimal 1-pixel-at-a-time PNG encoder (no dependencies needed)
function createPNG(size) {
    const canvas = [];
    const center = size / 2;

    // Point-in-polygon (ray casting)
    function pointInPoly(px, py, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i][0], yi = poly[i][1];
            const xj = poly[j][0], yj = poly[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Classic ⚡ lightning bolt polygon (normalized 0-1, clockwise)
    // Upper blade: top-right slanting down to mid-left
    // Lower blade: mid-right slanting down to bottom-left
    const boltPoly = [
        [0.44, 0.04],  // top-left
        [0.65, 0.04],  // top-right
        [0.53, 0.50],  // mid inner-right
        [0.65, 0.50],  // mid outer-right (step)
        [0.54, 0.96],  // bottom-right
        [0.33, 0.96],  // bottom-left
        [0.45, 0.50],  // mid outer-left (step)
        [0.33, 0.50],  // mid inner-left
    ];

    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            const dx = (x - center) / center;
            const dy = (y - center) / center;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 0.85) {
                const nx = x / size;
                const ny = y / size;
                const isBolt = pointInPoly(nx, ny, boltPoly);

                if (isBolt) {
                    row.push([0, 255, 136, 255]); // Green bolt
                } else {
                    const shade = Math.floor(15 + dist * 20);
                    row.push([shade, shade, Math.floor(shade * 1.5), 255]);
                }
            } else if (dist < 0.95) {
                const alpha = Math.max(0, 1 - (dist - 0.85) * 10);
                row.push([0, Math.floor(255 * alpha * 0.5), Math.floor(136 * alpha * 0.5), Math.floor(255 * alpha)]);
            } else {
                row.push([0, 0, 0, 0]);
            }
        }
        canvas.push(row);
    }

    return encodePNG(canvas, size, size);
}

// Minimal PNG encoder
function encodePNG(pixels, width, height) {
    function crc32(buf) {
        let crc = -1;
        for (let i = 0; i < buf.length; i++) {
            crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
        }
        return (crc ^ -1) >>> 0;
    }

    const crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crc32Table[i] = c;
    }

    function adler32(buf) {
        let a = 1, b = 0;
        for (let i = 0; i < buf.length; i++) {
            a = (a + buf[i]) % 65521;
            b = (b + a) % 65521;
        }
        return ((b << 16) | a) >>> 0;
    }

    function chunk(type, data) {
        const typeBytes = Buffer.from(type, 'ascii');
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const combined = Buffer.concat([typeBytes, data]);
        const crcVal = crc32(combined);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crcVal);
        return Buffer.concat([len, combined, crcBuf]);
    }

    // Raw pixel data with filter byte
    const rawData = [];
    for (let y = 0; y < height; y++) {
        rawData.push(0); // No filter
        for (let x = 0; x < width; x++) {
            rawData.push(pixels[y][x][0], pixels[y][x][1], pixels[y][x][2], pixels[y][x][3]);
        }
    }

    const raw = Buffer.from(rawData);

    // Simple deflate (store blocks, no compression)
    const blocks = [];
    const BLOCK_SIZE = 65534;
    for (let i = 0; i < raw.length; i += BLOCK_SIZE) {
        const end = Math.min(i + BLOCK_SIZE, raw.length);
        const isLast = end === raw.length;
        const blockData = raw.slice(i, end);
        const header = Buffer.alloc(5);
        header[0] = isLast ? 1 : 0;
        header.writeUInt16LE(blockData.length, 1);
        header.writeUInt16LE(~blockData.length & 0xffff, 3);
        blocks.push(header, blockData);
    }

    const deflated = Buffer.concat(blocks);
    const adlerVal = adler32(raw);

    const zlibData = Buffer.concat([
        Buffer.from([0x78, 0x01]), // zlib header
        deflated,
        Buffer.from([(adlerVal >> 24) & 0xff, (adlerVal >> 16) & 0xff, (adlerVal >> 8) & 0xff, adlerVal & 0xff])
    ]);

    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
        chunk('IHDR', ihdr),
        chunk('IDAT', zlibData),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// Generate icons
const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

for (const size of sizes) {
    const png = createPNG(size);
    const filepath = path.join(iconsDir, `icon${size}.png`);
    fs.writeFileSync(filepath, png);
    console.log(`✅ Generated ${filepath} (${png.length} bytes)`);
}

console.log('\nDone! Icons generated.');
