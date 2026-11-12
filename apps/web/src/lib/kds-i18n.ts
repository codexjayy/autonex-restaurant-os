export type KdsLocale = 'en' | 'hi' | 'gu';

export interface KdsTranslations {
  title: string;
  subtitle: string;
  soundOn: string;
  soundOff: string;
  unlockAudio: string;
  testBell: string;
  liveWs: string;
  pollingFallback: string;
  reconnecting: string;
  offline: string;
  blocked: string;
  allOpen: string;
  statusNew: string;
  statusAcknowledged: string;
  statusPreparing: string;
  statusReady: string;
  statusServed: string;
  statusCancelled: string;
  includeServed: string;
  stationAll: string;
  stationMainKitchen: string;
  stationBar: string;
  stationBakery: string;
  stationDesserts: string;
  kotPrefix: string;
  roundPrefix: string;
  tablePrefix: string;
  addOn: string;
  guestSource: string;
  waiterSource: string;
  customerLabel: string;
  waiterLabel: string;
  orderTimeLabel: string;
  prepTimerLabel: string;
  prepTimeEst: string;
  delayedBadge: string;
  urgentDelayBadge: string;
  priorityHigh: string;
  minsAgo: string;
  justNow: string;
  btnAcknowledge: string;
  btnStartPreparing: string;
  btnMarkReady: string;
  btnMarkServed: string;
  btnCancelKot: string;
  btnPrintKot: string;
  btnViewDetails: string;
  closeDetails: string;
  emptyTitle: string;
  emptyDesc: string;
  emptyFilteredTitle: string;
  emptyFilteredDesc: string;
  unacknowledgedAlert: string;
  qtyLabel: string;
  notesLabel: string;
  specialInstructions: string;
  itemNotesLabel: string;
  acknowledgedBy: string;
  cancelConfirmPrompt: string;
  offlineBanner: string;
  blockedBanner: string;
  backToOverview: string;
  timelinePlaced: string;
  timelineAccepted: string;
  timelinePreparing: string;
  timelineReady: string;
  timelineServed: string;
  subtotalLabel: string;
  detailsTitle: string;
  accessPausedPendingTitle: string;
  accessPausedPendingDesc: string;
  accessPausedSuspendedTitle: string;
  accessPausedSuspendedDesc: string;
  accessPausedRoleTitle: string;
  accessPausedRoleDesc: string;
  currentStatusLabel: string;
  subscriptionStatusLabel: string;
  btnCheckApproval: string;
  checkingStatus: string;
  btnOpenOverview: string;
  btnOpenPlan: string;
  lockBanner: string;
}

