// -- CONFIG --------------------------------------------------

const CONFIG = {
  // Coordonnées par défaut (Paris) utilisées uniquement au tout premier lancement si le GPS échoue
  latitude:  48.8566,
  longitude: 2.3522,
  cityName:  "Recherche...",

  // Seuil d'alerte : une notification est envoyée si l'indice dépasse cette valeur (0 = désactivé)
  alertThreshold: 3,

  colors: {
    white:      "#FFFFFF",
    glass:      new Color("#FFFFFF", 0.25),
    glassDark:  new Color("#000000", 0.15),
    border:     new Color("#FFFFFF", 0.4),
    textShadow: new Color("#000000", 0.25)
  }
}

const fm = FileManager.local()
const cachePath      = fm.joinPath(fm.documentsDirectory(), "pollen_cache.json")
const lastNotifPath  = fm.joinPath(fm.documentsDirectory(), "pollen_last_notif.json")
const locCachePath   = fm.joinPath(fm.documentsDirectory(), "pollen_location.json")

// -- NOTIFICATIONS -------------------------------------------

async function maybeNotify(score, label, cityName) {
  if (CONFIG.alertThreshold <= 0 || score < CONFIG.alertThreshold) return

  const today = new Date().toISOString().split("T")[0]
  if (fm.fileExists(lastNotifPath)) {
    const last = JSON.parse(fm.readString(lastNotifPath))
    if (last.date === today && last.score === score) return
  }

  const n = new Notification()
  n.title = `Alerte Pollen — ${cityName}`
  n.body  = `Indice ${score}/10 (${label}). Pensez à vos antihistaminiques.`
  n.sound = "default"
  await n.schedule()

  fm.writeString(lastNotifPath, JSON.stringify({ date: today, score: score }))
}

// -- LOCALISATION & API & CACHE ------------------------------

async function updateLocation() {
  try {
    // Précision réduite pour économiser la batterie du widget
    Location.setAccuracyToThreeKilometers()
    const loc = await Location.current()
    CONFIG.latitude  = loc.latitude
    CONFIG.longitude = loc.longitude
    
    // Reverse Geocoding pour trouver le nom de la ville
    const geocode = await Location.reverseGeocode(loc.latitude, loc.longitude)
    if (geocode && geocode.length > 0) {
      CONFIG.cityName = geocode[0].locality || geocode[0].city || "Position actuelle"
    } else {
      CONFIG.cityName = "Position actuelle"
    }

    // Sauvegarde de la localisation pour un usage hors-ligne ou en arrière-plan
    fm.writeString(locCachePath, JSON.stringify({
      lat: CONFIG.latitude,
      lon: CONFIG.longitude,
      city: CONFIG.cityName
    }))

  } catch (err) {
    console.log("GPS indisponible en direct, tentative de lecture du cache de localisation...")
    
    // Si le GPS échoue, on récupère la dernière position connue
    if (fm.fileExists(locCachePath)) {
      const cachedLoc = JSON.parse(fm.readString(locCachePath))
      CONFIG.latitude  = cachedLoc.lat
      CONFIG.longitude = cachedLoc.lon
      CONFIG.cityName  = cachedLoc.city
    } else {
      CONFIG.cityName  = "Position inconnue"
    }
  }
}

async function fetchPollenData() {
  const baseUrl    = "https://air-quality-api.open-meteo.com/v1/air-quality"
  const hourlyVars = "alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen"
  
  const params = [
    `latitude=${CONFIG.latitude}`,
    `longitude=${CONFIG.longitude}`,
    `hourly=${hourlyVars}`,
    `timezone=Europe%2FParis`,
    `forecast_days=6`
  ].join("&")

  try {
    const req = new Request(`${baseUrl}?${params}`)
    req.timeoutInterval = 5
    const data = await req.loadJSON()
    
    if (data && !data.error) {
      fm.writeString(cachePath, JSON.stringify(data))
      return { data: data, isCached: false }
    }
  } catch (e) {
    console.log("Erreur réseau, lecture du cache...")
  }

  if (fm.fileExists(cachePath)) {
    return { data: JSON.parse(fm.readString(cachePath)), isCached: true }
  }

  throw new Error("Aucun réseau et aucun cache disponible.")
}

