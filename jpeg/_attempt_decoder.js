
/* -*- tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
   Copyright 2011 notmasteryet
   Copyright 2014-2018 Mozilla
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

let JpegError = (function JpegErrorClosure() {
  function JpegError(msg) {
    this.message = 'JPEG error: ' + msg;
  }

  JpegError.prototype = new Error();
  JpegError.prototype.name = 'JpegError';
  JpegError.constructor = JpegError;

  return JpegError;
})();

let DNLMarkerError = (function DNLMarkerErrorClosure() {
  function DNLMarkerError(message, scanLines) {
    this.message = message;
    this.scanLines = scanLines;
  }

  DNLMarkerError.prototype = new Error();
  DNLMarkerError.prototype.name = 'DNLMarkerError';
  DNLMarkerError.constructor = DNLMarkerError;

  return DNLMarkerError;
})();

let EOIMarkerError = (function EOIMarkerErrorClosure() {
  function EOIMarkerError(message) {
    this.message = message;
  }

  EOIMarkerError.prototype = new Error();
  EOIMarkerError.prototype.name = 'EOIMarkerError';
  EOIMarkerError.constructor = EOIMarkerError;

  return EOIMarkerError;
})();


function clampTo8bit(a) {
  return a < 0 ? 0 : a > 255 ? 255 : a;
}

// - The JPEG specification can be found in the ITU CCITT Recommendation T.81
//   (www.w3.org/Graphics/JPEG/itu-t81.pdf)
// - The JFIF specification can be found in the JPEG File Interchange Format
//   (www.w3.org/Graphics/JPEG/jfif3.pdf)
// - The Adobe Application-Specific JPEG markers in the Supporting the DCT Filters
//   in PostScript Level 2, Technical Note #5116
//   (partners.adobe.com/public/developer/en/ps/sdk/5116.DCT_Filter.pdf)

var JpegImage = (function JpegImageClosure() {
  var dctZigZag = new Uint8Array([
     0,
     1,  8,
    16,  9,  2,
     3, 10, 17, 24,
    32, 25, 18, 11, 4,
     5, 12, 19, 26, 33, 40,
    48, 41, 34, 27, 20, 13,  6,
     7, 14, 21, 28, 35, 42, 49, 56,
    57, 50, 43, 36, 29, 22, 15,
    23, 30, 37, 44, 51, 58,
    59, 52, 45, 38, 31,
    39, 46, 53, 60,
    61, 54, 47,
    55, 62,
    63
  ]);

  var dctCos1  =  4017;   // cos(pi/16)
  var dctSin1  =   799;   // sin(pi/16)
  var dctCos3  =  3406;   // cos(3*pi/16)
  var dctSin3  =  2276;   // sin(3*pi/16)
  var dctCos6  =  1567;   // cos(6*pi/16)
  var dctSin6  =  3784;   // sin(6*pi/16)
  var dctSqrt2 =  5793;   // sqrt(2)
  var dctSqrt1d2 = 2896;  // sqrt(2) / 2

  function JpegImage({ decodeTransform = null, colorTransform = -1, } = {}) {
    this._decodeTransform = decodeTransform;
    this._colorTransform = colorTransform;
  }

  function buildHuffmanTable(codeLengths, values) {
    var k = 0, code = [], i, j, length = 16;
    while (length > 0 && !codeLengths[length - 1]) {
      length--;
    }
    code.push({ children: [], index: 0, });
    var p = code[0], q;
    for (i = 0; i < length; i++) {
      for (j = 0; j < codeLengths[i]; j++) {
        p = code.pop();
        p.children[p.index] = values[k];
        while (p.index > 0) {
          p = code.pop();
        }
        p.index++;
        code.push(p);
        while (code.length <= i) {
          code.push(q = { children: [], index: 0, });
          p.children[p.index] = q.children;
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        // p here points to last code
        code.push(q = { children: [], index: 0, });
        p.children[p.index] = q.children;
        p = q;
      }
    }
    return code[0].children;
  }

  function getBlockBufferOffset(component, row, col) {
    return 64 * ((component.blocksPerLine + 1) * row + col);
  }

  function decodeScan(data, offset, frame, components, resetInterval,
                      spectralStart, spectralEnd, successivePrev, successive,
                      parseDNLMarker = false) {
    var mcusPerLine = frame.mcusPerLine;
    var progressive = frame.progressive;

    var startOffset = offset, bitsData = 0, bitsCount = 0;

    function readBit() {
      if (bitsCount > 0) {
        bitsCount--;
        return (bitsData >> bitsCount) & 1;
      }
      bitsData = data[offset++];
      if (bitsData === 0xFF) {
        var nextByte = data[offset++];
        if (nextByte) {
          if (nextByte === 0xDC && parseDNLMarker) { // DNL == 0xFFDC
            offset += 2; // Skip data length.
            const scanLines = (data[offset++] << 8) | data[offset++];
            if (scanLines > 0 && scanLines !== frame.scanLines) {
              throw new DNLMarkerError(
                'Found DNL marker (0xFFDC) while parsing scan data', scanLines);
            }
          } else if (nextByte === 0xD9) { // EOI == 0xFFD9
            throw new EOIMarkerError(
              'Found EOI marker (0xFFD9) while parsing scan data');
          }
          throw new JpegError(
            `unexpected marker ${((bitsData << 8) | nextByte).toString(16)}`);
        }
        // unstuff 0
      }
      bitsCount = 7;
      return bitsData >>> 7;
    }

    function decodeHuffman(tree) {
      var node = tree;
      while (true) {
        node = node[readBit()];
        if (typeof node === 'number') {
          return node;
        }
        if (typeof node !== 'object') {
          throw new JpegError('invalid huffman sequence');
        }
      }
    }

    function receive(length) {
      var n = 0;
      while (length > 0) {
        n = (n << 1) | readBit();
        length--;
      }
      return n;
    }

    function receiveAndExtend(length) {
      if (length === 1) {
        return readBit() === 1 ? 1 : -1;
      }
      var n = receive(length);
      if (n >= 1 << (length - 1)) {
        return n;
      }
      return n + (-1 << length) + 1;
    }

    function decodeBaseline(component, offset) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : receiveAndExtend(t);
      component.blockData[offset] = (component.pred += diff);
      var k = 1;
      while (k < 64) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        component.blockData[offset + z] = receiveAndExtend(s);
        k++;
      }
    }

    function decodeDCFirst(component, offset) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : (receiveAndExtend(t) << successive);
      component.blockData[offset] = (component.pred += diff);
    }

    function decodeDCSuccessive(component, offset) {
      component.blockData[offset] |= readBit() << successive;
    }

    var eobrun = 0;
    function decodeACFirst(component, offset) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      var k = spectralStart, e = spectralEnd;
      while (k <= e) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = receive(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        component.blockData[offset + z] =
          receiveAndExtend(s) * (1 << successive);
        k++;
      }
    }

    var successiveACState = 0, successiveACNextValue;
    function decodeACSuccessive(component, offset) {
      var k = spectralStart;
      var e = spectralEnd;
      var r = 0;
      var s;
      var rs;
      while (k <= e) {
        let offsetZ = offset + dctZigZag[k];
        let sign = component.blockData[offsetZ] < 0 ? -1 : 1;
        switch (successiveACState) {
          case 0: // initial state
            rs = decodeHuffman(component.huffmanTableAC);
            s = rs & 15;
            r = rs >> 4;
            if (s === 0) {
              if (r < 15) {
                eobrun = receive(r) + (1 << r);
                successiveACState = 4;
              } else {
                r = 16;
                successiveACState = 1;
              }
            } else {
              if (s !== 1) {
                throw new JpegError('invalid ACn encoding');
              }
              successiveACNextValue = receiveAndExtend(s);
              successiveACState = r ? 2 : 3;
            }
            continue;
          case 1: // skipping r zero items
          case 2:
            if (component.blockData[offsetZ]) {
              component.blockData[offsetZ] += sign * (readBit() << successive);
            } else {
              r--;
              if (r === 0) {
                successiveACState = successiveACState === 2 ? 3 : 0;
              }
            }
            break;
          case 3: // set value for a zero item
            if (component.blockData[offsetZ]) {
              component.blockData[offsetZ] += sign * (readBit() << successive);
            } else {
              component.blockData[offsetZ] =
                successiveACNextValue << successive;
              successiveACState = 0;
            }
            break;
          case 4: // eob
            if (component.blockData[offsetZ]) {
              component.blockData[offsetZ] += sign * (readBit() << successive);
            }
            break;
        }
        k++;
      }
      if (successiveACState === 4) {
        eobrun--;
        if (eobrun === 0) {
          successiveACState = 0;
        }
      }
    }

    function decodeMcu(component, decode, mcu, row, col) {
      var mcuRow = (mcu / mcusPerLine) | 0;
      var mcuCol = mcu % mcusPerLine;
      var blockRow = mcuRow * component.v + row;
      var blockCol = mcuCol * component.h + col;
      var offset = getBlockBufferOffset(component, blockRow, blockCol);
      decode(component, offset);
    }

    function decodeBlock(component, decode, mcu) {
      var blockRow = (mcu / component.blocksPerLine) | 0;
      var blockCol = mcu % component.blocksPerLine;
      var offset = getBlockBufferOffset(component, blockRow, blockCol);
      decode(component, offset);
    }

    var componentsLength = components.length;
    var component, i, j, k, n;
    var decodeFn;
    if (progressive) {
      if (spectralStart === 0) {
        decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
      } else {
        decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
      }
    } else {
      decodeFn = decodeBaseline;
    }

    var mcu = 0, fileMarker;
    var mcuExpected;
    if (componentsLength === 1) {
      mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
    } else {
      mcuExpected = mcusPerLine * frame.mcusPerColumn;
    }

    var h, v;
    while (mcu < mcuExpected) {
      // reset interval stuff
      var mcuToRead = resetInterval ?
        Math.min(mcuExpected - mcu, resetInterval) : mcuExpected;
      for (i = 0; i < componentsLength; i++) {
        components[i].pred = 0;
      }
      eobrun = 0;

      if (componentsLength === 1) {
        component = components[0];
        for (n = 0; n < mcuToRead; n++) {
          decodeBlock(component, decodeFn, mcu);
          mcu++;
        }
      } else {
        for (n = 0; n < mcuToRead; n++) {
          for (i = 0; i < componentsLength; i++) {
            component = components[i];
            h = component.h;
            v = component.v;
            for (j = 0; j < v; j++) {
              for (k = 0; k < h; k++) {
                decodeMcu(component, decodeFn, mcu, j, k);
              }
            }
          }
          mcu++;
        }
      }

      // find marker
      bitsCount = 0;
      fileMarker = findNextFileMarker(data, offset);
      // Some bad images seem to pad Scan blocks with e.g. zero bytes, skip past
      // those to attempt to find a valid marker (fixes issue4090.pdf).
      if (fileMarker && fileMarker.invalid) {
        warn('decodeScan - unexpected MCU data, current marker is: ' +
             fileMarker.invalid);
        offset = fileMarker.offset;
      }
      var marker = fileMarker && fileMarker.marker;
      if (!marker || marker <= 0xFF00) {
        throw new JpegError('marker was not found');
      }

      if (marker >= 0xFFD0 && marker <= 0xFFD7) { // RSTx
        offset += 2;
      } else {
        break;
      }
    }

    fileMarker = findNextFileMarker(data, offset);
    // Some images include more Scan blocks than expected, skip past those and
    // attempt to find the next valid marker (fixes issue8182.pdf).
    if (fileMarker && fileMarker.invalid) {
      warn('decodeScan - unexpected Scan data, current marker is: ' +
           fileMarker.invalid);
      offset = fileMarker.offset;
    }

    return offset - startOffset;
  }

  // A port of poppler's IDCT method which in turn is taken from:
  //   Christoph Loeffler, Adriaan Ligtenberg, George S. Moschytz,
  //   'Practical Fast 1-D DCT Algorithms with 11 Multiplications',
  //   IEEE Intl. Conf. on Acoustics, Speech & Signal Processing, 1989,
  //   988-991.
  function quantizeAndInverse(component, blockBufferOffset, p) {
    var qt = component.quantizationTable, blockData = component.blockData;
    var v0, v1, v2, v3, v4, v5, v6, v7;
    var p0, p1, p2, p3, p4, p5, p6, p7;
    var t;

    if (!qt) {
      throw new JpegError('missing required Quantization Table.');
    }

    // inverse DCT on rows
    for (var row = 0; row < 64; row += 8) {
      // gather block data
      p0 = blockData[blockBufferOffset + row];
      p1 = blockData[blockBufferOffset + row + 1];
      p2 = blockData[blockBufferOffset + row + 2];
      p3 = blockData[blockBufferOffset + row + 3];
      p4 = blockData[blockBufferOffset + row + 4];
      p5 = blockData[blockBufferOffset + row + 5];
      p6 = blockData[blockBufferOffset + row + 6];
      p7 = blockData[blockBufferOffset + row + 7];

      // dequant p0
      p0 *= qt[row];

      // check for all-zero AC coefficients
      if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
        t = (dctSqrt2 * p0 + 512) >> 10;
        p[row] = t;
        p[row + 1] = t;
        p[row + 2] = t;
        p[row + 3] = t;
        p[row + 4] = t;
        p[row + 5] = t;
        p[row + 6] = t;
        p[row + 7] = t;
        continue;
      }
      // dequant p1 ... p7
      p1 *= qt[row + 1];
      p2 *= qt[row + 2];
      p3 *= qt[row + 3];
      p4 *= qt[row + 4];
      p5 *= qt[row + 5];
      p6 *= qt[row + 6];
      p7 *= qt[row + 7];

      // stage 4
      v0 = (dctSqrt2 * p0 + 128) >> 8;
      v1 = (dctSqrt2 * p4 + 128) >> 8;
      v2 = p2;
      v3 = p6;
      v4 = (dctSqrt1d2 * (p1 - p7) + 128) >> 8;
      v7 = (dctSqrt1d2 * (p1 + p7) + 128) >> 8;
      v5 = p3 << 4;
      v6 = p5 << 4;

      // stage 3
      v0 = (v0 + v1 + 1) >> 1;
      v1 = v0 - v1;
      t  = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8;
      v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8;
      v3 = t;
      v4 = (v4 + v6 + 1) >> 1;
      v6 = v4 - v6;
      v7 = (v7 + v5 + 1) >> 1;
      v5 = v7 - v5;

      // stage 2
      v0 = (v0 + v3 + 1) >> 1;
      v3 = v0 - v3;
      v1 = (v1 + v2 + 1) >> 1;
      v2 = v1 - v2;
      t  = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
      v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
      v7 = t;
      t  = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
      v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
      v6 = t;

      // stage 1
      p[row] = v0 + v7;
      p[row + 7] = v0 - v7;
      p[row + 1] = v1 + v6;
      p[row + 6] = v1 - v6;
      p[row + 2] = v2 + v5;
      p[row + 5] = v2 - v5;
      p[row + 3] = v3 + v4;
      p[row + 4] = v3 - v4;
    }

    // inverse DCT on columns
    for (var col = 0; col < 8; ++col) {
      p0 = p[col];
      p1 = p[col +  8];
      p2 = p[col + 16];
      p3 = p[col + 24];
      p4 = p[col + 32];
      p5 = p[col + 40];
      p6 = p[col + 48];
      p7 = p[col + 56];

      // check for all-zero AC coefficients
      if ((p1 | p2 | p3 | p4 | p5 | p6 | p7) === 0) {
        t = (dctSqrt2 * p0 + 8192) >> 14;
        // convert to 8 bit
        t = (t < -2040) ? 0 : (t >= 2024) ? 255 : (t + 2056) >> 4;
        blockData[blockBufferOffset + col] = t;
        blockData[blockBufferOffset + col +  8] = t;
        blockData[blockBufferOffset + col + 16] = t;
        blockData[blockBufferOffset + col + 24] = t;
        blockData[blockBufferOffset + col + 32] = t;
        blockData[blockBufferOffset + col + 40] = t;
        blockData[blockBufferOffset + col + 48] = t;
        blockData[blockBufferOffset + col + 56] = t;
        continue;
      }

      // stage 4
      v0 = (dctSqrt2 * p0 + 2048) >> 12;
      v1 = (dctSqrt2 * p4 + 2048) >> 12;
      v2 = p2;
      v3 = p6;
      v4 = (dctSqrt1d2 * (p1 - p7) + 2048) >> 12;
      v7 = (dctSqrt1d2 * (p1 + p7) + 2048) >> 12;
      v5 = p3;
      v6 = p5;

      // stage 3
      // Shift v0 by 128.5 << 5 here, so we don't need to shift p0...p7 when
      // converting to UInt8 range later.
      v0 = ((v0 + v1 + 1) >> 1) + 4112;
      v1 = v0 - v1;
      t  = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12;
      v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12;
      v3 = t;
      v4 = (v4 + v6 + 1) >> 1;
      v6 = v4 - v6;
      v7 = (v7 + v5 + 1) >> 1;
      v5 = v7 - v5;

      // stage 2
      v0 = (v0 + v3 + 1) >> 1;
      v3 = v0 - v3;
      v1 = (v1 + v2 + 1) >> 1;
      v2 = v1 - v2;
      t  = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
      v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
      v7 = t;
      t  = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
      v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
      v6 = t;

      // stage 1
      p0 = v0 + v7;
      p7 = v0 - v7;
      p1 = v1 + v6;
      p6 = v1 - v6;
      p2 = v2 + v5;
      p5 = v2 - v5;
      p3 = v3 + v4;
      p4 = v3 - v4;

      // convert to 8-bit integers
      p0 = (p0 < 16) ? 0 : (p0 >= 4080) ? 255 : p0 >> 4;
      p1 = (p1 < 16) ? 0 : (p1 >= 4080) ? 255 : p1 >> 4;
      p2 = (p2 < 16) ? 0 : (p2 >= 4080) ? 255 : p2 >> 4;
      p3 = (p3 < 16) ? 0 : (p3 >= 4080) ? 255 : p3 >> 4;
      p4 = (p4 < 16) ? 0 : (p4 >= 4080) ? 255 : p4 >> 4;
      p5 = (p5 < 16) ? 0 : (p5 >= 4080) ? 255 : p5 >> 4;
      p6 = (p6 < 16) ? 0 : (p6 >= 4080) ? 255 : p6 >> 4;
      p7 = (p7 < 16) ? 0 : (p7 >= 4080) ? 255 : p7 >> 4;

      // store block data
      blockData[blockBufferOffset + col] = p0;
      blockData[blockBufferOffset + col +  8] = p1;
      blockData[blockBufferOffset + col + 16] = p2;
      blockData[blockBufferOffset + col + 24] = p3;
      blockData[blockBufferOffset + col + 32] = p4;
      blockData[blockBufferOffset + col + 40] = p5;
      blockData[blockBufferOffset + col + 48] = p6;
      blockData[blockBufferOffset + col + 56] = p7;
    }
  }

  function buildComponentData(frame, component) {
    var blocksPerLine = component.blocksPerLine;
    var blocksPerColumn = component.blocksPerColumn;
    var computationBuffer = new Int16Array(64);

    for (var blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
      for (var blockCol = 0; blockCol < blocksPerLine; blockCol++) {
        var offset = getBlockBufferOffset(component, blockRow, blockCol);
        quantizeAndInverse(component, offset, computationBuffer);
      }
    }
    return component.blockData;
  }

  function findNextFileMarker(data, currentPos, startPos = currentPos) {
    function peekUint16(pos) {
      return (data[pos] << 8) | data[pos + 1];
    }

    const maxPos = data.length - 1;
    var newPos = startPos < currentPos ? startPos : currentPos;

    if (currentPos >= maxPos) {
      return null; // Don't attempt to read non-existent data and just return.
    }
    var currentMarker = peekUint16(currentPos);
    if (currentMarker >= 0xFFC0 && currentMarker <= 0xFFFE) {
      return {
        invalid: null,
        marker: currentMarker,
        offset: currentPos,
      };
    }
    var newMarker = peekUint16(newPos);
    while (!(newMarker >= 0xFFC0 && newMarker <= 0xFFFE)) {
      if (++newPos >= maxPos) {
        return null; // Don't attempt to read non-existent data and just return.
      }
      newMarker = peekUint16(newPos);
    }
    return {
      invalid: currentMarker.toString(16),
      marker: newMarker,
      offset: newPos,
    };
  }

  JpegImage.prototype = {
    parse(data, { dnlScanLines = null, } = {}) {

      function readUint16() {
        var value = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        return value;
      }

      function readDataBlock() {
        var length = readUint16();
        var endOffset = offset + length - 2;

        var fileMarker = findNextFileMarker(data, endOffset, offset);
        if (fileMarker && fileMarker.invalid) {
          warn('readDataBlock - incorrect length, current marker is: ' +
               fileMarker.invalid);
          endOffset = fileMarker.offset;
        }

        var array = data.subarray(offset, endOffset);
        offset += array.length;
        return array;
      }

      function prepareComponents(frame) {
        var mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / frame.maxH);
        var mcusPerColumn = Math.ceil(frame.scanLines / 8 / frame.maxV);
        for (var i = 0; i < frame.components.length; i++) {
          component = frame.components[i];
          var blocksPerLine = Math.ceil(Math.ceil(frame.samplesPerLine / 8) *
                                        component.h / frame.maxH);
          var blocksPerColumn = Math.ceil(Math.ceil(frame.scanLines / 8) *
                                          component.v / frame.maxV);
          var blocksPerLineForMcu = mcusPerLine * component.h;
          var blocksPerColumnForMcu = mcusPerColumn * component.v;

          var blocksBufferSize = 64 * blocksPerColumnForMcu *
                                      (blocksPerLineForMcu + 1);
          component.blockData = new Int16Array(blocksBufferSize);
          component.blocksPerLine = blocksPerLine;
          component.blocksPerColumn = blocksPerColumn;
        }
        frame.mcusPerLine = mcusPerLine;
        frame.mcusPerColumn = mcusPerColumn;
      }

      var offset = 0;
      var jfif = null;
      var adobe = null;
      var frame, resetInterval;
      let numSOSMarkers = 0;
      var quantizationTables = [];
      var huffmanTablesAC = [], huffmanTablesDC = [];
      var fileMarker = readUint16();
      if (fileMarker !== 0xFFD8) { // SOI (Start of Image)
        throw new JpegError('SOI not found');
      }

      fileMarker = readUint16();
      markerLoop: while (fileMarker !== 0xFFD9) { // EOI (End of image)
        var i, j, l;
        switch (fileMarker) {
          case 0xFFE0: // APP0 (Application Specific)
          case 0xFFE1: // APP1
          case 0xFFE2: // APP2
          case 0xFFE3: // APP3
          case 0xFFE4: // APP4
          case 0xFFE5: // APP5
          case 0xFFE6: // APP6
          case 0xFFE7: // APP7
          case 0xFFE8: // APP8
          case 0xFFE9: // APP9
          case 0xFFEA: // APP10
          case 0xFFEB: // APP11
          case 0xFFEC: // APP12
          case 0xFFED: // APP13
          case 0xFFEE: // APP14
          case 0xFFEF: // APP15
          case 0xFFFE: // COM (Comment)
            var appData = readDataBlock();

            if (fileMarker === 0xFFE0) {
              if (appData[0] === 0x4A && appData[1] === 0x46 &&
                  appData[2] === 0x49 && appData[3] === 0x46 &&
                  appData[4] === 0) { // 'JFIF\x00'
                jfif = {
                  version: { major: appData[5], minor: appData[6], },
                  densityUnits: appData[7],
                  xDensity: (appData[8] << 8) | appData[9],
                  yDensity: (appData[10] << 8) | appData[11],
                  thumbWidth: appData[12],
                  thumbHeight: appData[13],
                  thumbData: appData.subarray(14, 14 +
                                              3 * appData[12] * appData[13]),
                };
              }
            }
            // TODO APP1 - Exif
            if (fileMarker === 0xFFEE) {
              if (appData[0] === 0x41 && appData[1] === 0x64 &&
                  appData[2] === 0x6F && appData[3] === 0x62 &&
                  appData[4] === 0x65) { // 'Adobe'
                adobe = {
                  version: (appData[5] << 8) | appData[6],
                  flags0: (appData[7] << 8) | appData[8],
                  flags1: (appData[9] << 8) | appData[10],
                  transformCode: appData[11],
                };
              }
            }
            break;

          case 0xFFDB: // DQT (Define Quantization Tables)
            var quantizationTablesLength = readUint16();
            var quantizationTablesEnd = quantizationTablesLength + offset - 2;
            var z;
            while (offset < quantizationTablesEnd) {
              var quantizationTableSpec = data[offset++];
              var tableData = new Uint16Array(64);
              if ((quantizationTableSpec >> 4) === 0) { // 8 bit values
                for (j = 0; j < 64; j++) {
                  z = dctZigZag[j];
                  tableData[z] = data[offset++];
                }
              } else if ((quantizationTableSpec >> 4) === 1) { // 16 bit values
                for (j = 0; j < 64; j++) {
                  z = dctZigZag[j];
                  tableData[z] = readUint16();
                }
              } else {
                throw new JpegError('DQT - invalid table spec');
              }
              quantizationTables[quantizationTableSpec & 15] = tableData;
            }
            break;

          case 0xFFC0: // SOF0 (Start of Frame, Baseline DCT)
          case 0xFFC1: // SOF1 (Start of Frame, Extended DCT)
          case 0xFFC2: // SOF2 (Start of Frame, Progressive DCT)
            if (frame) {
              throw new JpegError('Only single frame JPEGs supported');
            }
            readUint16(); // skip data length
            frame = {};
            frame.extended = (fileMarker === 0xFFC1);
            frame.progressive = (fileMarker === 0xFFC2);
            frame.precision = data[offset++];
            const sofScanLines = readUint16();
            frame.scanLines = dnlScanLines || sofScanLines;
            frame.samplesPerLine = readUint16();
            frame.components = [];
            frame.componentIds = {};
            var componentsCount = data[offset++], componentId;
            var maxH = 0, maxV = 0;
            for (i = 0; i < componentsCount; i++) {
              componentId = data[offset];
              var h = data[offset + 1] >> 4;
              var v = data[offset + 1] & 15;
              if (maxH < h) {
                maxH = h;
              }
              if (maxV < v) {
                maxV = v;
              }
              var qId = data[offset + 2];
              l = frame.components.push({
                h,
                v,
                quantizationId: qId,
                quantizationTable: null, // See comment below.
              });
              frame.componentIds[componentId] = l - 1;
              offset += 3;
            }
            frame.maxH = maxH;
            frame.maxV = maxV;
            prepareComponents(frame);
            break;

          case 0xFFC4: // DHT (Define Huffman Tables)
            var huffmanLength = readUint16();
            for (i = 2; i < huffmanLength;) {
              var huffmanTableSpec = data[offset++];
              var codeLengths = new Uint8Array(16);
              var codeLengthSum = 0;
              for (j = 0; j < 16; j++, offset++) {
                codeLengthSum += (codeLengths[j] = data[offset]);
              }
              var huffmanValues = new Uint8Array(codeLengthSum);
              for (j = 0; j < codeLengthSum; j++, offset++) {
                huffmanValues[j] = data[offset];
              }
              i += 17 + codeLengthSum;

              ((huffmanTableSpec >> 4) === 0 ?
                huffmanTablesDC : huffmanTablesAC)[huffmanTableSpec & 15] =
                buildHuffmanTable(codeLengths, huffmanValues);
            }
            break;

          case 0xFFDD: // DRI (Define Restart Interval)
            readUint16(); // skip data length
            resetInterval = readUint16();
            break;

          case 0xFFDA: // SOS (Start of Scan)
            // A DNL marker (0xFFDC), if it exists, is only allowed at the end
            // of the first scan segment and may only occur once in an image.
            // Furthermore, to prevent an infinite loop, do *not* attempt to
            // parse DNL markers during re-parsing of the JPEG scan data.
            const parseDNLMarker = (++numSOSMarkers) === 1 && !dnlScanLines;

            readUint16(); // scanLength
            var selectorsCount = data[offset++];
            var components = [], component;
            for (i = 0; i < selectorsCount; i++) {
              var componentIndex = frame.componentIds[data[offset++]];
              component = frame.components[componentIndex];
              var tableSpec = data[offset++];
              component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
              component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
              components.push(component);
            }
            var spectralStart = data[offset++];
            var spectralEnd = data[offset++];
            var successiveApproximation = data[offset++];
            try {
              var processed = decodeScan(data, offset,
                frame, components, resetInterval,
                spectralStart, spectralEnd,
                successiveApproximation >> 4, successiveApproximation & 15,
                parseDNLMarker);
              offset += processed;
            } catch (ex) {
              if (ex instanceof DNLMarkerError) {
                warn(`${ex.message} -- attempting to re-parse the JPEG image.`);
                return this.parse(data, { dnlScanLines: ex.scanLines, });
              } else if (ex instanceof EOIMarkerError) {
                warn(`${ex.message} -- ignoring the rest of the image data.`);
                break markerLoop;
              }
              throw ex;
            }
            break;

          case 0xFFDC: // DNL (Define Number of Lines)
            // Ignore the marker, since it's being handled in `decodeScan`.
            offset += 4;
            break;

          case 0xFFFF: // Fill bytes
            if (data[offset] !== 0xFF) { // Avoid skipping a valid marker.
              offset--;
            }
            break;

          default:
            if (data[offset - 3] === 0xFF &&
                data[offset - 2] >= 0xC0 && data[offset - 2] <= 0xFE) {
              // could be incorrect encoding -- last 0xFF byte of the previous
              // block was eaten by the encoder
              offset -= 3;
              break;
            }
            let nextFileMarker = findNextFileMarker(data, offset - 2);
            if (nextFileMarker && nextFileMarker.invalid) {
              warn('JpegImage.parse - unexpected data, current marker is: ' +
                   nextFileMarker.invalid);
              offset = nextFileMarker.offset;
              break;
            }
            throw new JpegError('unknown marker ' + fileMarker.toString(16));
        }
        fileMarker = readUint16();
      }

      this.width = frame.samplesPerLine;
      this.height = frame.scanLines;
      this.jfif = jfif;
      this.adobe = adobe;
      this.components = [];
      console.log('frame.components.length', frame.components.length);
      for (i = 0; i < frame.components.length; i++) {
        component = frame.components[i];

        // Prevent errors when DQT markers are placed after SOF{n} markers,
        // by assigning the `quantizationTable` entry after the entire image
        // has been parsed (fixes issue7406.pdf).
        var quantizationTable = quantizationTables[component.quantizationId];
        if (quantizationTable) {
          component.quantizationTable = quantizationTable;
        }

        this.components.push({
          output: buildComponentData(frame, component),
          scaleX: component.h / frame.maxH,
          scaleY: component.v / frame.maxV,
          blocksPerLine: component.blocksPerLine,
          blocksPerColumn: component.blocksPerColumn,
        });
      }
      this.numComponents = this.components.length;
    },

    _getLinearizedBlockData(width, height, isSourcePDF = false) {
      var scaleX = this.width / width, scaleY = this.height / height;

      var component, componentScaleX, componentScaleY, blocksPerScanline;
      var x, y, i, j, k;
      var index;
      var offset = 0;
      var output;
      var numComponents = this.components.length;
      var dataLength = width * height * numComponents;
      var data = new Uint8ClampedArray(dataLength);
      var xScaleBlockOffset = new Uint32Array(width);
      var mask3LSB = 0xfffffff8; // used to clear the 3 LSBs

      for (i = 0; i < numComponents; i++) {
        component = this.components[i];
        componentScaleX = component.scaleX * scaleX;
        componentScaleY = component.scaleY * scaleY;
        offset = i;
        output = component.output;
        blocksPerScanline = (component.blocksPerLine + 1) << 3;
        // precalculate the xScaleBlockOffset
        for (x = 0; x < width; x++) {
          j = 0 | (x * componentScaleX);
          xScaleBlockOffset[x] = ((j & mask3LSB) << 3) | (j & 7);
        }
        // linearize the blocks of the component
        for (y = 0; y < height; y++) {
          j = 0 | (y * componentScaleY);
          index = blocksPerScanline * (j & mask3LSB) | ((j & 7) << 3);
          for (x = 0; x < width; x++) {
            data[offset] = output[index + xScaleBlockOffset[x]];
            offset += numComponents;
          }
        }
      }

      // decodeTransform contains pairs of multiplier (-256..256) and additive
      let transform = this._decodeTransform;

      // In PDF files, JPEG images with CMYK colour spaces are usually inverted
      // (this can be observed by extracting the raw image data).
      // Since the conversion algorithms (see below) were written primarily for
      // the PDF use-cases, attempting to use `JpegImage` to parse standalone
      // JPEG (CMYK) images may thus result in inverted images (see issue 9513).
      //
      // Unfortunately it's not (always) possible to tell, from the image data
      // alone, if it needs to be inverted. Thus in an attempt to provide better
      // out-of-box behaviour when `JpegImage` is used standalone, default to
      // inverting JPEG (CMYK) images if and only if the image data does *not*
      // come from a PDF file and no `decodeTransform` was passed by the user.
      console.log('numComponents', numComponents);
      console.log('isSourcePDF', isSourcePDF);
      console.log('transform', transform);
      if (!isSourcePDF && numComponents === 4 && !transform) {
        transform = new Int32Array([
          -256, 255, -256, 255, -256, 255, -256, 255]);
      }
      if (!isSourcePDF && numComponents === 3 && !transform) {
        transform = new Int32Array([
          -256, 255, -256, 255, -256, 255]);
      }

      if (transform) {
        for (i = 0; i < dataLength;) {
          for (j = 0, k = 0; j < numComponents; j++, i++, k += 2) {
            data[i] = ((data[i] * transform[k]) >> 8) + transform[k + 1];
          }
        }
      }
      return data;
    },

    get _isColorConversionNeeded() {
      if (this.adobe) {
        // The adobe transform marker overrides any previous setting.
        return !!this.adobe.transformCode;
      }
      if (this.numComponents === 3) {
        if (this._colorTransform === 0) {
          // If the Adobe transform marker is not present and the image
          // dictionary has a 'ColorTransform' entry, explicitly set to `0`,
          // then the colours should *not* be transformed.
          return false;
        }
        return true;
      }
      // `this.numComponents !== 3`
      if (this._colorTransform === 1) {
        // If the Adobe transform marker is not present and the image
        // dictionary has a 'ColorTransform' entry, explicitly set to `1`,
        // then the colours should be transformed.
        return true;
      }
      return false;
    },

    _convertYccToRgb: function convertYccToRgb(data) {
      var Y, Cb, Cr;
      for (var i = 0, length = data.length; i < length; i += 3) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        data[i] = Y - 179.456 + 1.402 * Cr;
        data[i + 1] = Y + 135.459 - 0.344 * Cb - 0.714 * Cr;
        data[i + 2] = Y - 226.816 + 1.772 * Cb;
      }
      return data;
    },

    _convertYcckToRgb: function convertYcckToRgb(data) {
      var Y, Cb, Cr, k;
      var offset = 0;
      for (var i = 0, length = data.length; i < length; i += 4) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        k = data[i + 3];

        data[offset++] = -122.67195406894 +
          Cb * (-6.60635669420364e-5 * Cb + 0.000437130475926232 * Cr -
                5.4080610064599e-5 * Y + 0.00048449797120281 * k -
                0.154362151871126) +
          Cr * (-0.000957964378445773 * Cr + 0.000817076911346625 * Y -
                0.00477271405408747 * k + 1.53380253221734) +
          Y * (0.000961250184130688 * Y - 0.00266257332283933 * k +
               0.48357088451265) +
          k * (-0.000336197177618394 * k + 0.484791561490776);

        data[offset++] = 107.268039397724 +
          Cb * (2.19927104525741e-5 * Cb - 0.000640992018297945 * Cr +
                0.000659397001245577 * Y + 0.000426105652938837 * k -
                0.176491792462875) +
          Cr * (-0.000778269941513683 * Cr + 0.00130872261408275 * Y +
                0.000770482631801132 * k - 0.151051492775562) +
          Y * (0.00126935368114843 * Y - 0.00265090189010898 * k +
               0.25802910206845) +
          k * (-0.000318913117588328 * k - 0.213742400323665);

        data[offset++] = -20.810012546947 +
          Cb * (-0.000570115196973677 * Cb - 2.63409051004589e-5 * Cr +
                0.0020741088115012 * Y - 0.00288260236853442 * k +
                0.814272968359295) +
          Cr * (-1.53496057440975e-5 * Cr - 0.000132689043961446 * Y +
                0.000560833691242812 * k - 0.195152027534049) +
          Y * (0.00174418132927582 * Y - 0.00255243321439347 * k +
               0.116935020465145) +
          k * (-0.000343531996510555 * k + 0.24165260232407);
      }
      // Ensure that only the converted RGB data is returned.
      return data.subarray(0, offset);
    },

    _convertYcckToCmyk: function convertYcckToCmyk(data) {
      var Y, Cb, Cr;
      for (var i = 0, length = data.length; i < length; i += 4) {
        Y = data[i];
        Cb = data[i + 1];
        Cr = data[i + 2];
        data[i] = 434.456 - Y - 1.402 * Cr;
        data[i + 1] = 119.541 - Y + 0.344 * Cb + 0.714 * Cr;
        data[i + 2] = 481.816 - Y - 1.772 * Cb;
        // K in data[i + 3] is unchanged
      }
      return data;
    },

    _convertCmykToRgb: function convertCmykToRgb(data) {
      var c, m, y, k;
      var offset = 0;
      var scale = 1 / 255;
      for (var i = 0, length = data.length; i < length; i += 4) {
        c = data[i] * scale;
        m = data[i + 1] * scale;
        y = data[i + 2] * scale;
        k = data[i + 3] * scale;

        data[offset++] = 255 +
          c * (-4.387332384609988 * c + 54.48615194189176 * m +
               18.82290502165302 * y + 212.25662451639585 * k -
               285.2331026137004) +
          m * (1.7149763477362134 * m - 5.6096736904047315 * y -
               17.873870861415444 * k - 5.497006427196366) +
          y * (-2.5217340131683033 * y - 21.248923337353073 * k +
               17.5119270841813) -
          k * (21.86122147463605 * k + 189.48180835922747);

        data[offset++] = 255 +
          c * (8.841041422036149 * c + 60.118027045597366 * m +
               6.871425592049007 * y + 31.159100130055922 * k -
               79.2970844816548) +
          m * (-15.310361306967817 * m + 17.575251261109482 * y +
               131.35250912493976 * k - 190.9453302588951) +
          y * (4.444339102852739 * y + 9.8632861493405 * k -
               24.86741582555878) -
          k * (20.737325471181034 * k + 187.80453709719578);

        data[offset++] = 255 +
          c * (0.8842522430003296 * c + 8.078677503112928 * m +
               30.89978309703729 * y - 0.23883238689178934 * k -
               14.183576799673286) +
          m * (10.49593273432072 * m + 63.02378494754052 * y +
               50.606957656360734 * k - 112.23884253719248) +
          y * (0.03296041114873217 * y + 115.60384449646641 * k -
               193.58209356861505) -
          k * (22.33816807309886 * k + 180.12613974708367);
      }
      // Ensure that only the converted RGB data is returned.
      return data.subarray(0, offset);
    },
    copyToImageData: function copyToImageData(imageData, bytesPerPixel = 4) {

      var width = imageData.width, height = imageData.height;
      var imageDataArray = imageData.data;
      var data = this.getData(width, height);
      var i = 0, j = 0, x, y;
      var Y, K, C, M, R, G, B;
      console.log('data', data);

      console.log('bytesPerPixel', bytesPerPixel);

      console.log('this.components.length', this.components.length);

      if (bytesPerPixel === 3) {
        switch (this.components.length) {
          case 1:
            for (y = 0; y < height; y++) {
              for (x = 0; x < width; x++) {
                Y = data[i++];
  
                imageDataArray[j++] = Y;
                imageDataArray[j++] = Y;
                imageDataArray[j++] = Y;
              }
            }
            break;
          case 3:
            for (y = 0; y < height; y++) {
              for (x = 0; x < width; x++) {
                R = data[i++];
                G = data[i++];
                B = data[i++];

                //console.log('R, G, B', R, G, B)
  
                imageDataArray[j++] = R;
                imageDataArray[j++] = G;
                imageDataArray[j++] = B;
              }
            }
            break;
          case 4:
            for (y = 0; y < height; y++) {
              for (x = 0; x < width; x++) {
                C = data[i++];
                M = data[i++];
                Y = data[i++];
                K = data[i++];
  
                R = 255 - clampTo8bit(C * (1 - K / 255) + K);
                G = 255 - clampTo8bit(M * (1 - K / 255) + K);
                B = 255 - clampTo8bit(Y * (1 - K / 255) + K);
  
                imageDataArray[j++] = R;
                imageDataArray[j++] = G;
                imageDataArray[j++] = B;
              }
            }
            break;
          default:
            throw 'Unsupported color mode';
        }
      } else if (bytesPerPixel === 4) {
        switch (this.components.length) {
          case 1:
            for (y = 0; y < height; y++) {
              for (x = 0; x < width; x++) {
                Y = data[i++];
  
                imageDataArray[j++] = Y;
                imageDataArray[j++] = Y;
                imageDataArray[j++] = Y;
                imageDataArray[j++] = 255;
              }
            }
            break;
          case 3:
            for (y = 0; y < height; y++) {
              for (x = 0; x < width; x++) {
                R = data[i++];
                G = data[i++];
                B = data[i++];
  
                imageDataArray[j++] = R;
                imageDataArray[j++] = G;
                imageDataArray[j++] = B;
                imageDataArray[j++] = 255;
              }
            }
            break;
          case 4:
            for (y = 0; y < height; y++) {
              for (x = 0; x < width; x++) {
                C = data[i++];
                M = data[i++];
                Y = data[i++];
                K = data[i++];
  
                R = 255 - clampTo8bit(C * (1 - K / 255) + K);
                G = 255 - clampTo8bit(M * (1 - K / 255) + K);
                B = 255 - clampTo8bit(Y * (1 - K / 255) + K);
  
                imageDataArray[j++] = R;
                imageDataArray[j++] = G;
                imageDataArray[j++] = B;
                imageDataArray[j++] = 255;
              }
            }
            break;
          default:
            throw 'Unsupported color mode';
        }
      } else {
        throw 'Unsupported bytesPerPixel value: ' + bytesPerPixel
      }

      
    },

    getData: function getData(width, height) {
      var scaleX = this.width / width, scaleY = this.height / height;

      var component1, component2, component3, component4;
      var component1Line, component2Line, component3Line, component4Line;
      var x, y;
      var offset = 0;
      var Y, Cb, Cr, K, C, M, Ye, R, G, B;
      var colorTransform;
      var dataLength = width * height * this.components.length;
      var data = new Uint8Array(dataLength);
      switch (this.components.length) {
        case 1:
          component1 = this.components[0];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];

              data[offset++] = Y;
            }
          }
          break;
        case 2:
          // PDF might compress two component data in custom colorspace
          component1 = this.components[0];
          component2 = this.components[1];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];
              data[offset++] = Y;
              Y = component2Line[0 | (x * component2.scaleX * scaleX)];
              data[offset++] = Y;
            }
          }
          break;
        case 3:
          // The default transform for three components is true
          colorTransform = true;
          // The adobe transform marker overrides any previous setting
          if (this.adobe && this.adobe.transformCode)
            colorTransform = true;
          else if (typeof this.colorTransform !== 'undefined')
            colorTransform = !!this.colorTransform;

          component1 = this.components[0];
          component2 = this.components[1];
          component3 = this.components[2];
          for (y = 0; y < height; y++) {
            //console.log('component1', component1);
            component1Line = component1.output[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.output[0 | (y * component2.scaleY * scaleY)];
            component3Line = component3.output[0 | (y * component3.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              if (!colorTransform) {
                R = component1Line[0 | (x * component1.scaleX * scaleX)];
                G = component2Line[0 | (x * component2.scaleX * scaleX)];
                B = component3Line[0 | (x * component3.scaleX * scaleX)];
              } else {
                Y = component1Line[0 | (x * component1.scaleX * scaleX)];
                Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
                Cr = component3Line[0 | (x * component3.scaleX * scaleX)];

                R = clampTo8bit(Y + 1.402 * (Cr - 128));
                G = clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
                B = clampTo8bit(Y + 1.772 * (Cb - 128));
              }

              data[offset++] = R;
              data[offset++] = G;
              data[offset++] = B;
            }
          }
          break;
        case 4:
          if (!this.adobe)
            throw 'Unsupported color mode (4 components)';
          // The default transform for four components is false
          colorTransform = false;
          // The adobe transform marker overrides any previous setting
          if (this.adobe && this.adobe.transformCode)
            colorTransform = true;
          else if (typeof this.colorTransform !== 'undefined')
            colorTransform = !!this.colorTransform;

          component1 = this.components[0];
          component2 = this.components[1];
          component3 = this.components[2];
          component4 = this.components[3];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
            component4Line = component4.lines[0 | (y * component4.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              if (!colorTransform) {
                C = component1Line[0 | (x * component1.scaleX * scaleX)];
                M = component2Line[0 | (x * component2.scaleX * scaleX)];
                Ye = component3Line[0 | (x * component3.scaleX * scaleX)];
                K = component4Line[0 | (x * component4.scaleX * scaleX)];
              } else {
                Y = component1Line[0 | (x * component1.scaleX * scaleX)];
                Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
                Cr = component3Line[0 | (x * component3.scaleX * scaleX)];
                K = component4Line[0 | (x * component4.scaleX * scaleX)];

                C = 255 - clampTo8bit(Y + 1.402 * (Cr - 128));
                M = 255 - clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
                Ye = 255 - clampTo8bit(Y + 1.772 * (Cb - 128));
              }
              data[offset++] = 255-C;
              data[offset++] = 255-M;
              data[offset++] = 255-Ye;
              data[offset++] = 255-K;
            }
          }
          break;
        default:
          throw 'Unsupported color mode';
      }
      return data;
    },

    _getData({ width, height, forceRGB = false, isSourcePDF = false, }) {
      if (typeof PDFJSDev !== 'undefined' && PDFJSDev.test('TESTING && !LIB')) {
        assert(isSourcePDF === true,
          'JpegImage.getData: Unexpected "isSourcePDF" value for PDF files.');
      }
      if (this.numComponents > 4) {
        throw new JpegError('Unsupported color mode');
      }

      console.log('this.numComponents', this.numComponents);
      // Type of data: Uint8ClampedArray(width * height * numComponents)
      var data = this._getLinearizedBlockData(width, height, isSourcePDF);
      console.log('** data', data);

      console.log('this._isColorConversionNeeded', this._isColorConversionNeeded);

      if (this.numComponents === 1 && forceRGB) {
        var dataLength = data.length;
        var rgbData = new Uint8ClampedArray(dataLength * 3);
        var offset = 0;
        for (var i = 0; i < dataLength; i++) {
          var grayColor = data[i];
          rgbData[offset++] = grayColor;
          rgbData[offset++] = grayColor;
          rgbData[offset++] = grayColor;
        }
        return rgbData;
      } else if (this.numComponents === 3 && this._isColorConversionNeeded) {
        return this._convertYccToRgb(data);
      } else if (this.numComponents === 4) {
        if (this._isColorConversionNeeded) {
          if (forceRGB) {
            return this._convertYcckToRgb(data);
          }
          return this._convertYcckToCmyk(data);
        } else if (forceRGB) {
          return this._convertCmykToRgb(data);
        }
      }
      return data;
    },

    
  };



  return JpegImage;
})();
module.exports = decode;

function decode(jpegData, opts) {
  //console.log('1) opts', opts);
  var defaultOpts = {
    useTArray: false,
    colorTransform: true,
    bytesPerPixel: 4
  };
  if (opts) {
    if (typeof opts === 'object') {
      opts = {
        useTArray: (typeof opts.useTArray === 'undefined' ?
                    defaultOpts.useTArray : opts.useTArray),
        colorTransform: (typeof opts.colorTransform === 'undefined' ?
                         defaultOpts.colorTransform : opts.colorTransform),
                         bytesPerPixel: opts.bytesPerPixel || defaultOpts.bytesPerPixel
      };
    } else {
      // backwards compatiblity, before 0.3.5, we only had the useTArray param
      opts = defaultOpts;
      opts.useTArray = true;
    }
  } else {
    opts = defaultOpts;
  }

  const bytesPerPixel = opts.bytesPerPixel || defaultOpts.bytesPerPixel;
  //console.log('bytesPerPixel', bytesPerPixel);
  //console.log('2) opts', opts);

  console.log('opts.useTArray', opts.useTArray);
  console.log('jpegData', jpegData);

  var arr = new Uint8Array(jpegData);
  var decoder = new JpegImage();
  decoder.parse(arr);
  decoder.colorTransform = opts.colorTransform;

  var image = {
    width: decoder.width,
    height: decoder.height,
    data: opts.useTArray ?
      new Uint8Array(decoder.width * decoder.height * bytesPerPixel) :
      new Buffer(decoder.width * decoder.height * bytesPerPixel)
  };

  

  // Could retrieve just the RBG Image Data.
  //  No alpha channel

  decoder.copyToImageData(image, bytesPerPixel);
  //throw 'stop';

  return image;
}