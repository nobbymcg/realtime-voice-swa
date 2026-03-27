/**
 * AudioWorklet processor that captures microphone audio,
 * downsamples to 24kHz, and converts to PCM16 (Int16).
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0]; // Mono channel
    if (!channelData) return true;

    // The AudioContext runs at 24000 Hz (set on creation),
    // so samples are already at the target rate.
    // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
    const pcm16 = new Int16Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Send the raw PCM16 bytes to the main thread
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
