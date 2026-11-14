class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(1600);
    this.count = 0;
    this.sum = 0;
    this.accumulated = 0;
    this.position = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / 16000;
    for (const sample of input) {
      this.sum += sample;
      this.accumulated++;
      this.position++;
      if (this.position >= ratio) {
        this.samples[this.count++] = this.sum / this.accumulated;
        this.position -= ratio;
        this.sum = 0;
        this.accumulated = 0;
        if (this.count === this.samples.length) {
          const buffer = new ArrayBuffer(this.count * 2);
          const view = new DataView(buffer);
          for (let i = 0; i < this.count; i++)
            view.setInt16(
              i * 2,
              Math.round(Math.max(-1, Math.min(1, this.samples[i])) * 32767),
              true,
            );
          this.port.postMessage(buffer, [buffer]);
          this.count = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
