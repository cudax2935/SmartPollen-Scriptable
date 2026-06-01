# SmartPollen-Scriptable

Un widget iOS élégant, codé en JavaScript pour l'application Scriptable, qui affiche en temps réel la concentration de pollen dans l'air.

## ✨ Fonctionnalités
* **Indice sur 10 :** Conversion des données scientifiques (grains/m³) en un score visuel et intuitif.
* **Localisation dynamique :** Suivi GPS avec reverse-geocoding (affiche le nom de votre ville actuelle).
* **Mode Hors-Ligne :** Mise en cache automatique des dernières données pour éviter les erreurs de chargement en l'absence de réseau.
* **Design Natif :** Utilise les SF Symbols officiels d'Apple et s'adapte aux trois tailles de widgets (Small, Medium, Large).

## ⚙️ Installation

1. Téléchargez l'application [Scriptable](https://scriptable.app/) sur l'App Store.
2. Ouvrez l'application et créez un nouveau script en appuyant sur le bouton **`+`**.
3. Copiez l'intégralité du code de `widget-pollen.js` et collez-le.
4. Appuyez sur le bouton **Play (▶️)** au moins une fois pour autoriser la localisation et les notifications.
5. Sur votre écran d'accueil iOS, ajoutez un widget Scriptable, modifiez-le et sélectionnez votre nouveau script.

## 📡 Source des données
Les données aérobiologiques proviennent de l'API gratuite et open-source d'[Open-Meteo](https://open-meteo.com/).
