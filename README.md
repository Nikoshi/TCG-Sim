# RESTNETZ · Öffentliche Teststation

Dieses Repository ist ausschließlich für die **statischen Veröffentlichungsdateien**
des RESTNETZ-Regelsimulators und später des interaktiven Tutorials vorgesehen.

- **Entwicklungsrepository:** `Nikoshi/TCG` bleibt privat. Keine automatische Spiegelung seiner Historie.
- **Regelstand:** experimentell, 0.2. Dies ist **kein fertiges Spiel**.
- **Zugang:** Der Regelsimulator benötigt einen kurzlebigen Code aus dem privaten CI-Workflow.
  Die Website-Dateien selbst sind auf GitHub Pages öffentlich einsehbar und herunterladbar.
- **Freigabe:** Erst nach bestandenen Rust-/WASM-/Chromium-Tests und manueller Übernahme
  eines ausgewählten CI-Builds. Keine Zugangscodes, Passwörter, privaten Quellen,
  Reports oder Tokens in diesem Repository speichern.

## Geplante URLs

- `/TCG-Sim/`: Einstieg
- `/TCG-Sim/simulator/web/`: Rust/WASM-Regelsimulator
- `/TCG-Sim/tutorial/`: geführter Lernpfad (nach separater Abnahme)

## Veröffentlichung

Der Build entsteht im privaten Repository und wird dort getestet. Das bereinigte
Website-Paket wird anschließend in dieses öffentliche Repository übernommen.
Ein neuer Playtest-Code muss immer mit dem zugehörigen aktuellen WASM-Build
veröffentlicht werden. Die Codes gelten maximal 30 Minuten ab Erstellung.

**GitHub Pages ist nicht automatisch durch dieses README aktiviert.**