export const KDS_TRANSLATIONS: Record<KdsLocale, KdsTranslations> = {
  en: {
    title: 'Kitchen Display System',
    subtitle: 'Live KOT Queue',
    soundOn: 'Sound On',
    soundOff: 'Muted',
    unlockAudio: 'Enable Bell',
    testBell: 'Test Bell',
    liveWs: 'Live Stream',
    pollingFallback: 'Auto Sync',
    reconnecting: 'Reconnecting...',
    offline: 'KDS Offline — Reconnecting',
    blocked: 'Access Paused',
    allOpen: 'All Open',
    statusNew: 'New',
    statusAcknowledged: 'Acknowledged',
    statusPreparing: 'Preparing',
    statusReady: 'Ready',
    statusServed: 'Served',
    statusCancelled: 'Cancelled',
    includeServed: 'Show Served (45m)',
    stationAll: 'All Stations',
    stationMainKitchen: 'Main Kitchen',
    stationBar: 'Bar',
    stationBakery: 'Bakery',
    stationDesserts: 'Desserts',
    kotPrefix: 'KOT',
    roundPrefix: 'Round',
    tablePrefix: 'Table',
    addOn: 'ADD-ON',
    guestSource: 'Customer QR',
    waiterSource: 'Waiter POS',
    customerLabel: 'Guest',
    waiterLabel: 'Staff',
    orderTimeLabel: 'Ordered',
    prepTimerLabel: 'Prep Timer',
    prepTimeEst: 'Est.',
    delayedBadge: 'DELAYED',
    urgentDelayBadge: 'URGENT DELAY',
    priorityHigh: 'PRIORITY',
    minsAgo: 'm ago',
    justNow: 'Just now',
    btnAcknowledge: 'Accept Order',
    btnStartPreparing: 'Start Preparing',
    btnMarkReady: 'Mark as Ready',
    btnMarkServed: 'Mark as Served',
    btnCancelKot: 'Cancel',
    btnPrintKot: 'Print KOT',
    btnViewDetails: 'Details',
    closeDetails: 'Close',
    emptyTitle: 'Kitchen queue is clear',
    emptyDesc: 'New QR customer orders and waiter POS orders appear here automatically.',
    emptyFilteredTitle: 'No matching orders in this view',
    emptyFilteredDesc: 'Try switching kitchen station or status filter tabs above.',
    unacknowledgedAlert: 'unaccepted new order(s)',
    qtyLabel: 'Items',
    notesLabel: 'Order Note',
    specialInstructions: 'Special Instructions',
    itemNotesLabel: 'Prep Note',
    acknowledgedBy: 'Accepted by',
    cancelConfirmPrompt: 'Reason for cancelling this KOT (optional):',
    offlineBanner:
      'Wi-Fi / API connection lost. Showing last synced tickets and retrying automatically...',
    blockedBanner:
      'Kitchen live stream is paused because this restaurant requires approval or active access.',
    backToOverview: 'Dashboard',
    timelinePlaced: 'Placed',
    timelineAccepted: 'Accepted',
    timelinePreparing: 'Cooking Started',
    timelineReady: 'Marked Ready',
    timelineServed: 'Served',
    subtotalLabel: 'Subtotal',
    detailsTitle: 'Complete Order Details',
    accessPausedPendingTitle: 'Kitchen Access Paused — Pending Approval',
    accessPausedPendingDesc:
      'Your restaurant account is currently awaiting platform admin approval. Live KDS order streaming, QR customer ordering, and dining operations unlock automatically once verified.',
    accessPausedSuspendedTitle: 'Kitchen Access Paused — Account Suspended',
    accessPausedSuspendedDesc:
      'This restaurant workspace is currently suspended. Contact AutoNex support or review your plan settings to restore live kitchen access.',
    accessPausedRoleTitle: 'Kitchen Display Access Restricted',
    accessPausedRoleDesc:
      'Your current staff role or outlet selection does not permit Kitchen Display access. Switch to a permitted outlet or contact your restaurant owner.',
    currentStatusLabel: 'Restaurant Status',
    subscriptionStatusLabel: 'Plan Status',
    btnCheckApproval: 'Check Status Now',
    checkingStatus: 'Checking...',
    btnOpenOverview: 'Go to Dashboard Overview',
    btnOpenPlan: 'View Plan & Billing',
    lockBanner:
      'Limited mode active — existing table orders can be settled, while new registrations may be restricted.',
  },
  hi: {
    title: 'किचन डिस्प्ले सिस्टम (KDS)',
    subtitle: 'लाइव KOT कतार',
    soundOn: 'आवाज़ चालू',
    soundOff: 'म्यूट',
    unlockAudio: 'घंटी चालू करें',
    testBell: 'टेस्ट घंटी',
    liveWs: 'लाइव स्ट्रीम',
    pollingFallback: 'ऑटो सिंक',
    reconnecting: 'पुनः कनेक्ट हो रहा है...',
    offline: 'KDS ऑफ़लाइन — पुनः कनेक्ट हो रहा है',
    blocked: 'एक्सेस रुका हुआ है',
    allOpen: 'सभी सक्रिय',
    statusNew: 'नया',
    statusAcknowledged: 'स्वीकृत',
    statusPreparing: 'बन रहा है',
    statusReady: 'तैयार',
    statusServed: 'परोसा गया',
    statusCancelled: 'रद्द',
    includeServed: 'परोसे गए दिखाएं (45m)',
    stationAll: 'सभी स्टेशन',
    stationMainKitchen: 'मुख्य रसोई',
    stationBar: 'बार',
    stationBakery: 'बेकरी',
    stationDesserts: 'डेज़र्ट',
    kotPrefix: 'KOT',
    roundPrefix: 'राउंड',
    tablePrefix: 'टेबल',
    addOn: 'एड-ऑन',
    guestSource: 'ग्राहक QR',
    waiterSource: 'वेटर POS',
    customerLabel: 'ग्राहक',
    waiterLabel: 'स्टाफ',
    orderTimeLabel: 'समय',
    prepTimerLabel: 'तैयारी टाइमर',
    prepTimeEst: 'अनुमान',
    delayedBadge: 'विलंबित',
    urgentDelayBadge: 'अति विलंबित',
    priorityHigh: 'प्राथमिकता',
    minsAgo: 'मि. पहले',
    justNow: 'अभी-अभी',
    btnAcknowledge: 'ऑर्डर स्वीकार करें',
    btnStartPreparing: 'बनाना शुरू करें',
    btnMarkReady: 'तैयार चिह्नित करें',
    btnMarkServed: 'परोसा गया चिह्नित करें',
    btnCancelKot: 'रद्द करें',
    btnPrintKot: 'प्रिंट KOT',
    btnViewDetails: 'विवरण',
    closeDetails: 'बंद करें',
    emptyTitle: 'किचन कतार खाली है',
    emptyDesc: 'नए QR ग्राहक ऑर्डर और वेटर POS ऑर्डर यहाँ अपने आप दिखाई देंगे।',
    emptyFilteredTitle: 'इस फ़िल्टर में कोई ऑर्डर नहीं',
    emptyFilteredDesc: 'अन्य किचन स्टेशन या स्टेटस टैब चुनकर देखें।',
    unacknowledgedAlert: 'नए अस्वीकृत ऑर्डर',
    qtyLabel: 'आइटम',
    notesLabel: 'ऑर्डर निर्देश',
    specialInstructions: 'विशेष निर्देश',
    itemNotesLabel: 'तैयारी नोट',
    acknowledgedBy: 'स्वीकृतकर्ता',
    cancelConfirmPrompt: 'इस KOT को रद्द करने का कारण (वैकल्पिक):',
    offlineBanner:
      'वाई-फ़ाई / API कनेक्शन टूट गया। अंतिम सिंक किए गए टिकट दिखा रहे हैं, पुनः प्रयास जारी है...',
    blockedBanner:
      'लाइव किचन स्ट्रीम रुकी हुई है क्योंकि रेस्तरां अनुमोदन या सक्रिय एक्सेस आवश्यक है।',
    backToOverview: 'डैशबोर्ड',
    timelinePlaced: 'ऑर्डर समय',
    timelineAccepted: 'स्वीकृत',
    timelinePreparing: 'तैयारी शुरू',
    timelineReady: 'तैयार हुआ',
    timelineServed: 'परोसा गया',
    subtotalLabel: 'उप-योग',
    detailsTitle: 'संपूर्ण ऑर्डर विवरण',
    accessPausedPendingTitle: 'किचन एक्सेस रुका हुआ है — अनुमोदन लंबित',
    accessPausedPendingDesc:
      'आपका रेस्तरां खाता अभी प्लेटफ़ॉर्म एडमिन की स्वीकृति की प्रतीक्षा में है। स्वीकृति मिलते ही लाइव KDS, QR ऑर्डरिंग और डाइनिंग सुविधाएँ अपने आप चालू हो जाएँगी।',
    accessPausedSuspendedTitle: 'किचन एक्सेस रुका हुआ है — खाता निलंबित',
    accessPausedSuspendedDesc:
      'यह रेस्तरां कार्यक्षेत्र वर्तमान में निलंबित है। लाइव किचन एक्सेस बहाल करने के लिए AutoNex सहायता से संपर्क करें।',
    accessPausedRoleTitle: 'किचन डिस्प्ले एक्सेस सीमित है',
    accessPausedRoleDesc:
      'आपकी वर्तमान भूमिका या आउटलेट चयन किचन डिस्प्ले की अनुमति नहीं देता। कृपया उचित आउटलेट चुनें।',
    currentStatusLabel: 'रेस्तरां स्थिति',
    subscriptionStatusLabel: 'प्लान स्थिति',
    btnCheckApproval: 'स्थिति अभी जांचें',
    checkingStatus: 'जांच हो रही है...',
    btnOpenOverview: 'डैशबोर्ड ओवरव्यू पर जाएं',
    btnOpenPlan: 'प्लान और बिलिंग देखें',
    lockBanner: 'सीमित मोड सक्रिय — मौजूदा ऑर्डर निपटाए जा सकते हैं।',
  },
  gu: {
    title: 'કિચન ડિસ્પ્લે સિસ્ટમ (KDS)',
    subtitle: 'લાઇવ KOT કતાર',
    soundOn: 'અવાજ ચાલુ',
    soundOff: 'મ્યૂટ',
    unlockAudio: 'ઘંટડી ચાલુ કરો',
    testBell: 'ટેસ્ટ ઘંટડી',
    liveWs: 'લાઇવ સ્ટ્રીમ',
    pollingFallback: 'ઓટો સિંક',
    reconnecting: 'ફરી કનેક્ટ થઈ રહ્યું છે...',
    offline: 'KDS ઓફલાઇન — ફરી કનેક્ટ થઈ રહ્યું છે',
    blocked: 'એક્સેસ અટકાવાયો છે',
    allOpen: 'બધા ચાલુ',
    statusNew: 'નવો',
    statusAcknowledged: 'સ્વીકૃત',
    statusPreparing: 'બની રહ્યું છે',
    statusReady: 'તૈયાર',
    statusServed: 'પીરસાયું',
    statusCancelled: 'રદ',
    includeServed: 'પીરસાયેલા બતાવો (45m)',
    stationAll: 'બધા સ્ટેશન',
    stationMainKitchen: 'મુખ્ય રસોડું',
    stationBar: 'બાર',
    stationBakery: 'બેકરી',
    stationDesserts: 'ડેઝર્ટ',
    kotPrefix: 'KOT',
    roundPrefix: 'રાઉન્ડ',
    tablePrefix: 'ટેબલ',
    addOn: 'એડ-ઓન',
    guestSource: 'ગ્રાહક QR',
    waiterSource: 'વેઇટર POS',
    customerLabel: 'ગ્રાહક',
    waiterLabel: 'સ્ટાફ',
    orderTimeLabel: 'સમય',
    prepTimerLabel: 'તૈયારી ટાઈમર',
    prepTimeEst: 'અંદાજ',
    delayedBadge: 'વિલંબિત',
    urgentDelayBadge: 'તાત્કાલિક વિલંબ',
    priorityHigh: 'પ્રાથમિકતા',
    minsAgo: 'મિ. પહેલાં',
    justNow: 'હમણાં જ',
    btnAcknowledge: 'ઓર્ડર સ્વીકારો',
    btnStartPreparing: 'બનાવવાનું શરૂ કરો',
    btnMarkReady: 'તૈયાર માર્ક કરો',
    btnMarkServed: 'પીરસાયું માર્ક કરો',
    btnCancelKot: 'રદ કરો',
    btnPrintKot: 'પ્રિન્ટ KOT',
    btnViewDetails: 'વિગતો',
    closeDetails: 'બંધ કરો',
    emptyTitle: 'કિચન કતાર ખાલી છે',
    emptyDesc: 'નવા QR ગ્રાહક ઓર્ડર અને વેઇટર POS ઓર્ડર અહીં આપમેળે દેખાશે.',
    emptyFilteredTitle: 'આ ફિલ્ટરમાં કોઈ ઓર્ડર નથી',
    emptyFilteredDesc: 'ઉપર અન્ય કિચન સ્ટેશન અથવા સ્ટેટસ ટેબ પસંદ કરો.',
    unacknowledgedAlert: 'નવા અસ્વીકૃત ઓર્ડર',
    qtyLabel: 'વસ્તુઓ',
    notesLabel: 'ઓર્ડર સૂચના',
    specialInstructions: 'ખાસ સૂચનાઓ',
    itemNotesLabel: 'તૈયારી નોંધ',
    acknowledgedBy: 'સ્વીકારનાર',
    cancelConfirmPrompt: 'આ KOT રદ કરવાનું કારણ (વૈકલ્પિક):',
    offlineBanner:
      'Wi-Fi / API કનેક્શન તૂટી ગયું છે. છેલ્લે સિંક થયેલ ટિકિટ બતાવી રહ્યા છીએ...',
    blockedBanner:
      'લાઇવ કિચન સ્ટ્રીમ અટકાવાયેલ છે કારણ કે રેસ્ટોરન્ટ મંજૂરી અથવા સક્રિય એક્સેસ જરૂરી છે.',
    backToOverview: 'ડેશબોર્ડ',
    timelinePlaced: 'મૂકેલ',
    timelineAccepted: 'સ્વીકારેલ',
    timelinePreparing: 'બનાવવાનું શરૂ',
    timelineReady: 'તૈયાર થયેલ',
    timelineServed: 'પીરસાયેલ',
    subtotalLabel: 'પેટા-કુલ',
    detailsTitle: 'સંપૂર્ણ ઓર્ડર વિગતો',
    accessPausedPendingTitle: 'કિચન એક્સેસ અટકાવાયો છે — મંજૂરી બાકી',
    accessPausedPendingDesc:
      'તમારું રેસ્ટોરન્ટ એકાઉન્ટ હાલમાં પ્લેટફોર્મ એડમિન મંજૂરીની રાહ જોઈ રહ્યું છે. મંજૂરી મળતાં જ લાઇવ KDS અને QR ઓર્ડરિંગ આપમેળે શરૂ થશે.',
    accessPausedSuspendedTitle: 'કિચન એક્સેસ અટકાવાયો છે — એકાઉન્ટ સસ્પેન્ડ',
    accessPausedSuspendedDesc:
      'આ રેસ્ટોરન્ટ વર્કસ્પેસ હાલમાં સસ્પેન્ડ છે. લાઇવ કિચન એક્સેસ ફરી શરૂ કરવા AutoNex સપોર્ટનો સંપર્ક કરો.',
    accessPausedRoleTitle: 'કિચન ડિસ્પ્લે એક્સેસ મર્યાદિત',
    accessPausedRoleDesc:
      'તમારી વર્તમાન ભૂમિકા અથવા આઉટલેટ પસંદગી કિચન ડિસ્પ્લેની પરવાનગી આપતી નથી.',
    currentStatusLabel: 'રેસ્ટોરન્ટ સ્થિતિ',
    subscriptionStatusLabel: 'પ્લાન સ્થિતિ',
    btnCheckApproval: 'સ્થિતિ તપાસો',
    checkingStatus: 'તપાસી રહ્યું છે...',
    btnOpenOverview: 'ડેશબોર્ડ ઓવરવ્યુ ખોલો',
    btnOpenPlan: 'પ્લાન અને બિલિંગ જુઓ',
    lockBanner: 'મર્યાદિત મોડ સક્રિય — ચાલુ ઓર્ડર સેટલ કરી શકાય છે.',
  },
};
