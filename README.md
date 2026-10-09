# Turni Infermieri v2 — Pronto Soccorso

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

Applicazione web per la **generazione automatica dei turni infermieristici** in Pronto Soccorso.
Nessun server, nessuna installazione: basta aprire `index.html` nel browser.

Evoluzione di [Turni-infermieri](https://github.com/akerbabber/Turni-infermieri) con interfaccia
e algoritmo potenziati; il deploy di riferimento è su **Vercel** (con telemetria anonima del
solver nei log runtime via `/api/log`).

---

## Funzionalita

- **Wizard a 5 step** — Organico → Regole → Continuità → Genera → Risultati
- **Motore di scheduling** — **Generatore a matrici** (default di Auto): ogni riga è costruita con programmazione dinamica esatta sulla matrice del profilo (riposi solo dopo lo smonto, D-N-S-R-R, 5+2) con ore e notti come vincoli, poi le righe vengono coordinate sulle coperture. Opzione "Consenti una doppia notte al mese" (N-N-S-R-R, una volta al mese per turnista) per coprire più notti con lo stesso organico. Restano disponibili Pattern Beam ed euristica greedy + simulated annealing per confronto
- **Matrici rigide** — M/P 5 lavoro + 2 riposi adiacenti (fasi coordinate di gruppo), D-N-S-R-R
- **Prepara mese successivo** — la griglia generata diventa automaticamente continuità, riporto ore ed equità del mese dopo
- **Equità di lungo periodo** — notti e festivi lavorati si bilanciano tra un mese e l'altro
- **Desiderate** — turni/riposi richiesti in anticipo, garantiti dal solver e salvati anche nel CSV di configurazione
- **Modifica interattiva** — click su una cella per cambiare turno; la griglia viene rivalidata con TUTTI i vincoli nel worker
- **Violazioni leggibili** — nomi reali, spiegazione della regola violata, click per evidenziare la cella
- **Soluzioni multiple** — tabella di confronto (violazioni, punteggio, equità ore, notti)
- **Export** — CSV, JSON configurazione, stampa ottimizzata per A4 landscape
- **Dark mode** — tema chiaro/scuro con toggle
- **Persistenza locale** — tutto il lavoro e salvato in `localStorage`
- **100% offline** — funziona anche senza connessione (Tailwind CSS ha fallback)

## Quick Start

```bash
# Just open in browser — no install needed
open index.html

# Or serve locally
npx http-server -p 8080 -c-1
# or
python3 -m http.server 8080
```

## Development Setup

```bash
# Install dev dependencies (linting, formatting, testing)
npm install

# Run all checks
npm run validate

# Individual commands
npm test              # Run solver unit tests
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
npm run format        # Prettier format
npm run format:check  # Prettier check
npm run benchmark:accuracy # Compare heuristic vs Pattern Beam accuracy
npm run serve         # Local dev server on port 8080
```

## Project Structure

```
index.html                  Single-page UI: 4-step wizard
js/
  app.js                    Main application logic: state, rendering, events
  solver.js                 Web Worker entry point (loads modules via importScripts)
  solver/
    constants.js            Shift data, weights, utility functions
    context.js              Preprocessing: buildContext, getAbsenceShift
    scoring.js              Constraints, scoring, violations, stats
    construct.js            Greedy construction heuristic (8 phases)
    local-search.js         Simulated annealing + move functions
    pattern-planner.js       Pattern Beam and night-first cyclic profile planners
    matrix-solver.js        Generatore a matrici: exact row DP + coverage coordination
    solvers.js              Solve orchestration (auto = matrix generator)
css/
  custom.css                Styles with CSS variables for light/dark themes
test/
  solver.test.js            Unit tests for solver pure functions
.github/
  workflows/
    ci.yml                  CI pipeline: lint + format + test
    deploy.yml              GitHub Pages deployment
  copilot-instructions.md   AI assistant guidelines
CLAUDE.md                   Agent development guide
```

No framework, no bundler, no build step. Runtime dependencies load from CDN with offline fallbacks.
The solver modules share scope via `importScripts()` — no module system needed.

## Shift Codes

| Code | Name                   | Hours |
|------|------------------------|-------|
| M    | Mattina (Morning)      | 6.2   |
| P    | Pomeriggio (Afternoon) | 6.2   |
| D    | Diurno (Day-long)      | 12.2  |
| N    | Notte (Night)          | 12.2  |
| S    | Smonto (Post-night)    | 0     |
| R    | Riposo (Rest)          | 0     |
| F    | Ferie (Holiday)        | 6.12  |
| MA   | Malattia (Sick)        | 6.12  |
| L104 | Legge 104              | 6.12  |
| PR   | Permesso Retribuito    | 6.12  |
| MT   | Maternita              | 6.12  |

## Scheduling Engine

The solver runs in a **Web Worker**:

1. **Generatore a matrici** (default, `auto`/`matrix`) — every nurse row is the exact optimum of a dynamic program over the GRAMMAR of the nurse's matrix (M/P/N: `W^k-N-S-R(-R)` with rests only after the smonto and at most `maxRPerWeek` per week; D/N: `D-N-S-R-R` + one doppio D; weekday M/P 5+2), with monthly hours and nights as DP resources. Rows are coordinated by block coordinate descent on convex coverage costs plus ruin-and-recreate kicks. Rest islands and broken matrices are impossible by construction; nobody goes under the monte ore unless the matrix makes it arithmetically impossible.

2. **Night-first Pattern Beam** (optional) — Pattern Beam variant that commits night-capable rows before non-night rows so N coverage has priority.

3. **Pattern Beam** (optional) — Profile-aware cyclic planner that selects whole-month nurse rows with beam search and shared repair passes.

4. **Greedy + Simulated Annealing** (fallback) — Multi-restart construction heuristic with local search. Always available, works offline.

### Hard Constraints
- Daily coverage min/max per shift type (M, P, D, N)
- Forbidden transitions (P->M, N must be followed by S->R->R)
- 11-hour minimum gap between consecutive shifts
- Weekly rest minimums (2+ real rest days per week)
- Night shift caps per nurse (soft + hard limits)

### Soft Objectives
- Hour equity across nurses (minimax fairness)
- Night shift distribution fairness
- D-shift (12h) equity among eligible nurses
- M/P balance for restricted nurses

## Tech Requirements

- Any modern browser with ES6+, Web Workers, and localStorage
- No server needed — open the HTML file directly
- Internet optional (CDN resources have local fallbacks)
- WebAssembly support recommended (for MILP solvers; heuristic fallback always works)

## CI/CD

- **Pull requests**: Automated linting, format checking, and unit tests via GitHub Actions
- **Main branch pushes**: Automatic deployment to GitHub Pages (only when runtime files change)

## License

This project is distributed as free software.
