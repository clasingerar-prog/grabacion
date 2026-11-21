// Carga lamejs desde CDN compatible con GitHub Pages
// (También puedes descargar lame.min.js a tu repo y cambiar esta línea por: importScripts("lame.min.js");)
importScripts("https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js");

self.onmessage = function (e) {
  try {
    const { pcmFloat32, sampleRate, kbps } = e.data;

    // 1 canal (Mono), sampleRate (ej. 44100), bitrate (ej. 64 o 96)
    const mp3Encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const mp3Data = [];

    // Tamaño de bloque estándar para LAME (múltiplo de 576)
    const blockSize = 1152;
    const totalSamples = pcmFloat32.length;
    const int16Buffer = new Int16Array(blockSize);

    let lastReportedProgress = -1;

    for (let i = 0; i < totalSamples; i += blockSize) {
      const chunkLen = Math.min(blockSize, totalSamples - i);

      // Convertir Float32 [-1.0, 1.0] a Int16 [-32768, 32767] por bloques para ahorrar RAM
      for (let j = 0; j < chunkLen; j++) {
        let s = pcmFloat32[i + j];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        int16Buffer[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      const slice = chunkLen === blockSize ? int16Buffer : int16Buffer.subarray(0, chunkLen);
      const mp3buf = mp3Encoder.encodeBuffer(slice);
      if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
      }

      // Reportar progreso cada 2 % para no saturar mensajes
      const progress = Math.floor((i / totalSamples) * 100);
      if (progress !== lastReportedProgress && progress % 2 === 0) {
        lastReportedProgress = progress;
        self.postMessage({ type: "progress", progress });
      }
    }

    const endBuf = mp3Encoder.flush();
    if (endBuf.length > 0) {
      mp3Data.push(endBuf);
    }

    const mp3Blob = new Blob(mp3Data, { type: "audio/mp3" });
    self.postMessage({ type: "done", mp3Blob });
  } catch (err) {
    self.postMessage({ type: "error", error: err.message || String(err) });
  }
};
