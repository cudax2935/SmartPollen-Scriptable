const CONFIG = {
  // Coordonnées de secours si la géolocalisation échoue
  defaultLat: 48.8566,
  defaultLon: 2.3522,
  defaultCity: "Paris",

  // Seuil pour notification d'alerte (0 = désactivé, de 1 à 10)
  alertThreshold: 5,

  // Fréquence minimale de rafraîchissement (en minutes)
  refreshMinutes: 45,

  // Nom d'un fichier d'image de fond transparent dans Documents (optionnel)
  // Si vous utilisez un script de fond transparent (ex: no-background.js)
  bgImageFileName: "pollen_bg.jpg",

  // Opacité du verre transparent (de 0.0 à 0.4 - 0.15 recommandé)
  glassOpacity: 0.14,

  // URL ouverte au tapotement sur le widget (laisser vide pour ne rien ouvrir)
  widgetTapUrl: "https://www.reseaudepollens.fr",

  // Couleurs neutres du verre pur (monochrome)
  colors: {
    white:          "#FFFFFF",
    textPrimary:    new Color("#FFFFFF", 0.95),
    textSecondary:  new Color("#FFFFFF", 0.65),
    textTertiary:   new Color("#FFFFFF", 0.40),
    glassFill:      new Color("#FFFFFF", 0.10),
    glassFillDeep:  new Color("#000000", 0.18),
    glassBorder:    new Color("#FFFFFF", 0.22),
    glassHighlight: new Color("#FFFFFF", 0.35),
    trackBg:        new Color("#FFFFFF", 0.12)
  }
}

// Chemins du cache local
const fm = FileManager.local()
const cacheDir = fm.documentsDirectory()
const cachePath      = fm.joinPath(cacheDir, "pollen_clear_cache.json")
const locCachePath   = fm.joinPath(cacheDir, "pollen_clear_loc.json")
const lastNotifPath  = fm.joinPath(cacheDir, "pollen_clear_notif.json")
const customBgPath   = fm.joinPath(cacheDir, CONFIG.bgImageFileName)

// -- ÉCHELLES DE RISQUE (ACCENTS DISCRETS UNIQUEMENT) --------------

const SEVERITY_LEVELS = [
  { min: 0,  label: "Nul",        color: "#10B981", barFill: "#34D399" },
  { min: 1,  label: "Très faible",color: "#10B981", barFill: "#34D399" },
  { min: 3,  label: "Faible",     color: "#14B8A6", barFill: "#2DD4BF" },
  { min: 5,  label: "Modéré",     color: "#F59E0B", barFill: "#FBBF24" },
  { min: 7,  label: "Élevé",      color: "#F97316", barFill: "#FB923C" },
  { min: 9,  label: "Très élevé", color: "#EF4444", barFill: "#F87171" },
  { min: 10, label: "Extrême",    color: "#A855F7", barFill: "#C084FC" }
]

function getSeverity(score) {
  let matched = SEVERITY_LEVELS[0]
  for (const lvl of SEVERITY_LEVELS) {
    if (score >= lvl.min) matched = lvl
  }
  return matched
}

// Seuils scientifiques réalistes
function scoreGrass(val) {
  if (val <= 0)  return 0
  if (val <= 3)  return 2
  if (val <= 8)  return 4
  if (val <= 18) return 6
  if (val <= 35) return 8
  return 10
}

function scoreTree(val) {
  if (val <= 0)   return 0
  if (val <= 10)  return 2
  if (val <= 30)  return 4
  if (val <= 80)  return 6
  if (val <= 160) return 8
  return 10
}

function scoreWeed(val) {
  if (val <= 0)  return 0
  if (val <= 3)  return 2
  if (val <= 7)  return 4
  if (val <= 15) return 6
  if (val <= 30) return 8
  return 10
}

function computeCompositeScore(grass, tree, weed) {
  const sg = scoreGrass(grass)
  const st = scoreTree(tree)
  const sw = scoreWeed(weed)
  const maxScore = Math.max(sg, st, sw)
  const activeCount = [sg, st, sw].filter(s => s >= 4).length
  return Math.min(10, maxScore + (activeCount >= 2 ? 1 : 0))
}

// -- GÉOLOCALISATION & CACHE ---------------------------------------

async function fetchLocation() {
  const result = {
    lat: CONFIG.defaultLat,
    lon: CONFIG.defaultLon,
    city: CONFIG.defaultCity,
    isFallback: false
  }

  try {
    Location.setAccuracyToThreeKilometers()
    const loc = await Location.current()
    result.lat = loc.latitude
    result.lon = loc.longitude

    try {
      const geo = await Location.reverseGeocode(loc.latitude, loc.longitude)
      if (geo && geo.length > 0) {
        result.city = geo[0].locality || geo[0].postalAddress?.city || geo[0].subAdministrativeArea || "Position actuelle"
      }
    } catch (_) {
      result.city = "Position actuelle"
    }

    fm.writeString(locCachePath, JSON.stringify(result))
  } catch (err) {
    if (fm.fileExists(locCachePath)) {
      try {
        const cached = JSON.parse(fm.readString(locCachePath))
        result.lat = cached.lat
        result.lon = cached.lon
        result.city = cached.city
        result.isFallback = true
      } catch (_) {}
    }
  }

  return result
}

// -- REQUÊTE API OPEN-METEO -----------------------------------------