function extractCurrentValues(data) {
  const now   = new Date()
  const pad   = n => String(n).padStart(2, "0")
  const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
  const isoH  = `${today}T${pad(now.getHours())}:00`

  const times = data.hourly?.time ?? []
  let idx = times.indexOf(isoH)
  if (idx < 0) idx = times.findIndex(t => t.startsWith(today))
  if (idx < 0) idx = 0

  const h = data.hourly
  return {
    grass: Math.round(h?.grass_pollen?.[idx]   ?? 0),
    tree:  Math.round((h?.alder_pollen?.[idx]  ?? 0) + (h?.birch_pollen?.[idx] ?? 0) + (h?.olive_pollen?.[idx] ?? 0)),
    weed:  Math.round((h?.mugwort_pollen?.[idx] ?? 0) + (h?.ragweed_pollen?.[idx] ?? 0))
  }
}

function extractForecast(data) {
  const times    = data.hourly?.time ?? []
  const dailyMax = {}

  times.forEach((timeStr, i) => {
    const dateStr = timeStr.split("T")[0]
    if (!dailyMax[dateStr]) dailyMax[dateStr] = { grass: 0, tree: 0, weed: 0 }
    
    const h    = data.hourly
    const tree = (h?.alder_pollen?.[i] ?? 0) + (h?.birch_pollen?.[i] ?? 0) + (h?.olive_pollen?.[i] ?? 0)
    const weed = (h?.mugwort_pollen?.[i] ?? 0) + (h?.ragweed_pollen?.[i] ?? 0)
    
    dailyMax[dateStr].grass = Math.max(dailyMax[dateStr].grass, h?.grass_pollen?.[i] ?? 0)
    dailyMax[dateStr].tree  = Math.max(dailyMax[dateStr].tree,  tree)
    dailyMax[dateStr].weed  = Math.max(dailyMax[dateStr].weed,  weed)
  })

  return Object.keys(dailyMax).sort().slice(0, 5).map(dateStr => ({
    date:  new Date(dateStr),
    total: Math.round(dailyMax[dateStr].grass + dailyMax[dateStr].tree + dailyMax[dateStr].weed)
  }))
}

// -- HELPERS -------------------------------------------------

function getScore(total) {
  if (total === 0)   return 0
  if (total <=  10)  return 1
  if (total <=  20)  return 2
  if (total <=  35)  return 3
  if (total <=  50)  return 4
  if (total <=  75)  return 5
  if (total <= 100)  return 6
  if (total <= 150)  return 7
  if (total <= 200)  return 8
  if (total <= 300)  return 9
  return 10
}

function getLevelColors(total) {
  if (total <=  20) return { label: "Faible",     colors: ["#2ECC71","#27AE60"], iconColor: "#A8E6CF" }
  if (total <=  50) return { label: "Modéré",     colors: ["#F1C40F","#F39C12"], iconColor: "#FFEAA7" }
  if (total <= 100) return { label: "Élevé",      colors: ["#E67E22","#D35400"], iconColor: "#FAB1A0" }
  if (total <= 200) return { label: "Très élevé", colors: ["#E74C3C","#C0392B"], iconColor: "#FF7675" }
  return                   { label: "Extrême",    colors: ["#9B59B6","#8E44AD"], iconColor: "#D6A2E8" }
}

function getDominantAdvice(current) {
  const entries = [
    { name: "graminées", val: current.grass },
    { name: "arbres",    val: current.tree  },
    { name: "herbacés",  val: current.weed  }
  ]
  const dominant = entries.reduce((a, b) => b.val > a.val ? b : a)
  if (dominant.val === 0) return "Aucun allergène détecté aujourd'hui."
  
  const advice = {
    "graminées": "Évitez les parcs et zones herbeuses.",
    "arbres":    "Attention aux forêts et jardins arborés.",
    "herbacés":  "Limitez les sorties en campagne."
  }
  
  return `Dominant : ${dominant.name}. ${advice[dominant.name] ?? "Restez prudent."}`
}

