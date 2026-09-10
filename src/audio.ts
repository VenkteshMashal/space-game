export class FlightAudio {
  enabled = false;
  private context?: AudioContext;
  private gain?: GainNode;
  private oscillator?: OscillatorNode;

  async toggle() {
    this.enabled = !this.enabled;
    if (this.enabled && !this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 190;
      this.oscillator = this.context.createOscillator();
      this.oscillator.type = 'sawtooth'; this.oscillator.frequency.value = 42;
      this.oscillator.connect(filter); filter.connect(this.gain); this.gain.connect(this.context.destination);
      this.oscillator.start();
    }
    if (this.context?.state === 'suspended') await this.context.resume();
    this.update(0, false);
    return this.enabled;
  }

  update(thrust: number, paused: boolean) {
    if (!this.context || !this.gain || !this.oscillator) return;
    this.gain.gain.setTargetAtTime(this.enabled && !paused ? 0.012 + thrust * 0.028 : 0, this.context.currentTime, 0.15);
    this.oscillator.frequency.setTargetAtTime(40 + thrust * 27, this.context.currentTime, 0.15);
  }

  ping() {
    if (!this.enabled || !this.context) return;
    const tone = this.context.createOscillator();
    const volume = this.context.createGain();
    tone.frequency.setValueAtTime(660, this.context.currentTime);
    tone.frequency.exponentialRampToValueAtTime(880, this.context.currentTime + 0.12);
    volume.gain.setValueAtTime(0.055, this.context.currentTime);
    volume.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.3);
    tone.connect(volume); volume.connect(this.context.destination);
    tone.start(); tone.stop(this.context.currentTime + 0.3);
    tone.onended = () => { tone.disconnect(); volume.disconnect(); };
  }
}