async function fetchPollenData(location) {
  const hourlyVars = [
    "alder_pollen",
    "birch_pollen",
    "grass_pollen",
    "mugwort_pollen",
    "olive_pollen",
    "ragweed_pollen"
  ].join(",")

  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${location.lat}&longitude=${location.lon}&hourly=${hourlyVars}&timezone=auto&forecast_days=6`

  try {
    const req = new Request(url)
    req.timeoutInterval = 7
    const data = await req.loadJSON()

    if (data && !data.error && data.hourly) {
      const payload = {
        data: data,
        fetchedAt: Date.now(),
        location: location
      }
      fm.writeString(cachePath, JSON.stringify(payload))
      return { ...payload, isCached: false }
    }
  } catch (err) {
    console.log("Erreur réseau : " + err)
  }

  if (fm.fileExists(cachePath)) {
    try {
      const cached = JSON.parse(fm.readString(cachePath))
      return { ...cached, isCached: true }
    } catch (_) {}
  }

  throw new Error("Connexion impossible et aucun cache disponible.")
}

// -- EXTRACTION & ANALYSES HORAIRES ET JOURNALIÈRES -----------------

function pad(n) { return String(n).padStart(2, "0") }

function analyzePollen(data) {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const currentIsoHour = `${todayStr}T${pad(now.getHours())}:00`

  const times = data.hourly?.time ?? []
  let currentIdx = times.indexOf(currentIsoHour)
  if (currentIdx < 0) currentIdx = times.findIndex(t => t.startsWith(todayStr))
  if (currentIdx < 0) currentIdx = 0

  const h = data.hourly
  const getGrass = i => Math.round(h?.grass_pollen?.[i] ?? 0)
  const getTree  = i => Math.round((h?.alder_pollen?.[i] ?? 0) + (h?.birch_pollen?.[i] ?? 0) + (h?.olive_pollen?.[i] ?? 0))
  const getWeed  = i => Math.round((h?.mugwort_pollen?.[i] ?? 0) + (h?.ragweed_pollen?.[i] ?? 0))

  // 1. Données actuelles
  const current = {
    grass: getGrass(currentIdx),
    tree:  getTree(currentIdx),
    weed:  getWeed(currentIdx)
  }
  current.total = current.grass + current.tree + current.weed
  current.score = computeCompositeScore(current.grass, current.tree, current.weed)

  // 2. Pic horaire de la journée
  let peakHour = 14
  let peakScore = current.score
  let nextScore = current.score

  times.forEach((t, i) => {
    if (t.startsWith(todayStr)) {
      const g = getGrass(i), tr = getTree(i), w = getWeed(i)
      const sc = computeCompositeScore(g, tr, w)
      if (sc > peakScore) {
        peakScore = sc
        peakHour = parseInt(t.split("T")[1].split(":")[0], 10)
      }
    }
  })

  // Tendance sur les prochaines 3-4h
  const futureIdx = Math.min(times.length - 1, currentIdx + 4)
  if (futureIdx > currentIdx) {
    const fg = getGrass(futureIdx), ftr = getTree(futureIdx), fw = getWeed(futureIdx)
    nextScore = computeCompositeScore(fg, ftr, fw)
  }

  let trend = "stable"
  let trendIcon = "arrow.right"
  let trendLabel = "Stable"
  if (nextScore > current.score) {
    trend = "rising"
    trendIcon = "arrow.up.right"
    trendLabel = "En hausse"
  } else if (nextScore < current.score) {
    trend = "falling"
    trendIcon = "arrow.down.right"
    trendLabel = "En baisse"
  }

  // 3. Prévisions 5 jours
  const dailyMap = {}
  times.forEach((timeStr, i) => {
    const dStr = timeStr.split("T")[0]
    if (!dailyMap[dStr]) dailyMap[dStr] = { maxScore: 0, grass: 0, tree: 0, weed: 0 }
    const g = getGrass(i), tr = getTree(i), w = getWeed(i)
    const sc = computeCompositeScore(g, tr, w)
    if (sc > dailyMap[dStr].maxScore) {
      dailyMap[dStr].maxScore = sc
      dailyMap[dStr].grass = g
      dailyMap[dStr].tree = tr
      dailyMap[dStr].weed = w
    }
  })

  const forecast = Object.keys(dailyMap).sort().slice(0, 5).map(dStr => ({
    date: new Date(dStr + "T12:00:00"),
    score: dailyMap[dStr].maxScore,
    severity: getSeverity(dailyMap[dStr].maxScore)
  }))

  // 4. Détails des 3 familles
  const breakdown = [
    { name: "Graminées", key: "grass", val: current.grass, score: scoreGrass(current.grass), icon: "leaf.fill" },
    { name: "Arbres",    key: "tree",  val: current.tree,  score: scoreTree(current.tree),   icon: "tree.fill" },
    { name: "Herbacés",  key: "weed",  val: current.weed,  score: scoreWeed(current.weed),   icon: "camera.macro" }
  ].sort((a, b) => b.score - a.score || b.val - a.val)

  const dominant = breakdown[0]
  let advice = "Conditions favorables."
  if (current.score >= 1) {
    if (dominant.key === "grass") {
      advice = current.score >= 7 ? "Graminées très actives. Évitez les parcs." : "Sensibilité accrue en extérieur."
    } else if (dominant.key === "tree") {
      advice = current.score >= 7 ? "Forte dispersion d'arbres. Rincez vos cheveux." : "Attention près des zones boisées."
    } else {
      advice = current.score >= 7 ? "Herbacés en pic. Gardez les fenêtres fermées." : "Présence d'herbacés dans l'air."
    }
  }

  return {
    current,
    dominant,
    breakdown,
    peakHour,
    peakScore,
    trend,
    trendIcon,
    trendLabel,
    forecast,
    advice
  }
}

// -- RENDU VISUEL : VERRE TRANSPARENT ÉPURÉ (CLEAR GLASS) -----------

/**
 * Configure l'arrière-plan du widget de manière transparente / translucide neutre.
 * Sans aucune aura colorée.
 */
function applyClearGlassBackground(widget) {
  if (fm.fileExists(customBgPath)) {
    // Si l'utilisateur a configuré une image de fond transparent (ex: slice de wallpaper)
    widget.backgroundImage = fm.readImage(customBgPath)
  } else {
    // Verre fumé translucide neutre universel (s'intègre sur n'importe quel fond d'écran)
    const gradient = new LinearGradient()
    gradient.locations = [0.0, 1.0]
    gradient.colors = [
      new Color("#12141A", 0.40),
      new Color("#080A0E", 0.55)
    ]
    widget.backgroundGradient = gradient
  }
}

/**
 * Boîte en verre translucide neutre (Glass Card)
 */
function addGlassCard(parent, padding = [10, 12, 10, 12], isDeep = false) {
  const stack = parent.addStack()
  stack.backgroundColor = isDeep ? CONFIG.colors.glassFillDeep : CONFIG.colors.glassFill
  stack.cornerRadius    = 16
  stack.borderColor     = CONFIG.colors.glassBorder
  stack.borderWidth     = 0.6
  stack.setPadding(padding[0], padding[1], padding[2], padding[3])
  return stack
}

/**
 * Pastille en verre translucide neutre
 */
function addGlassPill(parent, text, icon = null, fontStyle = Font.boldSystemFont(10), textColor = null) {
  const pill = parent.addStack()
  pill.centerAlignContent()
  pill.backgroundColor = new Color("#FFFFFF", 0.08)
  pill.cornerRadius    = 10
  pill.borderColor     = new Color("#FFFFFF", 0.18)
  pill.borderWidth     = 0.5
  pill.setPadding(3, 7, 3, 7)

  if (icon) {
    const sym = SFSymbol.named(icon)
    sym.applyFont(Font.systemFont(9))
    const img = pill.addImage(sym.image)
    img.imageSize = new Size(10, 10)
    img.tintColor = textColor ?? CONFIG.colors.textPrimary
    pill.addSpacer(4)
  }

  const t = pill.addText(text)
  t.font = fontStyle
  t.textColor = textColor ?? CONFIG.colors.textPrimary
  return pill
}

/**
 * Jauge capsule fine et épurée (sans reflet agressif, discret et élégant)
 */
function createMinimalProgressBar(score, max = 10, width = 85, height = 5, colorHex = "#34D399") {
  const dc = new DrawContext()
  dc.size = new Size(width, height)
  dc.respectScreenScale = true
  dc.opaque = false

  const cornerRadius = height / 2

  // Piste translucide
  const trackPath = new Path()
  trackPath.addRoundedRect(new Rect(0, 0, width, height), cornerRadius, cornerRadius)
  dc.addPath(trackPath)
  dc.setFillColor(CONFIG.colors.trackBg)
  dc.fillPath()

  // Remplissage discret
  const ratio = Math.max(0.06, Math.min(1.0, score / max))
  const fillWidth = Math.max(height, width * ratio)

  const fillPath = new Path()
  fillPath.addRoundedRect(new Rect(0, 0, fillWidth, height), cornerRadius, cornerRadius)
  dc.addPath(fillPath)
  dc.setFillColor(new Color(colorHex, 0.95))
  dc.fillPath()

  // Bordure ultra-fine
  dc.addPath(trackPath)
  dc.setStrokeColor(new Color("#FFFFFF", 0.20))
  dc.setLineWidth(0.5)
  dc.strokePath()

  return dc.getImage()
}

// Typographie & Helpers
function addText(container, text, font, color = null, lineLimit = 0) {
  const t = container.addText(text)
  t.font = font
  t.textColor = color ?? CONFIG.colors.textPrimary
  t.shadowColor = new Color("#000000", 0.5)
  t.shadowRadius = 2
  t.shadowOffset = new Point(0, 1)
  if (lineLimit > 0) t.lineLimit = lineLimit
  return t
}

function addSymbol(container, name, size, color = null, weight = "regular") {
  const sym = SFSymbol.named(name)
  const fn = weight === "bold" ? Font.boldSystemFont(size) : Font.systemFont(size)
  sym.applyFont(fn)
  const img = container.addImage(sym.image)
  img.imageSize = new Size(size, size)
  img.tintColor = color ?? CONFIG.colors.textPrimary
  return img
}

function formatRelativeTime(timestamp) {
  const diffSec = Math.round((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return "À l'instant"
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min`
  const d = new Date(timestamp)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dayName(date, index) {
  if (index === 0) return "Auj."
  if (index === 1) return "Dem."
  const names = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"]
  return names[date.getDay()]
}

// -- CONSTRUCTEURS DE WIDGETS ---------------------------------------

/**
 * 📱 WIDGET PETIT (Small Widget)
 * Ultra-épuré, verre transparent avec score, tendance et pic.
 */
function buildSmallWidget(w, analysis, location, isCached, fetchedAt) {
  applyClearGlassBackground(w)
  w.setPadding(13, 14, 13, 14)

  const sev = getSeverity(analysis.current.score)

  // Header : Ville & Status réseau
  const header = w.addStack()
  header.centerAlignContent()
  addSymbol(header, "location.fill", 11, CONFIG.colors.textSecondary, "bold")
  header.addSpacer(4)
  addText(header, location.city, Font.boldSystemFont(12), CONFIG.colors.textPrimary, 1)
  header.addSpacer()

  if (isCached) {
    addSymbol(header, "wifi.slash", 10, new Color("#FBBF24", 0.8))
  } else {
    const dot = header.addStack()
    dot.size = new Size(5, 5)
    dot.cornerRadius = 2.5
    dot.backgroundColor = new Color("#34D399", 0.8)
  }

  w.addSpacer(6)

  // Carte centrale : Score principal
  const scoreCard = addGlassCard(w, [8, 10, 8, 10])
  scoreCard.layoutVertically()

  const scoreRow = scoreCard.addStack()
  scoreRow.bottomAlignContent()
  addText(scoreRow, String(analysis.current.score), Font.heavySystemFont(38), CONFIG.colors.textPrimary)
  scoreRow.addSpacer(3)
  addText(scoreRow, "/10", Font.boldSystemFont(14), CONFIG.colors.textSecondary)
  scoreRow.addSpacer()

  // Pastille de tendance discrète
  addGlassPill(scoreRow, analysis.trendLabel, analysis.trendIcon, Font.boldSystemFont(9), CONFIG.colors.textSecondary)

  scoreCard.addSpacer(4)

  // Niveau avec simple point de repère couleur
  const badgeRow = scoreCard.addStack()
  badgeRow.centerAlignContent()
  const dotIndicator = badgeRow.addStack()
  dotIndicator.size = new Size(6, 6)
  dotIndicator.cornerRadius = 3
  dotIndicator.backgroundColor = new Color(sev.color)
  badgeRow.addSpacer(5)
  addText(badgeRow, sev.label.toUpperCase(), Font.heavySystemFont(10), CONFIG.colors.textSecondary)

  w.addSpacer(6)

  // Carte inférieure : Dominant et Pic
  const bottomCard = addGlassCard(w, [6, 8, 6, 8], true)
  bottomCard.layoutVertically()

  const domRow = bottomCard.addStack()
  domRow.centerAlignContent()
  addSymbol(domRow, analysis.dominant.icon, 10, CONFIG.colors.textSecondary)
  domRow.addSpacer(4)
  addText(domRow, analysis.dominant.name, Font.boldSystemFont(10), CONFIG.colors.textPrimary)
  domRow.addSpacer()
  addText(domRow, `${analysis.dominant.val} gr.`, Font.semiboldSystemFont(10), CONFIG.colors.textSecondary)

  bottomCard.addSpacer(2)

  const peakRow = bottomCard.addStack()
  peakRow.centerAlignContent()
  addSymbol(peakRow, "clock", 9, CONFIG.colors.textTertiary)
  peakRow.addSpacer(4)
  addText(peakRow, `Pic à ${analysis.peakHour}h (${analysis.peakScore}/10)`, Font.mediumSystemFont(9), CONFIG.colors.textSecondary)
}

/**
 * 📱 WIDGET MOYEN (Medium Widget)
 * L'équilibre parfait : Colonne de score sobre + jauges fines translucides.
 */
function buildMediumWidget(w, analysis, location, isCached, fetchedAt) {
  applyClearGlassBackground(w)
  w.setPadding(13, 15, 13, 15)

  const sev = getSeverity(analysis.current.score)

  // En-tête : Localisation, Pic et Synchro
  const header = w.addStack()
  header.centerAlignContent()

  addSymbol(header, "location.fill", 11, CONFIG.colors.textSecondary, "bold")
  header.addSpacer(5)
  addText(header, location.city, Font.boldSystemFont(13), CONFIG.colors.textPrimary, 1)
  header.addSpacer(8)

  // Badge pic sobre
  addGlassPill(header, `Pic ${analysis.peakHour}h (${analysis.peakScore}/10)`, "clock", Font.boldSystemFont(9), CONFIG.colors.textSecondary)

  header.addSpacer()

  // Heure synchro
  const timeText = isCached ? "Cache" : formatRelativeTime(fetchedAt)
  addGlassPill(header, timeText, isCached ? "wifi.slash" : "arrow.clockwise", Font.mediumSystemFont(9), CONFIG.colors.textTertiary)

  w.addSpacer(9)

  // Corps divisé en 2 colonnes
  const body = w.addStack()
  body.layoutHorizontally()
  body.centerAlignContent()

  // COLONNE GAUCHE (Verre transparent) : Score + Sévérité + Tendance
  const leftCard = addGlassCard(body, [10, 12, 10, 12])
  leftCard.layoutVertically()
  leftCard.size = new Size(125, 0)

  const scoreRow = leftCard.addStack()
  scoreRow.bottomAlignContent()
  addText(scoreRow, String(analysis.current.score), Font.heavySystemFont(44), CONFIG.colors.textPrimary)
  scoreRow.addSpacer(3)
  addText(scoreRow, "/10", Font.boldSystemFont(15), CONFIG.colors.textSecondary)

  leftCard.addSpacer(2)

  const sevBadge = leftCard.addStack()
  sevBadge.centerAlignContent()
  const glowDot = sevBadge.addStack()
  glowDot.size = new Size(7, 7)
  glowDot.cornerRadius = 3.5
  glowDot.backgroundColor = new Color(sev.color)
  sevBadge.addSpacer(5)
  addText(sevBadge, sev.label, Font.boldSystemFont(13), CONFIG.colors.textPrimary)

  leftCard.addSpacer(3)

  const trRow = leftCard.addStack()
  trRow.centerAlignContent()
  addSymbol(trRow, analysis.trendIcon, 9, CONFIG.colors.textSecondary)
  trRow.addSpacer(4)
  addText(trRow, analysis.trendLabel, Font.mediumSystemFont(10), CONFIG.colors.textSecondary)

  body.addSpacer(9)

  // COLONNE DROITE : Les 3 jauges translucides
  const rightCard = addGlassCard(body, [9, 12, 9, 12])
  rightCard.layoutVertically()

  analysis.breakdown.forEach((item, idx) => {
    if (idx > 0) rightCard.addSpacer(7)

    const row = rightCard.addStack()
    row.centerAlignContent()

    addSymbol(row, item.icon, 11, CONFIG.colors.textSecondary)
    row.addSpacer(6)
    const nameTxt = addText(row, item.name, Font.boldSystemFont(11), CONFIG.colors.textPrimary)
    nameTxt.size = new Size(72, 0)

    row.addSpacer()

    // Jauge fine épurée
    const itemSev = getSeverity(item.score)
    const progressBar = createMinimalProgressBar(item.score, 10, 88, 5, itemSev.barFill)
    const pImg = row.addImage(progressBar)
    pImg.imageSize = new Size(88, 5)

    row.addSpacer(8)

    const valStack = row.addStack()
    valStack.size = new Size(36, 0)
    valStack.addSpacer()
    addText(valStack, `${item.val}`, Font.heavySystemFont(12), CONFIG.colors.textPrimary)
  })

  // Conseil discret en pied
  w.addSpacer(7)
  const footer = w.addStack()
  footer.centerAlignContent()
  addSymbol(footer, "info.circle", 9, CONFIG.colors.textTertiary)
  footer.addSpacer(5)
  addText(footer, analysis.advice, Font.mediumSystemFont(9), CONFIG.colors.textSecondary, 1)
}

/**
 * 📱 WIDGET GRAND (Large Widget)
 * Verre transparent pur avec métriques, jauges et prévisions 5 jours.
 */
function buildLargeWidget(w, analysis, location, isCached, fetchedAt) {
  applyClearGlassBackground(w)
  w.setPadding(16, 16, 16, 16)

  const sev = getSeverity(analysis.current.score)

  // 1. Header principal
  const header = w.addStack()
  header.centerAlignContent()

  addSymbol(header, "aqi.medium", 16, CONFIG.colors.textSecondary, "bold")
  header.addSpacer(7)
  addText(header, "Index Pollen", Font.heavySystemFont(17), CONFIG.colors.textPrimary)

  header.addSpacer()

  addGlassPill(header, location.city, "location.fill", Font.boldSystemFont(11), CONFIG.colors.textPrimary)
  header.addSpacer(6)

  const syncTxt = isCached ? "Hors-ligne" : formatRelativeTime(fetchedAt)
  addGlassPill(header, syncTxt, isCached ? "wifi.slash" : "arrow.clockwise", Font.mediumSystemFont(10), CONFIG.colors.textTertiary)

  w.addSpacer(12)

  // 2. Carte Maîtresse en verre
  const masterCard = addGlassCard(w, [14, 16, 14, 16])
  masterCard.layoutHorizontally()
  masterCard.centerAlignContent()

  const mLeft = masterCard.addStack()
  mLeft.layoutVertically()

  const scoreRow = mLeft.addStack()
  scoreRow.bottomAlignContent()
  addText(scoreRow, String(analysis.current.score), Font.heavySystemFont(54), CONFIG.colors.textPrimary)
  scoreRow.addSpacer(4)
  addText(scoreRow, "/10", Font.boldSystemFont(18), CONFIG.colors.textSecondary)

  mLeft.addSpacer(2)

  const sevRow = mLeft.addStack()
  sevRow.centerAlignContent()
  const dot = sevRow.addStack()
  dot.size = new Size(8, 8)
  dot.cornerRadius = 4
  dot.backgroundColor = new Color(sev.color)
  sevRow.addSpacer(6)
  addText(sevRow, sev.label.toUpperCase(), Font.heavySystemFont(13), CONFIG.colors.textPrimary)

  masterCard.addSpacer()

  // Droite : Pic & Tendance
  const mRight = masterCard.addStack()
  mRight.layoutVertically()

  const peakBox = addGlassCard(mRight, [6, 10, 6, 10], true)
  peakBox.centerAlignContent()
  addSymbol(peakBox, "clock", 11, CONFIG.colors.textSecondary)
  peakBox.addSpacer(5)
  addText(peakBox, `Pic à ${analysis.peakHour}h (${analysis.peakScore}/10)`, Font.boldSystemFont(11), CONFIG.colors.textPrimary)

  mRight.addSpacer(6)

  const trendBox = addGlassCard(mRight, [6, 10, 6, 10], true)
  trendBox.centerAlignContent()
  addSymbol(trendBox, analysis.trendIcon, 11, CONFIG.colors.textSecondary)
  trendBox.addSpacer(5)
  addText(trendBox, `Tendance ${analysis.trendLabel.toLowerCase()}`, Font.mediumSystemFont(11), CONFIG.colors.textSecondary)

  w.addSpacer(12)

  // 3. Section DÉTAIL DES ALLERGÈNES
  const secTitle1 = w.addStack()
  secTitle1.centerAlignContent()
  addText(secTitle1, "CONCENTRATION DES ALLERGÈNES", Font.heavySystemFont(10), CONFIG.colors.textTertiary)
  w.addSpacer(6)

  const gaugeCard = addGlassCard(w, [12, 14, 12, 14])
  gaugeCard.layoutVertically()

  analysis.breakdown.forEach((item, idx) => {
    if (idx > 0) gaugeCard.addSpacer(8)

    const r = gaugeCard.addStack()
    r.centerAlignContent()

    addSymbol(r, item.icon, 13, CONFIG.colors.textSecondary)
    r.addSpacer(8)
    const lbl = addText(r, item.name, Font.boldSystemFont(13), CONFIG.colors.textPrimary)
    lbl.size = new Size(85, 0)

    r.addSpacer()

    const iSev = getSeverity(item.score)
    const bar = createMinimalProgressBar(item.score, 10, 115, 6, iSev.barFill)
    const bImg = r.addImage(bar)
    bImg.imageSize = new Size(115, 6)

    r.addSpacer(10)

    const valBox = r.addStack()
    valBox.size = new Size(48, 0)
    valBox.addSpacer()
    addText(valBox, `${item.val} gr.`, Font.heavySystemFont(13), CONFIG.colors.textPrimary)
  })

  w.addSpacer(12)

  // 4. Section PRÉVISIONS 5 JOURS
  const secTitle2 = w.addStack()
  secTitle2.centerAlignContent()
  addText(secTitle2, "PRÉVISIONS 5 JOURS", Font.heavySystemFont(10), CONFIG.colors.textTertiary)
  w.addSpacer(6)

  const forecastRow = w.addStack()
  forecastRow.layoutHorizontally()

  analysis.forecast.forEach((day, idx) => {
    if (idx > 0) forecastRow.addSpacer(6)

    const isToday = idx === 0
    const dayCard = addGlassCard(forecastRow, [8, 6, 8, 6], !isToday)
    dayCard.layoutVertically()
    dayCard.centerAlignContent()

    addText(dayCard, dayName(day.date, idx), Font.boldSystemFont(11), isToday ? CONFIG.colors.textPrimary : CONFIG.colors.textSecondary)
    dayCard.addSpacer(6)

    const dayPill = dayCard.addStack()
    dayPill.size = new Size(24, 24)
    dayPill.cornerRadius = 12
    dayPill.centerAlignContent()
    dayPill.backgroundColor = new Color("#FFFFFF", 0.08)
    dayPill.borderColor     = new Color(day.severity.color, 0.7)
    dayPill.borderWidth     = 1

    const pTxt = dayPill.addText(String(day.score))
    pTxt.font = Font.heavySystemFont(12)
    pTxt.textColor = CONFIG.colors.textPrimary

    dayCard.addSpacer(6)
    addText(dayCard, day.severity.label.substring(0, 4), Font.mediumSystemFont(9), CONFIG.colors.textTertiary)
  })

  w.addSpacer(10)

  // Conseil discret
  const advBox = addGlassCard(w, [6, 10, 6, 10], true)
  advBox.centerAlignContent()
  addSymbol(advBox, "info.circle", 11, CONFIG.colors.textTertiary)
  advBox.addSpacer(6)
  addText(advBox, analysis.advice, Font.mediumSystemFont(10), CONFIG.colors.textSecondary, 1)
}

/**
 * ⌚ SUPPORT ÉCRAN DE VERROUILLAGE (iOS 16+ Lock Screen)
 */
function buildLockScreenWidget(w, family, analysis, location) {
  const sev = getSeverity(analysis.current.score)

  if (family === "accessoryCircular") {
    w.setPadding(0, 0, 0, 0)
    const stack = w.addStack()
    stack.layoutVertically()
    stack.centerAlignContent()

    addSymbol(stack, "leaf.fill", 11)
    stack.addSpacer(1)
    addText(stack, `${analysis.current.score}`, Font.heavySystemFont(18))
    return
  }

  if (family === "accessoryInline") {
    addText(w, `Pollen : ${analysis.current.score}/10 (${sev.label}) • Pic ${analysis.peakHour}h`)
    return
  }

  // accessoryRectangular
  w.setPadding(4, 4, 4, 4)
  const header = w.addStack()
  header.centerAlignContent()
  addSymbol(header, "leaf.fill", 10)
  header.addSpacer(4)
  addText(header, `Pollen • ${location.city}`, Font.boldSystemFont(11), null, 1)

  w.addSpacer(2)

  const valRow = w.addStack()
  valRow.bottomAlignContent()
  addText(valRow, `${analysis.current.score}/10`, Font.heavySystemFont(16))
  valRow.addSpacer(4)
  addText(valRow, `(${sev.label})`, Font.mediumSystemFont(12))

  w.addSpacer(2)
  addText(w, `Pic à ${analysis.peakHour}h • ${analysis.dominant.name} : ${analysis.dominant.val}`, Font.systemFont(10), null, 1)
}

// -- NOTIFICATIONS --------------------------------------------------

async function checkAndTriggerNotification(score, label, cityName) {
  if (CONFIG.alertThreshold <= 0 || score < CONFIG.alertThreshold) return

  const today = new Date().toISOString().split("T")[0]
  if (fm.fileExists(lastNotifPath)) {
    try {
      const last = JSON.parse(fm.readString(lastNotifPath))
      if (last.date === today && last.score === score) return
    } catch (_) {}
  }

  const n = new Notification()
  n.title = `Alerte Pollen — ${cityName}`
  n.body  = `Risque ${label} (Indice ${score}/10). Pensez à vos traitements ou précautions.`
  n.sound = "default"
  await n.schedule()

  fm.writeString(lastNotifPath, JSON.stringify({ date: today, score: score, time: Date.now() }))
}

// -- SUPPORT & FORMATAGE APPLE WATCH (watchOS & SIRI) ----------------

/**
 * Génère un rapport textuel optimisé pour l'écran de l'Apple Watch (lisible sans défilement excessif).
 */
function formatAppleWatchText(analysis, location) {
  const sev = getSeverity(analysis.current.score)
  const treeVal  = analysis.breakdown.find(b => b.key === "tree")?.val ?? 0
  const grassVal = analysis.breakdown.find(b => b.key === "grass")?.val ?? 0
  const weedVal  = analysis.breakdown.find(b => b.key === "weed")?.val ?? 0

  return [
    `${location.city} • ${analysis.current.score}/10 (${sev.label})`,
    `Pic à ${analysis.peakHour}h (${analysis.peakScore}/10) • ${analysis.trendLabel}`,
    `─────────────`,
    `Arbres : ${treeVal} gr/m³`,
    `Graminées : ${grassVal} gr/m³`,
    `Herbacés : ${weedVal} gr/m³`,
    `─────────────`,
    analysis.advice
  ].join("\n")
}

/**
 * Phrase vocale naturelle pour Siri sur Apple Watch
 */
function formatSiriSpokenText(analysis, location) {
  const sev = getSeverity(analysis.current.score)
  return `À ${location.city}, l'indice pollen est de ${analysis.current.score} sur 10, niveau ${sev.label}. Le pic est prévu à ${analysis.peakHour} heures.`
}

/**
 * Génère une image carte au format écran Apple Watch (OLED noir absolu + verre translucide)
 */
function createAppleWatchImageCard(analysis, location) {
  const dc = new DrawContext()
  const w = 340, h = 340
  dc.size = new Size(w, h)
  dc.respectScreenScale = true
  dc.opaque = true

  // Fond noir absolu optimisé écran OLED Apple Watch
  dc.setFillColor(new Color("#000000"))
  dc.fill(new Rect(0, 0, w, h))

  const sev = getSeverity(analysis.current.score)

  // Carte en verre translucide
  const cardPath = new Path()
  cardPath.addRoundedRect(new Rect(10, 10, w - 20, h - 20), 22, 22)
  dc.addPath(cardPath)
  dc.setFillColor(new Color("#FFFFFF", 0.10))
  dc.fillPath()
  dc.setStrokeColor(new Color("#FFFFFF", 0.22))
  dc.setLineWidth(1)
  dc.strokePath()

  // Header : Ville
  dc.setTextColor(new Color("#FFFFFF", 0.85))
  dc.setFont(Font.boldSystemFont(17))
  dc.drawText(location.city, new Point(24, 22))

  // Grand Score
  dc.setTextColor(new Color(sev.color))
  dc.setFont(Font.heavySystemFont(52))
  dc.drawText(String(analysis.current.score), new Point(24, 46))

  dc.setTextColor(new Color("#FFFFFF", 0.50))
  dc.setFont(Font.boldSystemFont(20))
  dc.drawText("/10", new Point(88, 72))

  // Label Sévérité + Pic
  dc.setTextColor(new Color("#FFFFFF", 0.95))
  dc.setFont(Font.boldSystemFont(18))
  dc.drawText(sev.label, new Point(140, 52))

  dc.setTextColor(new Color("#FFFFFF", 0.65))
  dc.setFont(Font.systemFont(14))
  dc.drawText(`Pic à ${analysis.peakHour}h • ${analysis.trendLabel}`, new Point(140, 78))

  // Ligne de séparation
  const sep = new Path()
  sep.move(new Point(24, 120))
  sep.addLine(new Point(w - 24, 120))
  dc.addPath(sep)
  dc.setStrokeColor(new Color("#FFFFFF", 0.15))
  dc.setLineWidth(1)
  dc.strokePath()

  // 3 Jauges
  let y = 135
  analysis.breakdown.forEach(item => {
    dc.setTextColor(new Color("#FFFFFF", 0.90))
    dc.setFont(Font.boldSystemFont(14))
    dc.drawText(item.name, new Point(24, y))

    // Track
    const track = new Path()
    track.addRoundedRect(new Rect(125, y + 4, 120, 7), 3.5, 3.5)
    dc.addPath(track)
    dc.setFillColor(new Color("#FFFFFF", 0.15))
    dc.fillPath()

    // Fill
    const itemSev = getSeverity(item.score)
    const ratio = Math.max(0.08, Math.min(1.0, item.score / 10))
    const fill = new Path()
    fill.addRoundedRect(new Rect(125, y + 4, 120 * ratio, 7), 3.5, 3.5)
    dc.addPath(fill)
    dc.setFillColor(new Color(itemSev.barFill))
    dc.fillPath()

    // Chiffre
    dc.setTextColor(new Color("#FFFFFF", 0.85))
    dc.setFont(Font.heavySystemFont(14))
    dc.drawText(`${item.val}`, new Point(260, y))

    y += 32
  })

  // Conseil bas
  dc.setTextColor(new Color("#FFFFFF", 0.60))
  dc.setFont(Font.systemFont(12))
  dc.drawText(analysis.advice, new Point(24, 280))

  return dc.getImage()
}

// -- MENU DE PRÉVISUALISATION SCRIPTABLE (IPHONE UNIQUEMENT) -------

async function presentPreviewChooser() {
  const alert = new Alert()
  alert.title = "Clear Glass Pollen"
  alert.message = "Choisissez une taille de widget à prévisualiser :"
  alert.addAction("Widget Petit (Small)")
  alert.addAction("Widget Moyen (Medium)")
  alert.addAction("Widget Grand (Large)")
  alert.addAction("Écran Verrouillé (Rectangulaire)")
  alert.addAction("Vider le cache et rafraîchir")
  alert.addCancelAction("Fermer")

  return await alert.presentSheet()
}

// -- POINT D'ENTRÉE PRINCIPAL (MAIN) --------------------------------

async function main() {
  const widget = new ListWidget()
  widget.refreshAfterDate = new Date(Date.now() + CONFIG.refreshMinutes * 60 * 1000)

  if (CONFIG.widgetTapUrl) {
    widget.url = CONFIG.widgetTapUrl
  }

  // Détection précise du contexte d'exécution
  const isWidgetContext = config.runsInWidget || config.runsInAccessoryWidget
  const isSiriOrShortcut = config.runsWithSiri || (!config.runsInApp && !isWidgetContext)
  const isInteractiveApp = config.runsInApp && !config.runsWithSiri

  let selectedFamily = config.widgetFamily

  // Affichage du menu UNIQUEMENT si lancé manuellement dans l'app Scriptable sur iPhone
  if (isInteractiveApp) {
    await Notification.removeAllPending()
    const choice = await presentPreviewChooser()

    if (choice === 0) selectedFamily = "small"
    else if (choice === 1) selectedFamily = "medium"
    else if (choice === 2) selectedFamily = "large"
    else if (choice === 3) selectedFamily = "accessoryRectangular"
    else if (choice === 4) {
      if (fm.fileExists(cachePath)) fm.remove(cachePath)
      if (fm.fileExists(locCachePath)) fm.remove(locCachePath)
      selectedFamily = "medium"
    } else {
      return
    }
  }

  try {
    // 1. Récupération géolocalisation
    const location = await fetchLocation()

    // 2. Récupération des données Open-Meteo
    const { data, isCached, fetchedAt } = await fetchPollenData(location)

    // 3. Analyse approfondie des pollens
    const analysis = analyzePollen(data)
    const sev = getSeverity(analysis.current.score)

    // 4. Notification si seuil dépassé
    await checkAndTriggerNotification(analysis.current.score, sev.label, location.city)

    // 5. SORTIE APPLE WATCH / RACCOURCIS / SIRI
    const watchText = formatAppleWatchText(analysis, location)
    const siriSpeech = formatSiriSpokenText(analysis, location)

    // Données structurées prêtes pour complications Raccourcis
    const watchData = {
      city: location.city,
      score: analysis.current.score,
      label: sev.label,
      peakHour: analysis.peakHour,
      peakScore: analysis.peakScore,
      trend: analysis.trendLabel,
      dominant: analysis.dominant.name,
      dominantVal: analysis.dominant.val,
      advice: analysis.advice,
      summary: watchText,
      spoken: siriSpeech,
      timestamp: Date.now()
    }

    // Gestion du paramètre Raccourcis éventuel (ex: "json", "image", "voice")
    const param = (args.shortcutParameter || "").toLowerCase()
    if (param === "json" || param === "dict") {
      Script.setShortcutOutput(watchData)
    } else if (param === "image" || param === "card") {
      const img = createAppleWatchImageCard(analysis, location)
      Script.setShortcutOutput(img)
    } else if (param === "voice" || param === "speak") {
      Script.setShortcutOutput(siriSpeech)
    } else {
      // Sortie standard texte pour Apple Watch et Siri
      Script.setShortcutOutput(watchText)
    }

    // Si exécuté via Siri / Apple Watch Shortcuts, on termine immédiatement sans affichage modal iOS
    if (isSiriOrShortcut) {
      Script.complete()
      return
    }

    // 6. Construction du widget iOS
    if (selectedFamily === "small") {
      buildSmallWidget(widget, analysis, location, isCached, fetchedAt)
    } else if (selectedFamily === "large") {
      buildLargeWidget(widget, analysis, location, isCached, fetchedAt)
    } else if (selectedFamily?.startsWith("accessory")) {
      buildLockScreenWidget(widget, selectedFamily, analysis, location)
    } else {
      buildMediumWidget(widget, analysis, location, isCached, fetchedAt)
    }

  } catch (err) {
    console.error(err)
    const errMsg = "Impossible de charger les données de pollen."
    Script.setShortcutOutput(errMsg)

    if (isSiriOrShortcut) {
      Script.complete()
      return
    }

    applyClearGlassBackground(widget)
    widget.setPadding(16, 16, 16, 16)

    const errCard = addGlassCard(widget, [12, 12, 12, 12])
    errCard.layoutVertically()

    const head = errCard.addStack()
    head.centerAlignContent()
    addSymbol(head, "wifi.exclamationmark", 14, new Color("#F87171"))
    head.addSpacer(6)
    addText(head, "Connexion requise", Font.boldSystemFont(13), new Color("#F87171"))

    errCard.addSpacer(6)
    addText(errCard, "Activez internet lors de la 1ère ouverture pour enregistrer le cache hors-ligne.", Font.systemFont(11), CONFIG.colors.textSecondary, 3)
  }

  // Présentation uniquement si dans l'application interactive sur iPhone
  if (isInteractiveApp) {
    if (selectedFamily === "small") await widget.presentSmall()
    else if (selectedFamily === "large") await widget.presentLarge()
    else if (selectedFamily?.startsWith("accessory")) await widget.presentAccessoryRectangular()
    else await widget.presentMedium()
  }

  Script.setWidget(widget)
  Script.complete()
}

await main()