function applyBackground(w, total) {
  const lv = getLevelColors(total)
  const gradient = new LinearGradient()
  gradient.locations = [0.0, 1.0]
  gradient.colors = [new Color(lv.colors[0]), new Color(lv.colors[1])]
  w.backgroundGradient = gradient
  return lv
}

function addGlassStack(parent) {
  const stack = parent.addStack()
  stack.backgroundColor = CONFIG.colors.glass
  stack.cornerRadius    = 14
  stack.borderColor     = CONFIG.colors.border
  stack.borderWidth     = 1
  return stack
}

function getAdvice(total) {
  if (total <=  20) return "Conditions idéales"
  if (total <=  50) return "Personnes sensibles : attention"
  if (total <= 100) return "Antihistaminiques recommandés"
  if (total <= 200) return "Limitez les sorties prolongées"
  return                   "Restez à l'intérieur si possible"
}

function shortDay(date, index) {
  if (index === 0) return "Auj."
  if (index === 1) return "Dem."
  return ["Dim","Lun","Mar","Mer","Jeu","Ven","Sam"][date.getDay()]
}

function font(size, weight = "regular") {
  const map = { regular: Font.systemFont, bold: Font.boldSystemFont, heavy: Font.heavySystemFont }
  return (map[weight] ?? Font.systemFont)(size)
}

function addText(container, text, txtFont, lineLimit = 0, opacity = 1) {
  const t = container.addText(text)
  t.font        = txtFont
  t.textColor   = new Color(CONFIG.colors.white, opacity)
  t.shadowColor = CONFIG.colors.textShadow
  t.shadowRadius = 3
  t.shadowOffset = new Point(0, 1)
  if (lineLimit > 0) t.lineLimit = lineLimit
  return t
}

function addSymbol(container, symbolName, size, opacity = 1, customColor = null) {
  const sym = SFSymbol.named(symbolName)
  sym.applyFont(Font.systemFont(size))
  const img = container.addImage(sym.image)
  img.imageSize  = new Size(size, size)
  img.tintColor  = customColor ? new Color(customColor, opacity) : new Color(CONFIG.colors.white, opacity)
  return img
}

// -- WIDGET BUILDERS -----------------------------------------

function buildSmallWidget(current, forecast, w, isCached) {
  const total = current.grass + current.tree + current.weed
  const score = getScore(total)
  const lv    = applyBackground(w, total)
  w.setPadding(14, 14, 14, 14)

  const header = w.addStack()
  header.layoutHorizontally()
  header.centerAlignContent()
  addSymbol(header, "location.fill", 12, 0.9)
  header.addSpacer(4)
  addText(header, CONFIG.cityName, font(12, "bold"), 0, 0.9)
  header.addSpacer()
  if (isCached) addSymbol(header, "wifi.slash", 10, 0.6)

  w.addSpacer(8)

  const scoreStack = w.addStack()
  scoreStack.layoutHorizontally()
  scoreStack.bottomAlignContent()
  addText(scoreStack, String(score), font(42, "heavy"))
  scoreStack.addSpacer(2)
  addText(scoreStack, "/10", font(14, "bold"), 0, 0.7)

  const statusRow = w.addStack()
  statusRow.layoutHorizontally()
  statusRow.centerAlignContent()
  addSymbol(statusRow, "circle.fill", 10, 1, lv.iconColor)
  statusRow.addSpacer(4)
  addText(statusRow, lv.label, font(14, "bold"))

  w.addSpacer()

  const adviceStack = addGlassStack(w)
  adviceStack.setPadding(6, 8, 6, 8)
  addText(adviceStack, getAdvice(total), font(10, "bold"), 2)
}

