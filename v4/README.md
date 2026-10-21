# Funkwerk Montage-Recorder V4

Digitale Montageanleitungen am Handy oder PC erfassen und als PowerPoint exportieren.

- Mehrere Anleitungen speichern, fortsetzen, duplizieren (z. B. für neue Variante)
- Pro Schritt: Material (mit Barcode-Scanner), Anweisung (mit Diktat), Werkzeug/Drehmoment, Verkabelung, Hinweis, Scanschritt, Fotos
- Fotos markieren (Pfeil, Kreis, Rahmen, Nummern, Stift)
- Live-Folienvorschau mit Warnung, wenn etwas nicht auf die Folie passt
- Export: PowerPoint (gleiches Folienlayout wie V3), Stückliste (CSV/Druck), JSON für PC-Konverter, Sicherung
- Läuft offline als App (zum Home-Bildschirm hinzufügen); Daten bleiben lokal im Browser
- Übernimmt eine laufende Aufnahme aus V3 auf Knopfdruck

Struktur: `js/layout.js` berechnet die Folien (Vorschau und Export nutzen dieselbe Berechnung), `js/export.js` erzeugt die Dateien, `js/app.js` ist die Oberfläche.
