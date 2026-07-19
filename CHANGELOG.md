# Changelog

Toutes les modifications notables d’AvityOS sont documentées dans ce fichier.

Le format s’inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Le dépôt porte aujourd’hui la version `0.1.0` dans `package.json` ; une
politique de release complète (tags, publication automatisée, calendrier) n’est
pas encore formalisée. Les entrées futures pourront suivre un versionnement
sémantique lorsque le processus de release sera établi.

## [Unreleased]

### Added

- Clarifications IA structurées et versionnées (`CLARIFICATION_SCHEMA_VERSION=1`)
  avec types de réponse fermés, groupe unique par tour, provenance provider /
  modèle, persistance SQLite et reprise exacte du pipeline cerveau.
- Politique déterministe de validation des propositions (secrets, hors périmètre,
  commandes, redondance) et borne des tours de clarification.
- API REST/SSE pour lister / répondre aux clarifications et pour pause /
  reprise projet atomiques (`project.paused`, `project.resumed`,
  `clarification.obsolete`, `run.fenced`).
- CLI `avity clarification list|show|answer` et `avity project pause|resume`.
- Panneau Web de clarification groupée et boutons pause/reprise branchés sur
  l’état durable du control plane.
- Migration SQLite v6 (`project_pauses`, métadonnées de clarification,
  `missions.paused_from_state`).

### Changed

- Les analyses ambiguës du cerveau déclenchent une étape `clarification` via
  `ProviderAdapter` au lieu d’un blocage générique ou d’une heuristique présentée
  comme clarification IA.
- Les machines d’état projet/mission couvrent explicitement pause/reprise et
  les états de clarification.

### Fixed

- Lecture des remotes Git via `git config --get remote.*.url` pour éviter de
  persister des URL HTTPS réécrites avec credentials (`url.*.insteadOf`).
- Les opérations Git automatisées (`@avityos/git`) isolent les commits de
  fixtures de `commit.gpgsign` / `fsmonitor` hérités de l’environnement hôte,
  qui pouvaient faire timeout les suites control-plane sous charge.

### Security

- Les propositions de clarification refusent secrets, clés API, mots de passe,
  chemins hors dépôt et commandes arbitraires.
- Pause atomique : annulation des runs, révocation des leases et refus des
  résultats tardifs fenced.

## [0.1.0] - 2026-07-17

Fondations initiales du monorepo AvityOS, datées du commit de plateforme
`f1b0e9b` (2026-07-17) et alignées sur la version `0.1.0` déclarée dans
`package.json`. Aucun tag Git `v0.1.0` n’existe à ce stade ; aucun lien de
comparaison de tags n’est donc fourni.

### Added

- Structure monorepo pnpm (`apps/*`, `services/*`, `packages/*`) avec Node
  ≥ 22.5 et pnpm 11.
- Première fondation du control plane local (Fastify + SQLite via
  `node:sqlite`, migrations transactionnelles, journal d’événements).
- Worker d’exécution pour sessions terminal / sous-processus, avec matching
  de capacités, leases et politique HTTPS hors loopback.
- Contrats partagés zod dans `packages/contracts` (modèle de domaine, API,
  événements) comme référence des échanges.
- Moteur d’orchestration déterministe et moteur de politique (allowlists,
  redaction, confinement OS des checks).
- Adaptateurs de providers avec tests locaux et mocks (provider fake
  déterministe ; adaptateurs CLI de coding et APIs HTTP selon configuration).
- Interface web initiale (React/Vite) pour superviser projets et exécutions,
  avec états Live / Hors ligne / Démo explicite.
- CLI `avity` pour le pilotage headless du cycle objectif → livraison.
- Application macOS SwiftUI en version de développement (Keychain, SSE,
  vues projets/missions/runs).
- Suite de tests TypeScript (Vitest), E2E Playwright web, tests Swift, et
  workflow CI (build, tests, typecheck, audit, licences, Gitleaks, SBOM).
- Documentation d’architecture, de sécurité, de cycle de vie, de
  développement local, de déploiement et ADR associés.

### Security

- Données et orchestration local-first par défaut (écoute loopback).
- Authentification API par token bearer et cookie de session HttpOnly
  (SameSite=Strict) pour le navigateur.
- Validation des entrées via schémas partagés ; résolution serveur des
  chemins de travail (rejet des échappements symlink).
- Redaction des secrets dans logs / événements / détails d’audit ; chaîne
  d’audit SHA-256.
- Confinement des processus de checks (`sandbox-exec` sur macOS, Bubblewrap
  sur Linux lorsque disponible).
- Audits de dépendances, inventaire de licences et scan de secrets en CI.

### Known limitations

- Certains écrans ou contrôles web dérivés du prototype Figma restent
  partiellement connectés au backend.
- Certaines métriques ou coûts providers restent synthétiques / à zéro tant
  qu’aucune tarification n’est configurée.
- Packaging signé et notarié de l’application macOS non finalisé.
- Tests live des providers dépendants de credentials non inclus dans la CI
  standard.
- Preuve complète de création autonome de PR GitHub externe encore limitée
  (implémentation présente ; validation live avec dépôt / credentials
  externes encore partielle).