function buildMediumWidget(current, forecast, w, isCached) {
  const total = current.grass + current.tree + current.weed
  const score = getScore(total)
  const lv    = applyBackground(w, total)
  w.setPadding(14, 16, 14, 16)

  const row = w.addStack()
  row.layoutHorizontally()
  row.centerAlignContent()

  const left = row.addStack()
  left.layoutVertically()
  left.size = new Size(120, 0)

  const topRow = left.addStack()
  topRow.layoutHorizontally()
  topRow.centerAlignContent()
  addSymbol(topRow, "location.fill", 12, 0.9)
  topRow.addSpacer(4)
  addText(topRow, CONFIG.cityName, font(13, "bold"), 0, 0.9)
  if (isCached) { topRow.addSpacer(4); addSymbol(topRow, "wifi.slash", 10, 0.6) }

  left.addSpacer(8)

  const scoreStack = left.addStack()
  scoreStack.layoutHorizontally()
  scoreStack.bottomAlignContent()
  addText(scoreStack, String(score), font(46, "heavy"))
  scoreStack.addSpacer(2)
  addText(scoreStack, "/10", font(16, "bold"), 0, 0.7)

  const statusRow = left.addStack()
  statusRow.layoutHorizontally()
  statusRow.centerAlignContent()
  addSymbol(statusRow, "circle.fill", 10, 1, lv.iconColor)
  statusRow.addSpacer(4)
  addText(statusRow, lv.label, font(14, "bold"))

  left.addSpacer()
  addText(left, getDominantAdvice(current), font(10, "bold"), 2, 0.9)

  row.addSpacer(12)

  const rightWrapper = addGlassStack(row)
  rightWrapper.setPadding(12, 12, 12, 12)
  rightWrapper.layoutVertically()

  const types = [
    { name: "Graminées", val: current.grass, icon: "leaf.fill"    },
    { name: "Arbres",    val: current.tree,  icon: "tree.fill"    },
    { name: "Herbacés",  val: current.weed,  icon: "camera.macro" }
  ]

  for (const [i, type] of types.entries()) {
    if (i > 0) rightWrapper.addSpacer(8)
    const typeRow = rightWrapper.addStack()
    typeRow.layoutHorizontally()
    typeRow.centerAlignContent()
    addSymbol(typeRow, type.icon, 14)
    typeRow.addSpacer(6)
    addText(typeRow, type.name, font(12, "bold"))
    typeRow.addSpacer()
    addText(typeRow, String(type.val), font(14, "heavy"))
  }
}

