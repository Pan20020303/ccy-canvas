import type { CanvasPreferences } from './canvas-preferences';

export async function requestCanvasNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  try { return (Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()) === 'granted'; } catch { return false; }
}
const tones: Record<string, number[]> = {
  clear: [880,1175], soft: [440,554], bell: [784,1047,1568], bubble: [660,880,660], melody: [523,659,784],
  piano: [392,523,659], wood: [587,784], horn: [330,440,660], crystal: [1047,1319,1568], light: [659,784,988],
};
export async function playNotificationSound(style: string) {
  if (typeof AudioContext === 'undefined') throw new Error('Web Audio is unavailable');
  const context = new AudioContext();
  try {
    await context.resume();
    const frequencies = tones[style] || tones.clear;
    frequencies.forEach((frequency,index) => {
      const oscillator = context.createOscillator(); const gain = context.createGain();
      const time = context.currentTime + index * .13;
      oscillator.type = style === 'horn' ? 'triangle' : 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0,time); gain.gain.linearRampToValueAtTime(.055,time + .012); gain.gain.exponentialRampToValueAtTime(.001,time + .34);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(time); oscillator.stop(time + .35);
    });
    setTimeout(() => { void context.close(); }, frequencies.length * 130 + 500);
  } catch (error) { void context.close(); throw error; }
}
export function shouldNotifyGeneration(preferences: CanvasPreferences, event: { failed: boolean; own: boolean; away: boolean }) {
  return (event.failed ? preferences.notifyFailed : preferences.notifyCompleted) && (!preferences.onlyOwn || event.own) && (preferences.notifyWhen === 'always' || event.away);
}
