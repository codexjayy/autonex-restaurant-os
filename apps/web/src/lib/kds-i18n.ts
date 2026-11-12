export type KdsLocale = 'en' | 'gu' | 'hi';

export interface KdsTranslations {
  title: string;
  subtitle: string;
  backToDashboard: string;
  liveWs: string;
  pollingFallback: string;
  offline: string;
  offlineBanner: string;
  pollingBanner: string;
  enableSoundPrompt: string;
  soundOn: string;
  soundMuted: string;
  testChime: string;
  syncNow: string;
  includeServed: string;
  filterAll: string;
  statusNew: string;
  statusPreparing: string;
  statusReady: string;
  statusServed: string;
  statusCancelled: string;
  unackedBadge: string;
  ackedLabel: string;
  addOnBadge: string;
  roundLabel: string;
  tableLabel: string;
  notesLabel: string;
  btnAcknowledge: string;
  btnStartPreparing: string;
  btnMarkReady: string;
  btnMarkServed: string;
  btnCancelKot: string;
  btnPrintKot: string;
  emptyBoardTitle: string;
  emptyBoardHint: string;
  unackedCounter: string;
  openCounter: string;
  reconnectedSyncedPrefix: string;
}

export const KDS_TRANSLATIONS: Record<KdsLocale, KdsTranslations> = {
  en: {
    title: 'Kitchen Display (KDS)',
    subtitle: 'Tap Acknowledge on new orders to confirm receipt and stop alert chimes.',
    backToDashboard: 'Dashboard',
    liveWs: 'Live Real-Time',
    pollingFallback: 'Backup 4s Polling',
    offline: 'Offline — Reconnecting',
    offlineBanner:
      'Wi-Fi / API connection lost. Showing last synced tickets and retrying automatically...',
    pollingBanner:
      'Live WebSocket interrupted. Running 4s HTTP polling recovery so no orders are missed.',
    enableSoundPrompt: 'Tap to enable audio bell for new incoming KOT alerts',
    soundOn: 'Sound On',
    soundMuted: 'Muted',
    testChime: 'Test Bell',
    syncNow: 'Sync Now',
    includeServed: 'Show Served',
    filterAll: 'All Open',
    statusNew: 'NEW',
    statusPreparing: 'PREPARING',
    statusReady: 'READY',
    statusServed: 'SERVED',
    statusCancelled: 'CANCELLED',
    unackedBadge: 'UNACKNOWLEDGED — CONFIRM RECEIPT',
    ackedLabel: 'Confirmed',
    addOnBadge: 'ADD-ON',
    roundLabel: 'Round',
    tableLabel: 'Table',
    notesLabel: 'Order Note',
    btnAcknowledge: 'Confirm Receipt',
    btnStartPreparing: 'Start Preparing',
    btnMarkReady: 'Mark Ready',
    btnMarkServed: 'Mark Served',
    btnCancelKot: 'Cancel',
    btnPrintKot: 'Print KOT',
    emptyBoardTitle: 'Kitchen queue is clear',
    emptyBoardHint: 'New customer QR and waiter orders will appear here automatically.',
    unackedCounter: 'Needs Confirm',
    openCounter: 'Active KOTs',
    reconnectedSyncedPrefix: 'Connection restored — board synchronized',
  },
  gu: {
    title: 'રસોડું ડિસ્પ્લે (KDS)',
    subtitle: 'નવા ઓર્ડરની ઘંટડી બંધ કરવા અને રસીદ કન્ફર્મ કરવા Confirm દબાવો.',
    backToDashboard: 'ડેશબોર્ડ',
    liveWs: 'લાઇવ કનેક્ટેડ',
    pollingFallback: 'બેકઅપ 4s પોલિંગ',
    offline: 'ઓફલાઇન — ફરી જોડાઈ રહ્યું છે',
    offlineBanner:
      'ઇન્ટરનેટ અથવા સર્વર કનેક્શન તૂટી ગયું છે. છેલ્લા ઓર્ડર બતાવીએ છીએ અને ફરી પ્રયાસ ચાલુ છે...',
    pollingBanner:
      'લાઇવ WebSocket બંધ છે. કોઈ ઓર્ડર ચૂકી ન જવાય માટે 4s પોલિંગ ચાલુ છે.',
    enableSoundPrompt: 'નવા ઓર્ડરની ઘંટડી ચાલુ કરવા અહીં ટચ કરો',
    soundOn: 'અવાજ ચાલુ',
    soundMuted: 'અવાજ બંધ',
    testChime: 'ટેસ્ટ ઘંટડી',
    syncNow: 'રિફ્રેશ',
    includeServed: 'સર્વ થયેલા બતાવો',
    filterAll: 'બધા ચાલુ',
    statusNew: 'નવો ઓર્ડર',
    statusPreparing: 'બને છે',
    statusReady: 'તૈયાર',
    statusServed: 'સર્વ થયું',
    statusCancelled: 'રદ',
    unackedBadge: 'કન્ફર્મ બાકી — રસીદ સ્વીકારો',
    ackedLabel: 'કન્ફર્મ',
    addOnBadge: 'વધારાનો',
    roundLabel: 'રાઉન્ડ',
    tableLabel: 'ટેબલ',
    notesLabel: 'સૂચના',
    btnAcknowledge: 'રસીદ કન્ફર્મ કરો',
    btnStartPreparing: 'બનાવવાનું શરૂ કરો',
    btnMarkReady: 'તૈયાર છે (READY)',
    btnMarkServed: 'પહોંચાડી દીધું',
    btnCancelKot: 'રદ કરો',
    btnPrintKot: 'KOT પ્રિન્ટ',
    emptyBoardTitle: 'કોઈ પેન્ડિંગ ઓર્ડર નથી',
    emptyBoardHint: 'નવા QR અથવા વેઇટર ઓર્ડર અહીં તરત જ દેખાશે.',
    unackedCounter: 'કન્ફર્મ બાકી',
    openCounter: 'ચાલુ KOT',
    reconnectedSyncedPrefix: 'કનેક્શન પાછું આવી ગયું — બધા ઓર્ડર અપડેટ થયા',
  },
  hi: {
    title: 'रसोई डिस्प्ले (KDS)',
    subtitle: 'नए ऑर्डर की घंटी बंद करने और रसीद कन्फर्म करने के लिए दबाएँ।',
    backToDashboard: 'डैशबोर्ड',
    liveWs: 'लाइव कनेक्टेड',
    pollingFallback: 'बैकअप 4s पोलिंग',
    offline: 'ऑफ़लाइन — फिर से जुड़ रहा है',
    offlineBanner:
      'इंटरनेट या सर्वर संपर्क टूट गया है। पिछले ऑर्डर दिख रहे हैं और पुनः प्रयास जारी है...',
    pollingBanner:
      'लाइव WebSocket बाधित है। कोई ऑर्डर न छूटे इसके लिए 4s पोलिंग सक्रिय है।',
    enableSoundPrompt: 'नए ऑर्डर की घंटी चालू करने के लिए यहाँ टैप करें',
    soundOn: 'आवाज़ चालू',
    soundMuted: 'आवाज़ बंद',
    testChime: 'टेस्ट घंटी',
    syncNow: 'सिंक करें',
    includeServed: 'परोसे गए दिखाएँ',
    filterAll: 'सभी सक्रिय',
    statusNew: 'नया ऑर्डर',
    statusPreparing: 'बन रहा है',
    statusReady: 'तैयार',
    statusServed: 'परोसा गया',
    statusCancelled: 'रद्द',
    unackedBadge: 'पुष्टि बाकी — रसीद स्वीकार करें',
    ackedLabel: 'स्वीकृत',
    addOnBadge: 'ऐड-ऑन',
    roundLabel: 'राउंड',
    tableLabel: 'टेबल',
    notesLabel: 'नोट',
    btnAcknowledge: 'ऑर्डर स्वीकार करें',
    btnStartPreparing: 'बनाना शुरू करें',
    btnMarkReady: 'तैयार है (READY)',
    btnMarkServed: 'परोसा गया',
    btnCancelKot: 'रद्द करें',
    btnPrintKot: 'KOT प्रिंट',
    emptyBoardTitle: 'रसोई में अभी कोई पेंडिंग ऑर्डर नहीं है',
    emptyBoardHint: 'नए QR या वेटर ऑर्डर यहाँ अपने-आप दिखाई देंगे।',
    unackedCounter: 'पुष्टि बाकी',
    openCounter: 'सक्रिय KOT',
    reconnectedSyncedPrefix: 'कनेक्शन बहाल — सभी ऑर्डर सिंक हो गए',
  },
};

const KDS_LOCALE_KEY = 'autonex_kds_locale';

export function loadSavedKdsLocale(): KdsLocale {
  if (typeof window === 'undefined') return 'en';
  const saved = window.localStorage.getItem(KDS_LOCALE_KEY);
  if (saved === 'gu' || saved === 'hi' || saved === 'en') return saved;
  return 'en';
}

export function saveKdsLocale(locale: KdsLocale): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KDS_LOCALE_KEY, locale);
}

