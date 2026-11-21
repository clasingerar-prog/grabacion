(() => {
  // Referencias DOM
  const sourceModeEl = document.getElementById("sourceMode");
  const deviceSelectGroupEl = document.getElementById("deviceSelectGroup");
  const audioDeviceSelectEl = document.getElementById("audioDeviceSelect");
  const refreshDevicesBtn = document.getElementById("refreshDevicesBtn");
  const opusBitrateEl = document.getElementById("opusBitrate");
  const mp3BitrateEl = document.getElementById("mp3Bitrate");

  const testInputBtn = document.getElementById("testInputBtn");
  const inputStatusText = document.getElementById("inputStatusText");

  const recBadge = document.getElementById("recBadge");
  const recStateText = document.getElementById("recStateText");
  const timerDisplay = document.getElementById("timerDisplay");
  const peakLabel = document.getElementById("peakLabel");

  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const stopBtn = document.getElementById("stopBtn");

  const exportSection = document.getElementById("exportSection");
  const audioPreview = document.getElementById("audioPreview");
  const fileMeta = document.getElementById("fileMeta");
  const downloadOpusBtn = document.getElementById("downloadOpusBtn");
  const convertMp3Btn = document.getElementById("convertMp3Btn");

  const mp3ProgressBox = document.getElementById("mp3ProgressBox");
  const mp3ProgressLabel = document.getElementById("mp3ProgressLabel");
  const mp3ProgressPercent = document.getElementById("mp3ProgressPercent");
  const mp3ProgressFill = document.getElementById("mp3ProgressFill");

  const canvas = document.getElementById("audioMeterCanvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  // Estado global de audio y grabación
  let audioContext = null;
  let analyser = null;
  let mixedDestination = null;
  let activeStreams = [];
  let mediaRecorder = null;
  let recordedChunks = [];
  let finalAudioBlob = null;
  let finalMimeType = "audio/webm";
  let isTestingInput = false;

  // Cronómetro y medidor de bajo consumo
  let timerInterval = null;
  let meterInterval = null;
  let elapsedMs = 0;
  let lastTick = 0;

  // Inicializar lista de dispositivos de entrada
  async function loadAudioDevices(requestPermissionFirst = false) {
    try {
      if (requestPermissionFirst) {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach((t) => t.stop());
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");

      const previousValue = audioDeviceSelectEl.value;
      audioDeviceSelectEl.innerHTML = "";

      if (audioInputs.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No se detectaron entradas de audio";
        audioDeviceSelectEl.appendChild(opt);
        return;
      }

      audioInputs.forEach((device, idx) => {
        const opt = document.createElement("option");
        opt.value = device.deviceId;
        opt.textContent =
          device.label || `Entrada de audio #${idx + 1} (Permiso requerido para ver nombre)`;
        audioDeviceSelectEl.appendChild(opt);
      });

      if ([...audioDeviceSelectEl.options].some((o) => o.value === previousValue)) {
        audioDeviceSelectEl.value = previousValue;
      }
    } catch (err) {
      console.error("Error listando dispositivos:", err);
      inputStatusText.textContent = "Permiso de audio denegado o no disponible.";
    }
  }

  // Mostrar u ocultar selector de dispositivo según modo
  sourceModeEl.addEventListener("change", () => {
    const mode = sourceModeEl.value;
    deviceSelectGroupEl.classList.toggle("hidden", mode === "system");
  });

  refreshDevicesBtn.addEventListener("click", () => loadAudioDevices(true));

  // Construir el grafo de audio (compartido, mono, bajo consumo)
  async function setupAudioPipeline() {
    cleanupStreams();

    const mode = sourceModeEl.value;
    const selectedDeviceId = audioDeviceSelectEl.value;

    // SampleRate 44100 Hz estándar para compatibilidad directa con MP3
    audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 44100,
    });

    mixedDestination = audioContext.createMediaStreamDestination();
    // Forzar salida mono (1 canal) para reducir tamaño y CPU a la mitad
    mixedDestination.channelCount = 1;

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256; // Muy ligero para la CPU
    analyser.smoothingTimeConstant = 0.6;

    // 1. Captura desde Entrada de Línea / Micrófono (modo compartido)
    if (mode === "device" || mode === "both") {
      const constraints = {
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          // Desactivar filtros agresivos para preservar fidelidad de entrada de línea
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      };

      const deviceStream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStreams.push(deviceStream);

      const sourceNode = audioContext.createMediaStreamSource(deviceStream);
      sourceNode.connect(analyser);
      sourceNode.connect(mixedDestination);
    }

    // 2. Captura desde Audio del Sistema / Pestaña / Reunión
    if (mode === "system" || mode === "both") {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // Requerido por el navegador para habilitar audio del sistema
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // Detener inmediatamente las pistas de video para no gastar CPU ni RAM
      displayStream.getVideoTracks().forEach((track) => track.stop());

      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error(
          "No se compartió el audio del sistema. Asegúrate de marcar la casilla 'Compartir audio'."
        );
      }

      const sysAudioOnlyStream = new MediaStream(audioTracks);
      activeStreams.push(sysAudioOnlyStream);

      const sysNode = audioContext.createMediaStreamSource(sysAudioOnlyStream);
      sysNode.connect(analyser);
      sysNode.connect(mixedDestination);

      // Si el usuario detiene la compartición desde la barra del navegador
      audioTracks[0].onended = () => {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          stopRecording();
        } else if (isTestingInput) {
          stopInputTest();
        }
      };
    }

    // Actualizar nombres reales de dispositivos una vez otorgado permiso
    loadAudioDevices(false);
  }

  function cleanupStreams() {
    stopMeter();
    activeStreams.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    activeStreams = [];

    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    analyser = null;
    mixedDestination = null;
  }

  // Dibujo del vúmetro de bajo consumo (~22 fps)
  function startMeter() {
    stopMeter();
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const barCount = 36;

    meterInterval = setInterval(() => {
      if (!analyser) return;
      analyser.getByteFrequencyData(dataArray);

      // Calcular nivel RMS / pico aproximado
      let sum = 0;
      let maxVal = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i];
        sum += v * v;
        if (v > maxVal) maxVal = v;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const db = rms > 0 ? (20 * Math.log10(rms / 255)).toFixed(1) : "-∞";
      peakLabel.textContent = `Nivel: ${db} dB`;

      // Limpiar fondo
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width - (barCount - 1) * 3) / barCount;
      const step = Math.max(1, Math.floor(dataArray.length / barCount));

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step] || 0;
        const percent = val / 255;
        const barHeight = Math.max(3, percent * (canvas.height - 8));

        if (percent > 0.82) {
          ctx.fillStyle = "#ef4444"; // Pico alto
        } else if (percent > 0.55) {
          ctx.fillStyle = "#f59e0b"; // Nivel medio-alto
        } else {
          ctx.fillStyle = "#22c55e"; // Nivel óptimo
        }

        const x = i * (barWidth + 3);
        const y = canvas.height - barHeight - 4;
        ctx.fillRect(x, y, barWidth, barHeight);
      }
    }, 45); // ~22 FPS: fluido visualmente y mínimo uso de CPU
  }

  function stopMeter() {
    if (meterInterval) {
      clearInterval(meterInterval);
      meterInterval = null;
    }
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    peakLabel.textContent = "Nivel: -∞ dB";
  }

  // Probar entrada antes de grabar
  testInputBtn.addEventListener("click", async () => {
    if (isTestingInput) {
      stopInputTest();
      return;
    }

    try {
      await setupAudioPipeline();
      isTestingInput = true;
      startMeter();
      testInputBtn.textContent = "Detener prueba";
      inputStatusText.textContent = "Monitoreando señal entrante (sin grabar)";
      updateBadge("monitoring", "PROBANDO ENTRADA");
    } catch (err) {
      alert(err.message || "No se pudo acceder a la entrada de audio.");
      cleanupStreams();
    }
  });

  function stopInputTest() {
    isTestingInput = false;
    cleanupStreams();
    testInputBtn.textContent = "Probar entrada de audio";
    inputStatusText.textContent = "Entrada inactiva";
    updateBadge("", "LISTO");
  }

  // Cronómetro
  function startTimer() {
    lastTick = Date.now();
    timerInterval = setInterval(() => {
      const now = Date.now();
      elapsedMs += now - lastTick;
      lastTick = now;
      timerDisplay.textContent = formatDuration(elapsedMs);
    }, 250);
  }

  function pauseTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function resetTimer() {
    pauseTimer();
    elapsedMs = 0;
    timerDisplay.textContent = "00:00:00";
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
    const s = String(totalSec % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function updateBadge(stateClass, text) {
    recBadge.className = "badge" + (stateClass ? ` ${stateClass}` : "");
    recStateText.textContent = text;
  }

  // Elegir mejor codec Opus nativo disponible
  function getSupportedOpusMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm",
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  // Iniciar grabación
  startBtn.addEventListener("click", async () => {
    try {
      if (isTestingInput) {
        stopInputTest();
      }

      exportSection.classList.add("hidden");
      mp3ProgressBox.classList.add("hidden");
      recordedChunks = [];
      finalAudioBlob = null;

      await setupAudioPipeline();

      const mimeType = getSupportedOpusMimeType();
      const bitrate = parseInt(opusBitrateEl.value, 10);

      const options = { audioBitsPerSecond: bitrate };
      if (mimeType) options.mimeType = mimeType;

      mediaRecorder = new MediaRecorder(mixedDestination.stream, options);
      finalMimeType = mediaRecorder.mimeType || mimeType || "audio/webm";

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = handleRecordingStopped;

      // Recolectar bloques cada 2 segundos para mantener memoria estable
      mediaRecorder.start(2000);

      resetTimer();
      startTimer();
      startMeter();

      // Bloquear cambios de configuración durante grabación
      sourceModeEl.disabled = true;
      audioDeviceSelectEl.disabled = true;
      opusBitrateEl.disabled = true;
      testInputBtn.disabled = true;

      startBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled = false;
      pauseBtn.textContent = "❚❚ Pausar";

      inputStatusText.textContent = "Capturando audio en segundo plano...";
      updateBadge("recording", "GRABANDO");
    } catch (err) {
      alert(err.message || "Error al iniciar la grabación.");
      cleanupStreams();
    }
  });

  // Pausar / Reanudar
  pauseBtn.addEventListener("click", () => {
    if (!mediaRecorder) return;

    if (mediaRecorder.state === "recording") {
      mediaRecorder.pause();
      pauseTimer();
      pauseBtn.textContent = "▶ Reanudar";
      updateBadge("paused", "PAUSADO");
    } else if (mediaRecorder.state === "paused") {
      mediaRecorder.resume();
      startTimer();
      pauseBtn.textContent = "❚❚ Pausar";
      updateBadge("recording", "GRABANDO");
    }
  });

  // Detener grabación
  stopBtn.addEventListener("click", stopRecording);

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    pauseTimer();
    cleanupStreams();

    sourceModeEl.disabled = false;
    audioDeviceSelectEl.disabled = false;
    opusBitrateEl.disabled = false;
    testInputBtn.disabled = false;

    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled = true;
    pauseBtn.textContent = "❚❚ Pausar";

    inputStatusText.textContent = "Grabación finalizada";
    updateBadge("", "FINALIZADO");
  }

  // Procesar resultado al detener
  function handleRecordingStopped() {
    finalAudioBlob = new Blob(recordedChunks, { type: finalMimeType });
    const url = URL.createObjectURL(finalAudioBlob);
    audioPreview.src = url;

    const sizeMB = (finalAudioBlob.size / (1024 * 1024)).toFixed(2);
    fileMeta.textContent = `Duración: ${timerDisplay.textContent} • Formato nativo: Opus (${sizeMB} MB)`;

    exportSection.classList.remove("hidden");
  }

  function getTimestampFilename(ext) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
      now.getHours()
    )}-${pad(now.getMinutes())}`;
    return `grabacion_${stamp}.${ext}`;
  }

  // Descarga directa en Opus (0 segundos de espera)
  downloadOpusBtn.addEventListener("click", () => {
    if (!finalAudioBlob) return;
    const ext = finalMimeType.includes("ogg") ? "ogg" : "webm";
    triggerDownload(finalAudioBlob, getTimestampFilename(ext));
  });

  // Conversión a MP3 en Web Worker (sin congelar la UI)
  convertMp3Btn.addEventListener("click", async () => {
    if (!finalAudioBlob) return;

    convertMp3Btn.disabled = true;
    mp3ProgressBox.classList.remove("hidden");
    mp3ProgressLabel.textContent = "Decodificando audio...";
    mp3ProgressPercent.textContent = "0%";
    mp3ProgressFill.style.width = "0%";

    try {
      const arrayBuffer = await finalAudioBlob.arrayBuffer();
      const decodeCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 44100,
      });

      const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
      await decodeCtx.close();

      // Extraer canal mono (Float32Array)
      const pcmFloat32 = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const targetKbps = parseInt(mp3BitrateEl.value, 10);

      mp3ProgressLabel.textContent = `Codificando MP3 (${targetKbps} kbps mono)...`;

      const worker = new Worker("mp3-worker.js");

      worker.onmessage = (e) => {
        const { type, progress, mp3Blob, error } = e.data;

        if (type === "progress") {
          mp3ProgressPercent.textContent = `${progress}%`;
          mp3ProgressFill.style.width = `${progress}%`;
        } else if (type === "done") {
          const mp3SizeMB = (mp3Blob.size / (1024 * 1024)).toFixed(2);
          mp3ProgressLabel.textContent = `¡MP3 listo! (${mp3SizeMB} MB)`;
          mp3ProgressPercent.textContent = "100%";
          mp3ProgressFill.style.width = "100%";

          triggerDownload(mp3Blob, getTimestampFilename("mp3"));
          convertMp3Btn.disabled = false;
          worker.terminate();
        } else if (type === "error") {
          alert("Error al convertir a MP3: " + error);
          convertMp3Btn.disabled = false;
          worker.terminate();
        }
      };

      // Transferir buffer al Worker sin duplicar memoria
      worker.postMessage(
        {
          pcmFloat32,
          sampleRate,
          kbps: targetKbps,
        },
        [pcmFloat32.buffer]
      );
    } catch (err) {
      console.error(err);
      alert("No se pudo decodificar el audio para convertirlo a MP3.");
      convertMp3Btn.disabled = false;
    }
  });

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // Cargar dispositivos al abrir la página
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    loadAudioDevices(false);
    navigator.mediaDevices.addEventListener("devicechange", () => loadAudioDevices(false));
  }
})();