function buildLargeWidget(current, forecast, w, isCached) {
  const total = current.grass + current.tree + current.weed
  const score = getScore(total)
  const lv    = applyBackground(w, total)
  w.setPadding(16, 16, 16, 16)

  const header = w.addStack()
  header.layoutHorizontally()
  header.centerAlignContent()
  addSymbol(header, "aqi.medium", 18)
  header.addSpacer(6)
  addText(header, "Pollen", font(18, "heavy"))
  header.addSpacer()
  if (isCached) { addSymbol(header, "wifi.slash", 14, 0.6); header.addSpacer(6) }
  
  const locCard = addGlassStack(header)
  locCard.layoutHorizontally()
  locCard.centerAlignContent()
  locCard.setPadding(4, 8, 4, 8)
  addSymbol(locCard, "location.fill", 10)
  locCard.addSpacer(4)
  addText(locCard, CONFIG.cityName, font(12, "bold"))

  w.addSpacer(12)

  const mainCard = addGlassStack(w)
  mainCard.layoutHorizontally()
  mainCard.centerAlignContent()
  mainCard.setPadding(16, 16, 16, 16)

  const mainLeft = mainCard.addStack()
  mainLeft.layoutVertically()

  const scoreStack = mainLeft.addStack()
  scoreStack.layoutHorizontally()
  scoreStack.bottomAlignContent()
  addText(scoreStack, String(score), font(54, "heavy"))
  scoreStack.addSpacer(4)
  addText(scoreStack, "/10", font(20, "bold"), 0, 0.7)

  const statusRow = mainLeft.addStack()
  statusRow.layoutHorizontally()
  statusRow.centerAlignContent()
  addSymbol(statusRow, "circle.fill", 12, 1, lv.iconColor)
  statusRow.addSpacer(6)
  addText(statusRow, lv.label, font(16, "bold"))

  mainLeft.addSpacer(6)
  addText(mainLeft, getDominantAdvice(current), font(12, "bold"), 3, 0.9)

  mainCard.addSpacer()
  w.addSpacer(12)

  addText(w, "DÉTAIL (grains)", font(11, "heavy"), 0, 0.8)
  w.addSpacer(8)

  const detailsCard = addGlassStack(w)
  detailsCard.setPadding(12, 16, 12, 16)
  detailsCard.layoutHorizontally()

  const types = [
    { name: "Graminées", icon: "leaf.fill",    val: current.grass },
    { name: "Arbres",    icon: "tree.fill",    val: current.tree  },
    { name: "Herbacés",  icon: "camera.macro", val: current.weed  }
  ]

  for (const [i, type] of types.entries()) {
    if (i > 0) detailsCard.addSpacer()
    const col = detailsCard.addStack()
    col.layoutVertically()
    col.centerAlignContent()
    addSymbol(col, type.icon, 20)
    col.addSpacer(6)
    addText(col, String(type.val), font(16, "heavy"))
    col.addSpacer(2)
    addText(col, type.name, font(10, "bold"), 0, 0.8)
  }

  w.addSpacer(14)

  addText(w, "PRÉVISIONS 5 JOURS", font(11, "heavy"), 0, 0.8)
  w.addSpacer(8)

  const fcRow = w.addStack()
  fcRow.layoutHorizontally()

  for (const [i, day] of forecast.entries()) {
    if (i > 0) fcRow.addSpacer()
    const dayCol = addGlassStack(fcRow)
    dayCol.layoutVertically()
    dayCol.centerAlignContent()
    dayCol.setPadding(8, 8, 8, 8)
    if (i > 0) dayCol.backgroundColor = CONFIG.colors.glassDark
    addText(dayCol, shortDay(day.date, i), font(12, i === 0 ? "heavy" : "bold"), 0, i === 0 ? 1 : 0.8)
    dayCol.addSpacer(6)
    addText(dayCol, String(getScore(day.total)), font(14, "heavy"))
  }
}

// -- MAIN ----------------------------------------------------

async function main() {
  const widget = new ListWidget()
  widget.refreshAfterDate = new Date(Date.now() + 60 * 60 * 1000)

  try {
    if (!config.runningInWidget) {
      await Notification.removeAllPending() 
    }

    await updateLocation()
    const { data, isCached } = await fetchPollenData()
    const current  = extractCurrentValues(data)
    const forecast = extractForecast(data)
    const family   = config.widgetFamily ?? "medium"

    const total = current.grass + current.tree + current.weed
    const score = getScore(total)
    const lv    = getLevelColors(total)

    await maybeNotify(score, lv.label, CONFIG.cityName)

    const watchText = `${CONFIG.cityName} - Pollen ${score}/10 (${lv.label})\nGraminées : ${current.grass} | Arbres : ${current.tree} | Herbacés : ${current.weed}`
    Script.setShortcutOutput(watchText)

    if      (family === "small") buildSmallWidget(current, forecast, widget, isCached)
    else if (family === "large") buildLargeWidget(current, forecast, widget, isCached)
    else                         buildMediumWidget(current, forecast, widget, isCached)

  } catch (err) {
    widget.backgroundColor = new Color("#1A1A24")
    widget.setPadding(16, 16, 16, 16)
    addSymbol(widget, "exclamationmark.triangle.fill", 20, 1, "#FF453A")
    widget.addSpacer(8)
    addText(widget, "Erreur réseau", font(14, "bold"))
    widget.addSpacer(4)
    addText(widget, "Ouvrez l'app avec du réseau pour activer le mode hors-ligne.", font(11, "regular"), 4, 0.7)
  }

  if (!config.runningInWidget) await widget.presentMedium()
  Script.setWidget(widget)
  Script.complete()
}

await main()