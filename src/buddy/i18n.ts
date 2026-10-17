// Spoken/visible strings in English, Spanish and Hindi. Medical facts never live here: they come from the
// curated MedlinePlus summaries, the cited FDA-label interaction table, or live openFDA label text.
import type { Lang } from '../data/drugs.js';

export const DISCLAIMER: Record<Lang, string> = {
  en: 'Not medical advice. Ask your doctor or pharmacist.',
  es: 'No es consejo médico. Consulte a su médico o farmacéutico.',
  hi: 'यह चिकित्सकीय सलाह नहीं है। अपने डॉक्टर या फ़ार्मासिस्ट से पूछें।',
};
export const NEVER_STOP: Record<Lang, string> = {
  en: "Please don't stop any of your medicines on your own.",
  es: 'Por favor, no deje de tomar ninguno de sus medicamentos por su cuenta.',
  hi: 'कृपया अपनी कोई भी दवा ख़ुद से बंद न करें।',
};
export const CALL_DOCTOR: Record<Lang, string> = {
  en: 'Please call your doctor today about this.',
  es: 'Por favor, llame hoy a su médico por esto.',
  hi: 'कृपया आज ही इस बारे में अपने डॉक्टर को फ़ोन करें।',
};
export const ASK_FIRST: Record<Lang, (x: string) => string> = {
  en: (x) => `Please don't take ${x} until you've checked with your doctor or pharmacist.`,
  es: (x) => `Por favor, no tome ${x} hasta consultarlo con su médico o farmacéutico.`,
  hi: (x) => `कृपया डॉक्टर या फ़ार्मासिस्ट से पूछे बिना ${x} न लें।`,
};

export function fmtTime(hhmm: string, lang: Lang) {
  const [h, m] = hhmm.split(':').map(Number);
  if (lang === 'en') { const ap = h < 12 ? 'AM' : 'PM'; const hh = h % 12 || 12; return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`; }
  if (lang === 'es') return `${h}:${String(m).padStart(2, '0')}`;
  const part = h < 12 ? 'सुबह' : h < 17 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात';
  return `${part} ${h % 12 || 12}:${String(m).padStart(2, '0')} बजे`;
}
export const SEV: Record<Lang, Record<string, string>> = {
  en: { severe: 'Serious warning', high: 'Important warning', moderate: 'Caution', label: 'Label mention' },
  es: { severe: 'Advertencia grave', high: 'Advertencia importante', moderate: 'Precaución', label: 'Mención en la etiqueta' },
  hi: { severe: 'गंभीर चेतावनी', high: 'महत्वपूर्ण चेतावनी', moderate: 'सावधानी', label: 'लेबल में उल्लेख' },
};
export const and_: Record<Lang, string> = { en: 'and', es: 'y', hi: 'और' };
export function list(items: string[], lang: Lang) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ` ${and_[lang]} ` + items[items.length - 1];
}
export const tablets = (n: number, lang: Lang) => lang === 'en' ? `${n} tablet${n === 1 ? '' : 's'}` : lang === 'es' ? `${n} tableta${n === 1 ? '' : 's'}` : `${n} गोली`;
